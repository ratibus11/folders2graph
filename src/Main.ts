import {
	Plugin,
	WorkspaceLeaf,
} from "obsidian";

import { GraphLeafWithCustomRenderer } from "interfaces/GraphLeafWithCustomRenderer";
import { LeafRenderer } from "interfaces/LeafRenderer";

import { getI18n } from "i18n";
import { Nullable } from "types/Nullable";
import { Settings } from "interfaces/Settings";
import { SettingsTab } from "SettingsTab";

import { StructuralHierarchy } from "graph/StructuralHierarchy";
import { FoldingManager } from "graph/FoldingManager";
import { GraphDataInjector } from "graph/GraphDataInjector";
import { NodePrototypePatcher } from "graph/NodePrototypePatcher";
import { GraphInteractions } from "graph/GraphInteractions";

export default class Folders2GraphPlugin extends Plugin {
	public override settings: Settings = {
		showFolderNodes: true,
		hideRootNode: false,
		nodeColor: "#5c8af5",
		showHeadingNodes: false,
		headingNodeColor: "#f5a55c",
		hiddenNodes: {},
	};

	/** Serialised save queue — every saveData call is chained so concurrent saves never
	 * race. Always append to this promise; never await it directly. */
	private __savePromise: Promise<void> = Promise.resolve();

	private __hierarchy!: StructuralHierarchy;
	private __foldingManager!: FoldingManager;
	private __injector!: GraphDataInjector;
	private __patcher!: NodePrototypePatcher;
	private __interactions!: GraphInteractions;

	/**
	 * Triggered when the plugin is loaded.
	 */
	public override async onload(): Promise<void> {
		// Load settings tab.
		await this.__loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

		// Wire up graph subsystems.
		this.__hierarchy = new StructuralHierarchy(this.settings);

		this.__foldingManager = new FoldingManager(
			this.app,
			this.settings,
			this.__hierarchy,
			() => this.saveSettings(),
			() => this.refreshGraphLeaves(),
		);

		this.__injector = new GraphDataInjector(
			this.app,
			this.settings,
			this.__hierarchy,
			this.__foldingManager,
			() => this.saveSettings(),
		);

		this.__interactions = new GraphInteractions(
			this.app,
			() => this.__injector.getFolderNodeIds(),
			() => this.__injector.getAllNodeIds(),
			(nodeId) => this.__foldingManager.handleFoldToggle(nodeId),
		);

		this.__patcher = new NodePrototypePatcher(
			this.settings,
			this.__hierarchy,
			(nodeId) => this.__foldingManager.handleRecursiveUnfold(nodeId),
			() => this.__interactions.getSuppressNextContextMenu(),
			(value) => this.__interactions.setSuppressNextContextMenu(value),
		);

		// Register commands so the user can bind hotkeys to toggle each node type. `Mod`
		// resolves to Ctrl on Windows/Linux and Cmd on macOS, matching Obsidian's
		// cross-platform convention. Default bindings: Mod+Shift+G for folders, Mod+Shift+H
		// for headings.
		this.addCommand({
			id: "toggle-folder-nodes",
			name: getI18n().commands.toggleFolderNodes.name,
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "G" }],
			callback: async () => {
				this.settings.showFolderNodes = !this.settings.showFolderNodes;
				await this.saveSettings();
				this.refreshGraphLeaves();
			},
		});

		this.addCommand({
			id: "toggle-heading-nodes",
			name: getI18n().commands.toggleHeadingNodes.name,
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
			callback: async () => {
				this.settings.showHeadingNodes = !this.settings.showHeadingNodes;
				await this.saveSettings();
				this.refreshGraphLeaves();
			},
		});

		// Safety-net command that clears all collapsed state at once. No default hotkey so
		// the user must bind one deliberately, avoiding accidental triggering.
		this.addCommand({
			id: "unfold-all-nodes",
			name: getI18n().commands.unfoldAllNodes.name,
			callback: async () => {
				this.settings.hiddenNodes = {};
				await this.saveSettings();
				this.refreshGraphLeaves();
			},
		});

		// Intercept folder node clicks to reveal them in the file explorer.
		this.__interactions.wrapOpenLinkText();

		// Track Shift key state globally so we can detect Shift+click in openLinkText.
		this.__interactions.registerKeyListeners();

		// When a leaf changes, refresh all graph leaves.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf: Nullable<WorkspaceLeaf>) => {
				this.refreshGraphLeaves([leaf as GraphLeafWithCustomRenderer]);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshGraphLeaves();
			}),
		);

		// Iterates through all tabs which are of type "graph".
		this.refreshGraphLeaves();
	}

	/**
	 * Triggered when the plugin is unloaded.
	 */
	public override onunload(): void {
		this.__interactions.unwrapOpenLinkText();

		// Remove Shift tracking listeners.
		this.__interactions.unregisterKeyListeners();

		// Abort DOM contextmenu suppression listeners.
		this.__interactions.abortAllContextMenuSuppressors();

		this.__getLeavesOfTypeGraph().forEach((leaf) => {
			// A `graph`-typed leaf can exist without a mounted renderer (e.g. the view never
			// finished initializing, or was destroyed before unload). Skip those to avoid
			// crashing the whole unload, which would leave other leaves un-restored.
			const renderer = leaf.view.renderer;
			if (!renderer) return;

			// Restablish the original data setter in the render, then delete the custom one, then reload the leaf.
			if (renderer.originalSetData) {
				renderer.setData = renderer.originalSetData;
				delete renderer.originalSetData;
			}

			this.__patcher.unpatch(renderer);

			leaf.view.unload();
			leaf.view.load();
			renderer.changed();
		});
	}

	/**
	 * Refreshes the provided graph leaves.
	 * @param leaves The leaves to refresh. If not provided, all graph leaves will be refreshed.
	 * @note If a leaf is not a graph, it will be ignored.
	 */
	public refreshGraphLeaves(leaves: GraphLeafWithCustomRenderer[] = this.__getLeavesOfTypeGraph()): void {
		leaves.forEach((leaf) => {
			// Only graph leaves with a mounted renderer should be touched. Running
			// `view.unload(); view.load()` on a non-graph leaf (e.g. the file explorer that
			// just became active via `active-leaf-change`) rebinds its internal listeners,
			// duplicating its context menu handler — that's the "stacked modals" bug.
			if (!this.__isReadyGraphLeaf(leaf)) return;
			this.__injectDataInLeaf(leaf);
			leaf.view.unload();
			leaf.view.load();
			// Install the contextmenu suppressor AFTER unload/load — the reload may rebuild
			// the view's DOM, which would orphan a listener installed before it.
			this.__interactions.installContextMenuSuppressor(leaf);
			leaf.view.renderer.changed();
		});
	}

	/**
	 * A graph leaf is considered ready when its view type is `graph` AND its renderer has
	 * been mounted. The renderer can briefly be undefined when the `active-leaf-change`
	 * event fires before the graph view finishes initializing, so this guard prevents the
	 * downstream code from crashing on `renderer.*`.
	 */
	private __isReadyGraphLeaf(leaf: Nullable<GraphLeafWithCustomRenderer>): leaf is GraphLeafWithCustomRenderer {
		return !!leaf && !!leaf.view && leaf.view.getViewType() === "graph" && !!leaf.view.renderer;
	}

	/**
	 * Installs the custom `setData` override on the renderer of the given leaf.
	 * @param leaf The graph leaf to inject data into.
	 */
	private __injectDataInLeaf(leaf: GraphLeafWithCustomRenderer): void {
		const renderer = leaf.view.renderer;
		this.__injector.install(renderer, (r: LeafRenderer) => this.__patcher.patch(r));
	}

	/**
	 * Get all leaves of type "graph".
	 * @returns The leaves of type "graph".
	 */
	private __getLeavesOfTypeGraph(): GraphLeafWithCustomRenderer[] {
		return this.app.workspace.getLeavesOfType("graph") as GraphLeafWithCustomRenderer[];
	}

	/**
	 * Refresh settings and apply them to `this.settings`.
	 */
	private async __loadSettings() {
		this.settings = Object.assign({}, this.settings, await this.loadData());
	}

	/**
	 * Call the Obsidian API to save the settings. All calls are serialised through
	 * `__savePromise` so concurrent invocations never race each other.
	 */
	public saveSettings(): Promise<void> {
		this.__savePromise = this.__savePromise
			.then(() => this.saveData(this.settings))
			.catch((err: unknown) => {
				console.error("folders2graph: failed to save settings", err);
			});
		return this.__savePromise;
	}
}
