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

/**
 * Entry point for the Folders 2 Graph Obsidian plugin.
 *
 * @remarks
 * This class owns the plugin lifecycle (`onload` / `onunload`) and orchestrates
 * the five graph subsystems:
 *
 * - {@link StructuralHierarchy} — pure parent/child state for fold queries.
 * - {@link FoldingManager} — fold/unfold operations and stale-entry purge.
 * - {@link GraphDataInjector} — custom `setData` override that injects virtual
 *   nodes and filters hidden ones.
 * - {@link NodePrototypePatcher} — prototype patch for colours, labels, and the
 *   PIXI half-disc rendering.
 * - {@link GraphInteractions} — Shift key tracking, `openLinkText` wrapper, and
 *   per-leaf DOM context-menu suppressor.
 *
 * The public API consumed by `SettingsTab` is intentionally minimal:
 * `plugin.settings` (read), `plugin.saveSettings()` (persist), and
 * `plugin.refreshGraphLeaves()` (re-render).
 */
export default class Folders2GraphPlugin extends Plugin {
	/**
	 * Plugin settings. Initialised with defaults; overwritten by
	 * `__loadSettings` during `onload`.
	 */
	public override settings: Settings = {
		showFolderNodes: true,
		hideRootNode: false,
		nodeColor: "#5c8af5",
		showHeadingNodes: false,
		headingNodeColor: "#f5a55c",
		hiddenNodes: {},
		weightNodesBySubtree: false,
		folderFilterMode: "exclude",
		folderFilterList: [],
		folderFilterHideFiles: false,
	};

	/** Serialised save queue — every `saveData` call is chained so concurrent
	 * saves never race each other. Always append to this promise; never await
	 * it directly from outside `saveSettings`. */
	private __savePromise: Promise<void> = Promise.resolve();

	/**
	 * Debounce timer for vault-event-driven graph refreshes.
	 *
	 * @remarks
	 * Folder deletions do not emit any metadata-cache event because folders are
	 * not first-class Obsidian nodes — only `vault.on("delete")` fires for a
	 * deleted folder, and only `vault.on("rename")` fires for each file inside a
	 * moved folder (one event per file).  Native `metadataCache` events therefore
	 * miss empty-folder removals entirely, leaving ghost heading/folder states
	 * stale in the graph.
	 *
	 * This timer absorbs burst operations (e.g. a folder move triggers N rename
	 * events in rapid succession) and coalesces them into a single
	 * {@link refreshGraphLeaves} call 300 ms after the last event.
	 */
	private __vaultRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	private __hierarchy!: StructuralHierarchy;
	private __foldingManager!: FoldingManager;
	private __injector!: GraphDataInjector;
	private __patcher!: NodePrototypePatcher;
	private __interactions!: GraphInteractions;

	/**
	 * Triggered when the plugin is loaded.
	 *
	 * @remarks
	 * Execution order:
	 * 1. Load persisted settings from disk.
	 * 2. Register the settings tab.
	 * 3. Instantiate all graph subsystems (after settings are loaded so every
	 *    subsystem receives the populated settings object).
	 * 4. Register commands.
	 * 5. Install the `openLinkText` wrapper and Shift key listeners.
	 * 6. Register workspace event handlers.
	 * 7. Refresh all currently open graph leaves.
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
			// Arrow reads this.__injector at call time, not at construction — the
			// injector is assigned below, after foldingManager is constructed.
			(id) =>
				this.__injector.getGhostFolderIds().has(id) ||
				this.__injector.getGhostHeadingIds().has(id),
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
			() => this.__injector.getGhostFolderIds(),
			() => this.__injector.getGhostHeadingIds(),
			() => this.refreshGraphLeaves(),
		);

		this.__patcher = new NodePrototypePatcher(
			this.settings,
			this.__hierarchy,
			(nodeId) => this.__foldingManager.handleRecursiveUnfold(nodeId),
			() => this.__interactions.getSuppressNextContextMenu(),
			(value) => this.__interactions.setSuppressNextContextMenu(value),
			(nodeId) =>
				this.__injector.getGhostFolderIds().has(nodeId) ||
				this.__injector.getGhostHeadingIds().has(nodeId),
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

		this.addCommand({
			id: "toggle-weight-nodes-by-subtree",
			name: getI18n().commands.toggleWeightNodesBySubtree.name,
			callback: async () => {
				this.settings.weightNodesBySubtree = !this.settings.weightNodesBySubtree;
				await this.saveSettings();
				this.refreshGraphLeaves();
			},
		});

		// Mirrors the `hideRootNode` setting toggle. No default hotkey so the user
		// must bind one deliberately.
		this.addCommand({
			id: "toggle-root-node",
			name: getI18n().commands.toggleRootNode.name,
			callback: async () => {
				this.settings.hideRootNode = !this.settings.hideRootNode;
				await this.saveSettings();
				this.refreshGraphLeaves();
			},
		});

		// Intercept folder node clicks to reveal them in the file explorer.
		this.__interactions.wrapOpenLinkText();

		// Track Shift key state globally so we can detect Shift+click in openLinkText.
		this.__interactions.registerKeyListeners();

		// When a leaf changes, patch any graph leaf that has not been wrapped yet.
		// These event-driven refreshes are NOT forced: leaves whose renderer
		// already carries the setData wrapper are left untouched, so per-leaf view
		// state applied right before the event (e.g. a graph bookmark restoring
		// its saved filters via dataEngine.setOptions) is preserved.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf: Nullable<WorkspaceLeaf>) => {
				this.refreshGraphLeaves([leaf as GraphLeafWithCustomRenderer], false);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshGraphLeaves(this.__getLeavesOfTypeGraph(), false);
			}),
		);

		// Vault structural events — refresh the graph so ghost states are kept
		// accurate after file/folder create, delete, and rename operations.
		//
		// A 300 ms debounce absorbs burst operations: moving a folder emits one
		// `rename` event per contained file, and deleting an empty folder emits
		// `delete` but never a metadataCache event (folders are not Obsidian
		// metadata nodes).  Without this listener, ghost heading/folder rings
		// would remain stale after such operations because no `setData` is
		// re-pushed by the native graph engine.
		const scheduleVaultRefresh = () => {
			if (this.__vaultRefreshTimer !== null) {
				clearTimeout(this.__vaultRefreshTimer);
			}
			this.__vaultRefreshTimer = setTimeout(() => {
				this.__vaultRefreshTimer = null;
				this.refreshGraphLeaves();
			}, 300);
		};
		this.registerEvent(this.app.vault.on("create", scheduleVaultRefresh));
		this.registerEvent(this.app.vault.on("delete", scheduleVaultRefresh));
		this.registerEvent(this.app.vault.on("rename", scheduleVaultRefresh));

		// Iterates through all tabs which are of type "graph".
		this.refreshGraphLeaves();
	}

	/**
	 * Triggered when the plugin is unloaded.
	 *
	 * @remarks
	 * Restores every graph leaf to its native state:
	 * 1. Unwraps `workspace.openLinkText`.
	 * 2. Removes Shift key and context-menu suppression listeners.
	 * 3. For each graph leaf with a renderer: restores `originalSetData`,
	 *    unpatches the node prototype, and reloads the view.
	 */
	public override onunload(): void {
		// Cancel any pending vault-refresh debounce so it cannot fire after the
		// plugin subsystems have been torn down.
		if (this.__vaultRefreshTimer !== null) {
			clearTimeout(this.__vaultRefreshTimer);
			this.__vaultRefreshTimer = null;
		}

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

			// Re-establish the original data setter in the renderer, then delete the custom one, then reload the leaf.
			if (renderer.originalSetData) {
				renderer.setData = renderer.originalSetData;
				delete renderer.originalSetData;
			}

			this.__patcher.unpatch(renderer);

			// Snapshot the per-leaf view options across the reload, exactly like
			// refreshGraphLeaves does: the view's own `onload` resets them to the
			// global graph options, which would wipe an open graph bookmark's
			// configuration when the plugin is disabled.
			const savedOptions = leaf.view.dataEngine?.getOptions?.();

			leaf.view.unload();
			leaf.view.load();

			if (savedOptions !== undefined) {
				leaf.view.dataEngine?.setOptions?.(savedOptions);
			}

			// Read the renderer from the view again: `load` may have created a
			// fresh instance, and `changed` must run on the live one.
			leaf.view.renderer?.changed();
		});
	}

	/**
	 * Refreshes the provided graph leaves.
	 *
	 * @param leaves The leaves to refresh. When omitted, all open graph leaves
	 *   are refreshed.
	 * @param force  When `true` (default), every ready graph leaf goes through
	 *   the full `unload/load` cycle so Obsidian re-pushes its data through the
	 *   custom `setData` wrapper. When `false` (event-driven refreshes), leaves
	 *   whose renderer already carries the wrapper are skipped: the wrapper
	 *   processes every subsequent `setData` call on its own, and skipping the
	 *   reload preserves per-leaf view state such as the filters a graph
	 *   bookmark just restored.
	 *
	 * @remarks
	 * Non-graph leaves are silently skipped. The guard is important because the
	 * `active-leaf-change` event delivers the newly activated leaf regardless
	 * of its type: running `view.unload(); view.load()` on a non-graph leaf
	 * (e.g. the file explorer) would rebind its internal listeners and
	 * duplicate its context-menu handler.
	 *
	 * The graph view's `onload` re-applies the GLOBAL graph options
	 * (`dataEngine.setOptions(graphPlugin.instance.options)` — verified in the
	 * Obsidian bundle), which is what used to wipe bookmarked per-leaf options
	 * on every reload. The full cycle therefore snapshots the view options via
	 * `dataEngine.getOptions()` before `unload` and restores them with
	 * `dataEngine.setOptions()` after `load` — the exact mechanism the
	 * Bookmarks plugin itself uses to apply a saved graph configuration.
	 *
	 * The context-menu suppressor is installed AFTER `unload/load` because the
	 * reload may rebuild the view's DOM, which would orphan a listener
	 * installed before it.
	 */
	public refreshGraphLeaves(
		leaves: GraphLeafWithCustomRenderer[] = this.__getLeavesOfTypeGraph(),
		force: boolean = true,
	): void {
		leaves.forEach((leaf) => {
			// Only graph leaves with a mounted renderer should be touched. Running
			// `view.unload(); view.load()` on a non-graph leaf (e.g. the file explorer that
			// just became active via `active-leaf-change`) rebinds its internal listeners,
			// duplicating its context menu handler — that's the "stacked modals" bug.
			if (!this.__isReadyGraphLeaf(leaf)) return;

			// Event-driven refresh: nothing to do when the renderer is already
			// wrapped — and reloading would destroy per-leaf view state (e.g. the
			// options a graph bookmark applied right before this event fired).
			if (!force && leaf.view.renderer.originalSetData) return;

			this.__injectDataInLeaf(leaf);

			// Snapshot the per-leaf view options: the view's own `onload` resets
			// them to the global graph options, which would break graph bookmarks.
			const savedOptions = leaf.view.dataEngine?.getOptions?.();

			leaf.view.unload();
			leaf.view.load();

			if (savedOptions !== undefined) {
				leaf.view.dataEngine?.setOptions?.(savedOptions);
			}

			// Install the contextmenu suppressor AFTER unload/load — the reload may rebuild
			// the view's DOM, which would orphan a listener installed before it.
			this.__interactions.installContextMenuSuppressor(leaf);
			// Still needed when `savedOptions` is undefined (no dataEngine API):
			// `setOptions` triggers its own update, but this branch would not.
			// Obsidian coalesces redundant render requests, so the overlap is free.
			leaf.view.renderer.changed();
		});
	}

	/**
	 * Returns `true` when `leaf` is a fully-initialised graph leaf with a
	 * mounted renderer.
	 *
	 * @param leaf Nullable leaf to test.
	 * @returns Type predicate narrowing to `GraphLeafWithCustomRenderer`.
	 *
	 * @remarks
	 * The renderer can briefly be `undefined` when the `active-leaf-change`
	 * event fires before the graph view finishes initializing, so this guard
	 * prevents the downstream code from crashing on `renderer.*`.
	 */
	private __isReadyGraphLeaf(leaf: Nullable<GraphLeafWithCustomRenderer>): leaf is GraphLeafWithCustomRenderer {
		return !!leaf && !!leaf.view && leaf.view.getViewType() === "graph" && !!leaf.view.renderer;
	}

	/**
	 * Installs the custom `setData` override on the renderer of the given leaf
	 * via `GraphDataInjector`, passing a callback that applies the node
	 * prototype patch after each `setData` completes.
	 *
	 * @param leaf The graph leaf whose renderer should be patched.
	 */
	private __injectDataInLeaf(leaf: GraphLeafWithCustomRenderer): void {
		const renderer = leaf.view.renderer;
		this.__injector.install(renderer, (r: LeafRenderer) => this.__patcher.patch(r));
	}

	/**
	 * Returns all currently open leaves of type `"graph"`.
	 *
	 * @returns Array of graph leaves cast to `GraphLeafWithCustomRenderer`.
	 */
	private __getLeavesOfTypeGraph(): GraphLeafWithCustomRenderer[] {
		return this.app.workspace.getLeavesOfType("graph") as GraphLeafWithCustomRenderer[];
	}

	/**
	 * Loads persisted settings from disk and merges them over the defaults.
	 *
	 * @remarks
	 * Uses `Object.assign` so settings keys added in a newer plugin version
	 * keep their default values even when the stored data predates them.
	 */
	private async __loadSettings() {
		this.settings = Object.assign({}, this.settings, await this.loadData());
	}

	/**
	 * Persists `this.settings` to disk. All calls are serialised through
	 * `__savePromise` so concurrent invocations never race each other.
	 *
	 * @returns A `Promise` that resolves when this specific save has completed.
	 *
	 * @remarks
	 * Errors are caught and logged so a failed save does not propagate an
	 * unhandled rejection to the caller.
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
