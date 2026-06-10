import {
	CachedMetadata,
	HeadingCache,
	OpenViewState,
	PaneType,
	Plugin,
	TFile,
	TFolder,
	Workspace,
	WorkspaceLeaf,
	getLinkpath,
} from "obsidian";

import { GraphLeafWithCustomRenderer } from "interfaces/GraphLeafWithCustomRenderer";
import { LeafRenderer } from "interfaces/LeafRenderer";
import { RendererData } from "interfaces/RendererData";

import { getI18n } from "i18n";
import { Nullable } from "types/Nullable";
import { Settings } from "interfaces/Settings";
import { SettingsTab } from "SettingsTab";

const FOLDER_NODE_TAG = "f2g_node";
const HEADING_NODE_TAG = "f2g_heading_node";

export default class Folders2GraphPlugin extends Plugin {
	public override settings: Settings = {
		showFolderNodes: true,
		hideRootNode: false,
		nodeColor: "#5c8af5",
		showHeadingNodes: false,
		headingNodeColor: "#f5a55c",
	};

	/** IDs of folder nodes currently injected into the graph. Used to identify folder
	 * clicks in the wrapped `openLinkText` without relying on the brittle `startsWith("/")`
	 * heuristic, which could collide with unusual user wikilinks. */
	private __folderNodeIds = new Set<string>();

	/** Original `workspace.openLinkText` saved when we wrap it, so we can restore on unload. */
	private __originalOpenLinkText: Nullable<Workspace["openLinkText"]> = null;

	/**
	 * Triggered when the plugin is loaded.
	 */
	public override async onload(): Promise<void> {
		// Load settings tab.
		await this.__loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

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

		// Intercept folder node clicks to reveal them in the file explorer.
		this.__wrapOpenLinkText();

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
		this.__unwrapOpenLinkText();

		this.__getLeavesOfTypeGraph().forEach((leaf) => {
			// A `graph`-typed leaf can exist without a mounted renderer (e.g. the view never
			// finished initializing, or was destroyed before unload). Skip those to avoid
			// crashing the whole unload, which would leave other leaves un-restored.
			const renderer = leaf.view.renderer;
			if (!renderer) return;

			// Restablish the original data setter in the render, then delete the custom on, then reload the leaf.
			if (renderer.originalSetData) {
				renderer.setData = renderer.originalSetData;
				delete renderer.originalSetData;
			}

			this.__unpatchNodePrototype(renderer);

			leaf.view.unload();
			leaf.view.load();
			renderer.changed();
		});
	}

	/**
	 * Wraps `workspace.openLinkText` so that clicks on folder nodes reveal the corresponding
	 * folder in the file explorer instead of failing to resolve a non-existent file. The
	 * wrapper only intercepts linktexts that match a currently-injected folder node ID, so
	 * regular wikilink clicks are unaffected.
	 */
	private __wrapOpenLinkText(): void {
		const workspace = this.app.workspace;
		this.__originalOpenLinkText = workspace.openLinkText.bind(workspace);

		workspace.openLinkText = (
			linktext: string,
			sourcePath: string,
			newLeaf?: PaneType | boolean,
			openViewState?: OpenViewState,
		): Promise<void> => {
			if (this.__folderNodeIds.has(linktext)) {
				this.__revealFolderInExplorer(linktext);
				return Promise.resolve();
			}
			return this.__originalOpenLinkText!(linktext, sourcePath, newLeaf, openViewState);
		};
	}

	/**
	 * Restores the original `workspace.openLinkText`.
	 */
	private __unwrapOpenLinkText(): void {
		if (!this.__originalOpenLinkText) return;
		this.app.workspace.openLinkText = this.__originalOpenLinkText;
		this.__originalOpenLinkText = null;
	}

	/**
	 * Reveals the folder backing a folder node in Obsidian's file explorer. Folder node IDs
	 * use a leading `/` and a `/`-rooted path (e.g. `/work/notes`); the vault stores paths
	 * without the leading slash, and the vault root is `""`.
	 */
	private __revealFolderInExplorer(folderNodeId: string): void {
		const vaultPath = folderNodeId === "/" ? "" : folderNodeId.slice(1);
		const folder: Nullable<TFolder> =
			vaultPath === ""
				? this.app.vault.getRoot()
				: (this.app.vault.getAbstractFileByPath(vaultPath) as Nullable<TFolder>);
		if (!folder) return;

		// Make sure a file-explorer leaf exists and is in focus.
		let leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
		if (!leaf) {
			const leftLeaf = this.app.workspace.getLeftLeaf(false);
			if (leftLeaf) {
				leftLeaf.setViewState({ type: "file-explorer" });
				leaf = leftLeaf;
			}
		}
		if (!leaf) return;
		this.app.workspace.revealLeaf(leaf);

		// `revealInFolder` is exposed by the internal `file-explorer` plugin instance.
		// Not part of the public API — fall back silently if it ever moves.
		const fileExplorerInstance = (this.app as unknown as {
			internalPlugins?: {
				getPluginById?: (id: string) => { instance?: { revealInFolder?: (f: TFolder) => void } };
			};
		}).internalPlugins?.getPluginById?.("file-explorer")?.instance;

		fileExplorerInstance?.revealInFolder?.(folder);
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
	 * Renders the graph leaf with a custom renderer.
	 * @param leaf The graph leaf to render.
	 */
	private __injectDataInLeaf(leaf: GraphLeafWithCustomRenderer): void {
		const renderer = leaf.view.renderer;

		// Store the original data setter in another property, then override the data setter with a custom one.
		if (renderer.originalSetData == undefined) {
			renderer.originalSetData = renderer.setData;
		}

		// Define the custom data setter.
		renderer.setData = (data: RendererData) => {
			if (!renderer.originalSetData) {
				throw new Error("originalSetData is undefined.");
			}

			// Clear the tracked folder node IDs first so a toggle-off leaves no stale entries
			// behind that would still hijack `openLinkText`.
			this.__folderNodeIds.clear();

			if (this.settings.showFolderNodes) {
				const folders = new Set("/");

				// Get all folders of the nodes. Uses the ID of the node.
				// eg. file "folder/subfolder/file.md" will generate the following folders: "/", "/folder", "/folder/subfolder
				Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
					const nodeSubFolders = this.__getNodeParentFolders(nodeId);

					if (!nodeData.folderNode && nodeData.type != FOLDER_NODE_TAG && nodeSubFolders != null) {
						nodeSubFolders.forEach(folders.add, folders);
					}
				});

				// Add a node for each folder.
				folders.forEach((folder) => {
					data.nodes[folder] = {
						type: FOLDER_NODE_TAG,
						links: {},
						folderNode: true,
					};
					this.__folderNodeIds.add(folder);
				});

				// Add the links between the nodes and the folders.
				Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
					if (nodeData.type != FOLDER_NODE_TAG || nodeData.folderNode) {
						const directParent = this.__getNodeParentFolder(nodeId);
						data.nodes[directParent].links[nodeId] = true;
					}
				});

				if (this.settings.hideRootNode && data.nodes["/"]) {
					delete data.nodes["/"];
				}
			}

			if (this.settings.showHeadingNodes) {
				// Snapshot the file-like node IDs before injection so we don't iterate over the
				// folder/heading nodes we just added.
				const sourceNodeIds = Object.keys(data.nodes).filter((nodeId) => {
					const nodeData = data.nodes[nodeId];
					return nodeData.type !== FOLDER_NODE_TAG && nodeData.type !== HEADING_NODE_TAG;
				});
				sourceNodeIds.forEach((nodeId) => this.__injectHeadingNodesForFile(data, nodeId));
			}

			const result = renderer.originalSetData(data);

			this.__patchNodePrototype(renderer);

			return result;
		};
	}

	/**
	 * For a given source node, reads its Markdown headings and inserts a heading node per heading,
	 * linking each link / embed found in the file to the heading it lives under (the closest
	 * heading above it). Heading node IDs follow Obsidian's wikilink format `path#heading` so
	 * a default click on the node opens the source note at that section.
	 */
	private __injectHeadingNodesForFile(data: RendererData, nodeId: string): void {
		const file = this.app.metadataCache.getFirstLinkpathDest(nodeId, "");
		if (!file || file.extension !== "md") return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache || !cache.headings || cache.headings.length === 0) return;

		const headings = cache.headings;
		const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];

		// Create one node per heading.
		headings.forEach((h) => {
			const headingId = this.__buildHeadingNodeId(nodeId, h.heading);
			data.nodes[headingId] = {
				type: HEADING_NODE_TAG,
				links: {},
			};
		});

		// Wire the heading hierarchy: each heading is attached to the nearest preceding heading
		// of strictly lower level. Root headings (no such ancestor) are attached to the source
		// note. Obsidian guarantees `headings` is in document order, so a stack is enough.
		const ancestors: HeadingCache[] = [];
		headings.forEach((h) => {
			while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= h.level) {
				ancestors.pop();
			}
			const headingId = this.__buildHeadingNodeId(nodeId, h.heading);
			const parent = ancestors[ancestors.length - 1];
			const parentId = parent
				? this.__buildHeadingNodeId(nodeId, parent.heading)
				: nodeId;
			data.nodes[parentId].links[headingId] = true;
			ancestors.push(h);
		});

		// Attach each referenced note to the heading that contains the reference.
		refs.forEach((ref) => {
			const owning = this.__findOwningHeading(headings, ref.position.start.line);
			if (!owning) return;

			const dest = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(ref.link),
				file.path,
			);
			if (!dest) return;

			const linkedNodeId = this.__resolveGraphNodeId(data, dest);
			if (!linkedNodeId) return;

			const headingId = this.__buildHeadingNodeId(nodeId, owning.heading);
			data.nodes[headingId].links[linkedNodeId] = true;
		});
	}

	/**
	 * Returns the heading whose start line is the closest above (or equal to) `line`.
	 * Headings are assumed to be sorted by position (Obsidian guarantees document order).
	 */
	private __findOwningHeading(headings: HeadingCache[], line: number): Nullable<HeadingCache> {
		let owning: Nullable<HeadingCache> = null;
		for (const h of headings) {
			if (h.position.start.line <= line) {
				owning = h;
			} else {
				break;
			}
		}
		return owning;
	}

	/**
	 * Builds the heading node ID, matching Obsidian's wikilink syntax (`path#heading`)
	 * so default click handling opens the note at the corresponding section.
	 */
	private __buildHeadingNodeId(sourceNodeId: string, heading: string): string {
		return `${sourceNodeId}#${heading}`;
	}

	/**
	 * Resolves a destination TFile to its corresponding graph node ID. The graph stores
	 * nodes either by their full path or by their basename for ghost links, so we try
	 * both candidates and fall back to the path.
	 */
	private __resolveGraphNodeId(data: RendererData, dest: TFile): Nullable<string> {
		if (data.nodes[dest.path]) return dest.path;
		const noExt = dest.extension === "md" ? dest.path.slice(0, -3) : dest.path;
		if (data.nodes[noExt]) return noExt;
		if (data.nodes[dest.basename]) return dest.basename;
		return dest.path;
	}

	/**
	 * Patches the Node class prototype so every node instance — current and future —
	 * returns the configured color for folder nodes. Patching the prototype (rather than
	 * each instance) ensures the override survives node recreations triggered by Obsidian
	 * (e.g. toggling orphans, tag filters) without going through our custom `setData`.
	 */
	private __patchNodePrototype(renderer: LeafRenderer): void {
		if (renderer.nodes.length === 0) return;

		const proto = Object.getPrototypeOf(renderer.nodes[0]);
		if (proto.__f2gPatched) return;

		const originalGetFillColor = proto.getFillColor;
		const plugin = this;

		proto.__f2gOriginalGetFillColor = originalGetFillColor;
		proto.getFillColor = function () {
			if (this.type === FOLDER_NODE_TAG) {
				return { a: 1, rgb: plugin.__getColorNumber(plugin.settings.nodeColor) };
			}
			if (this.type === HEADING_NODE_TAG) {
				return { a: 1, rgb: plugin.__getColorNumber(plugin.settings.headingNodeColor) };
			}
			return originalGetFillColor.call(this);
		};

		// Heading nodes use the wikilink syntax `path#heading` as their ID so the native
		// click handler resolves to the right section, but we want the label to show only the
		// heading text. If the Node prototype exposes a `getDisplayText` method, override it.
		const originalGetDisplayText = proto.getDisplayText;
		if (typeof originalGetDisplayText === "function") {
			proto.__f2gOriginalGetDisplayText = originalGetDisplayText;
			proto.getDisplayText = function () {
				if (this.type === HEADING_NODE_TAG) {
					return plugin.__extractHeadingFromNodeId(this.id);
				}
				return originalGetDisplayText.call(this);
			};
		}

		proto.__f2gPatched = true;
	}

	/**
	 * Extracts the heading portion of a heading node ID (`path#heading` → `heading`).
	 * Falls back to the full ID when no `#` is present.
	 */
	private __extractHeadingFromNodeId(nodeId: string): string {
		const idx = nodeId.lastIndexOf("#");
		return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
	}

	/**
	 * Restores the original `getFillColor` on the Node prototype. Called on plugin unload.
	 */
	private __unpatchNodePrototype(renderer: LeafRenderer): void {
		if (renderer.nodes.length === 0) return;

		const proto = Object.getPrototypeOf(renderer.nodes[0]);
		if (!proto.__f2gPatched) return;

		proto.getFillColor = proto.__f2gOriginalGetFillColor;
		delete proto.__f2gOriginalGetFillColor;

		if (proto.__f2gOriginalGetDisplayText) {
			proto.getDisplayText = proto.__f2gOriginalGetDisplayText;
			delete proto.__f2gOriginalGetDisplayText;
		}

		delete proto.__f2gPatched;
	}

	/**
	 * Get all leaves of type "graph".
	 * @returns The leaves of type "graph".
	 */
	private __getLeavesOfTypeGraph(): GraphLeafWithCustomRenderer[] {
		return this.app.workspace.getLeavesOfType("graph") as GraphLeafWithCustomRenderer[];
	}

	/**
	 * Get the parent folders of a node.
	 * @param nodeId The ID of the node.
	 * @returns Will return each folder and subfolder of the node.
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = __getNodeParentFolders(nodeId);
	 * // result = ["/", "/folder", "/folder/subfolder"]
	 */
	private __getNodeParentFolders(nodeId: string): string[] {
		const subFolders = ["/"];

		const splittedNodeId = nodeId.split("/");
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1);

		let currentFolder = "";
		subFoldersSteps.forEach((subfolder) => {
			currentFolder += "/" + subfolder;
			subFolders.push(currentFolder);
		});

		return subFolders;
	}

	/**
	 * Get the parent folder of a node.
	 * @param nodeId The ID of the node.
	 * @returns The parent folder of the node.
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = __getNodeParentFolder(nodeId);
	 * // result = "/folder/subfolder"
	 */
	private __getNodeParentFolder(nodeId: string): string {
		const splittedNodeId = nodeId.split("/");
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1).filter((e) => e != "");

		return `/${subFoldersSteps.join("/")}`;
	}

	/**
	 * Refresh settings and apply them to `this.settings`.
	 */
	private async __loadSettings() {
		this.settings = Object.assign({}, this.settings, await this.loadData());
	}

	/**
	 * Call the Obsidian API to save the settings.
	 */
	public async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Get the node color number.
	 * @description The color is stored in hex format and the renderer uses a number which is the concatenation of the binary values of the RGB components.
	 * @example
	 * const color = "#001100"; // (00000000 00000001 0000001)
	 * const result = __getNodeColorNumber(color);
	 * // result = 129
	 * @returns
	 */
	private __getColorNumber(hexColor: string): number {
		const r = parseInt(hexColor.substring(1, 3), 16).toString(2).padStart(8, "0");
		const g = parseInt(hexColor.substring(3, 5), 16).toString(2).padStart(8, "0");
		const b = parseInt(hexColor.substring(5, 7), 16).toString(2).padStart(8, "0");

		return parseInt(r + g + b, 2);
	}
}
