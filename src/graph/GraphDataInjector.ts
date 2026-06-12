import { App, HeadingCache, TFile, getLinkpath } from "obsidian";
import { RendererData } from "interfaces/RendererData";
import { LeafRenderer } from "interfaces/LeafRenderer";
import { Settings } from "interfaces/Settings";
import { Nullable } from "types/Nullable";
import { StructuralHierarchy } from "graph/StructuralHierarchy";
import { FoldingManager } from "graph/FoldingManager";

const FOLDER_NODE_TAG = "f2g_node";
const HEADING_NODE_TAG = "f2g_heading_node";

/**
 * Injects folder nodes and heading nodes into the graph data before it is
 * passed to Obsidian's native renderer.
 *
 * @remarks
 * This class is responsible for:
 * - Enumerating parent folder paths from existing node IDs and inserting a
 *   virtual folder node for each path.
 * - Wiring structural links between folders, files, and headings, and
 *   registering those links in `StructuralHierarchy`.
 * - Injecting heading nodes derived from each Markdown file's metadata cache.
 * - Filtering out hidden nodes (from `settings.hiddenNodes`) before the data
 *   reaches the renderer.
 * - Triggering the structural hierarchy rebuild and the purge of stale entries
 *   on every `setData` call.
 *
 * The custom `setData` override is installed once per renderer instance via
 * `install`. The original function is preserved as
 * `renderer.originalSetData` so it can be restored on plugin unload.
 */
export class GraphDataInjector {
	private app: App;
	private settings: Settings;
	private hierarchy: StructuralHierarchy;
	private foldingManager: FoldingManager;
	private save: () => Promise<void>;

	/** IDs of folder nodes currently injected into the graph. Written here so
	 * `GraphInteractions` can read it via `getFolderNodeIds()` without
	 * introducing a circular dependency. */
	private folderNodeIds: Set<string> = new Set();

	/** Full set of node IDs present in the last complete graph data, used for
	 * validating Shift+click targets in the `openLinkText` wrapper. */
	private allNodeIds: Set<string> = new Set();

	/**
	 * @param app            Obsidian application instance.
	 * @param settings       Plugin settings; read for feature flags and `hiddenNodes`.
	 * @param hierarchy      Structural hierarchy; reset and rebuilt on every setData.
	 * @param foldingManager Used to purge stale `hiddenNodes` entries.
	 * @param save           Callback to persist settings when a purge modifies them.
	 */
	constructor(
		app: App,
		settings: Settings,
		hierarchy: StructuralHierarchy,
		foldingManager: FoldingManager,
		save: () => Promise<void>,
	) {
		this.app = app;
		this.settings = settings;
		this.hierarchy = hierarchy;
		this.foldingManager = foldingManager;
		this.save = save;
	}

	/**
	 * Returns the set of injected folder node IDs for the last graph data pass.
	 *
	 * @remarks
	 * Used by `GraphInteractions.wrapOpenLinkText` to identify folder-node
	 * clicks without relying on the brittle `startsWith("/")` heuristic, which
	 * could collide with unusual user wikilinks.
	 */
	getFolderNodeIds(): Set<string> {
		return this.folderNodeIds;
	}

	/**
	 * Returns the full set of all node IDs from the last graph data pass
	 * (post-injection, pre-filter).
	 *
	 * @remarks
	 * Used by `GraphInteractions.wrapOpenLinkText` to validate that a
	 * Shift+clicked node is a known graph node before toggling its fold state.
	 */
	getAllNodeIds(): Set<string> {
		return this.allNodeIds;
	}

	/**
	 * Installs the custom `setData` override on `renderer`. The original
	 * `setData` is saved as `renderer.originalSetData` so it can be restored
	 * on plugin unload.
	 *
	 * @param renderer       The graph leaf renderer to patch.
	 * @param onAfterSetData Callback invoked after the original `setData` runs;
	 *   used by the plugin to apply the node prototype patch once the node list
	 *   is populated.
	 *
	 * @remarks
	 * The override executes in this order on every setData call:
	 * 1. Clear `folderNodeIds` and reset the structural hierarchy.
	 * 2. Inject folder nodes (when `settings.showFolderNodes` is `true`).
	 * 3. Inject heading nodes (when `settings.showHeadingNodes` is `true`).
	 * 4. Snapshot `allNodeIds` for Shift+click validation.
	 * 5. Purge stale `hiddenNodes` entries against the vault; save if changed.
	 * 6. Compute the collapsed set for O(1) frame-time lookups.
	 * 7. Filter hidden nodes and their links from the data.
	 * 8. Call the original `setData`.
	 * 9. Invoke `onAfterSetData` so the prototype patch is (re-)applied.
	 */
	install(renderer: LeafRenderer, onAfterSetData: (renderer: LeafRenderer) => void): void {
		if (renderer.originalSetData == undefined) {
			renderer.originalSetData = renderer.setData;
		}

		renderer.setData = (data: RendererData) => {
			if (!renderer.originalSetData) {
				throw new Error("originalSetData is undefined.");
			}

			// Clear tracked folder node IDs so a toggle-off leaves no stale
			// entries behind that would hijack `openLinkText`.
			this.folderNodeIds.clear();

			// Reset structural maps before (re)building them during this setData.
			this.hierarchy.reset();

			if (this.settings.showFolderNodes) {
				const folders = new Set("/");

				// Collect all ancestor folder paths for every existing node.
				// e.g. "folder/subfolder/file.md" → ["/", "/folder", "/folder/subfolder"]
				Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
					const nodeSubFolders = this.getNodeParentFolders(nodeId);

					if (!nodeData.folderNode && nodeData.type != FOLDER_NODE_TAG && nodeSubFolders != null) {
						nodeSubFolders.forEach(folders.add, folders);
					}
				});

				// Add a virtual node for each folder path.
				folders.forEach((folder) => {
					data.nodes[folder] = {
						type: FOLDER_NODE_TAG,
						links: {},
						folderNode: true,
					};
					this.folderNodeIds.add(folder);
				});

				// Wire each node to its direct parent folder and register the
				// structural parent→child relationship.
				Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
					if (nodeData.type != FOLDER_NODE_TAG || nodeData.folderNode) {
						const directParent = this.getNodeParentFolder(nodeId);
						data.nodes[directParent].links[nodeId] = true;
						this.hierarchy.addChild(directParent, nodeId);
					}
				});

				if (this.settings.hideRootNode && data.nodes["/"]) {
					delete data.nodes["/"];
				}
			}

			if (this.settings.showHeadingNodes) {
				// Snapshot the file-like node IDs before injection so we don't
				// iterate over the folder/heading nodes we just added.
				const sourceNodeIds = Object.keys(data.nodes).filter((nodeId) => {
					const nodeData = data.nodes[nodeId];
					return nodeData.type !== FOLDER_NODE_TAG && nodeData.type !== HEADING_NODE_TAG;
				});
				sourceNodeIds.forEach((nodeId) => this.injectHeadingNodesForFile(data, nodeId));
			}

			// Record the complete graph state (post-injection, pre-filter) for
			// fold logic and for validating Shift+click targets.
			this.allNodeIds = new Set(Object.keys(data.nodes));

			// Purge stale entries from hiddenNodes based on vault existence.
			if (this.foldingManager.purge()) {
				// Serialised save — does not block rendering.
				this.save();
			}

			// Pre-compute the collapsed set for O(1) frame-time lookups.
			this.hierarchy.computeCollapsedSet();
			// Pre-compute indirect visible descendant counts for the subtree weight feature.
			this.hierarchy.computeVisibleDescendantCounts();

			// Filter hidden nodes from the data before passing to the renderer.
			for (const id of Object.keys(this.settings.hiddenNodes)) {
				delete data.nodes[id];
			}
			// Also remove links pointing to hidden nodes from every remaining node.
			for (const nodeData of Object.values(data.nodes)) {
				for (const targetId of Object.keys(nodeData.links)) {
					if (this.settings.hiddenNodes[targetId]) {
						delete nodeData.links[targetId];
					}
				}
			}

			const result = renderer.originalSetData(data);

			onAfterSetData(renderer);

			return result;
		};
	}

	/**
	 * For a given source node, reads its Markdown headings and inserts a
	 * heading node per heading, linking each link / embed found in the file
	 * to the heading it lives under (the closest heading above it).
	 *
	 * @param data   Mutable graph data object being built during this setData pass.
	 * @param nodeId Graph node ID of the source Markdown file.
	 *
	 * @remarks
	 * Heading node IDs follow Obsidian's wikilink format `path#heading` so a
	 * default click on the node opens the source note at that section.
	 *
	 * Structural relationships registered here:
	 * - file → root heading (heading with no ancestor in this file)
	 * - heading → direct sub-heading
	 *
	 * Non-structural links (refs/embeds from a heading to another file) are
	 * added as graph links but NOT registered in `StructuralHierarchy`.
	 *
	 * @example
	 * // Source file "docs/guide" has two headings:
	 * //   # Overview        (level 1)
	 * //   ## Installation   (level 2, child of Overview)
	 * //
	 * // Before injection:
	 * // data.nodes = { "docs/guide": { type: "", links: {}, ... } }
	 * //
	 * // After injectHeadingNodesForFile(data, "docs/guide"):
	 * // data.nodes = {
	 * //   "docs/guide":                    { type: "",                links: { "docs/guide#Overview": true } },
	 * //   "docs/guide#Overview":           { type: "f2g_heading_node", links: { "docs/guide#Installation": true } },
	 * //   "docs/guide#Installation":       { type: "f2g_heading_node", links: {} },
	 * // }
	 */
	private injectHeadingNodesForFile(data: RendererData, nodeId: string): void {
		const file = this.app.metadataCache.getFirstLinkpathDest(nodeId, "");
		if (!file || file.extension !== "md") return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache || !cache.headings || cache.headings.length === 0) return;

		const headings = cache.headings;
		const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];

		// Create one node per heading.
		headings.forEach((h) => {
			const headingId = this.buildHeadingNodeId(nodeId, h.heading);
			data.nodes[headingId] = {
				type: HEADING_NODE_TAG,
				links: {},
			};
		});

		// Wire the heading hierarchy: each heading is attached to the nearest
		// preceding heading of strictly lower level. Root headings (no such
		// ancestor) are attached to the source note. Obsidian guarantees
		// `headings` is in document order, so a stack is enough.
		const ancestors: HeadingCache[] = [];
		headings.forEach((h) => {
			while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= h.level) {
				ancestors.pop();
			}
			const headingId = this.buildHeadingNodeId(nodeId, h.heading);
			const parent = ancestors[ancestors.length - 1];
			const parentId = parent
				? this.buildHeadingNodeId(nodeId, parent.heading)
				: nodeId;
			data.nodes[parentId].links[headingId] = true;
			// Register structural relationship (file→heading or heading→sub-heading).
			this.hierarchy.addChild(parentId, headingId);
			ancestors.push(h);
		});

		// Attach each referenced note to the heading that contains the reference.
		// These are NOT structural relationships.
		refs.forEach((ref) => {
			const owning = this.findOwningHeading(headings, ref.position.start.line);
			if (!owning) return;

			const dest = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(ref.link),
				file.path,
			);
			if (!dest) return;

			const linkedNodeId = this.resolveGraphNodeId(data, dest);
			if (!linkedNodeId) return;

			const headingId = this.buildHeadingNodeId(nodeId, owning.heading);
			data.nodes[headingId].links[linkedNodeId] = true;
		});
	}

	/**
	 * Returns the heading whose start line is the closest above (or equal to)
	 * `line`.
	 *
	 * @param headings Document-ordered array of heading caches from Obsidian.
	 * @param line     Zero-based line number of the reference position.
	 * @returns The nearest owning `HeadingCache`, or `null` when the reference
	 *   appears before the first heading in the file.
	 *
	 * @remarks
	 * Headings are assumed to be sorted by position (Obsidian guarantees
	 * document order). Iteration stops as soon as a heading whose start line
	 * exceeds `line` is encountered.
	 */
	private findOwningHeading(headings: HeadingCache[], line: number): Nullable<HeadingCache> {
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
	 * Builds the heading node ID, matching Obsidian's wikilink syntax
	 * (`path#heading`) so default click handling opens the note at the
	 * corresponding section.
	 *
	 * @param sourceNodeId Graph node ID of the source file (e.g. `folder/note`).
	 * @param heading      Raw heading text as it appears in the Markdown file.
	 * @returns Heading node ID in the form `sourceNodeId#heading`.
	 *
	 * @example
	 * const nodeId = buildHeadingNodeId("docs/api", "Getting Started");
	 * // nodeId = "docs/api#Getting Started"
	 *
	 * @example
	 * // Heading text that itself contains a `#` character (degraded case).
	 * const nodeId = buildHeadingNodeId("notes/faq", "What is C#?");
	 * // nodeId = "notes/faq#What is C#?"
	 * // extractHeadingFromNodeId will stop at the first `#`, returning "What is C".
	 */
	private buildHeadingNodeId(sourceNodeId: string, heading: string): string {
		return `${sourceNodeId}#${heading}`;
	}

	/**
	 * Resolves a destination `TFile` to its corresponding graph node ID.
	 *
	 * @param data Graph data object containing the current node map.
	 * @param dest The destination file to look up.
	 * @returns The matching graph node ID, or `dest.path` as a fallback when
	 *   no exact match is found in the node map.
	 *
	 * @remarks
	 * The graph stores nodes either by their full path (e.g. `folder/note.md`)
	 * or by their basename for ghost links (e.g. `note`), so both candidates
	 * are tried before falling back to the path.
	 *
	 * @example
	 * // Node stored by full path (common in multi-folder vaults).
	 * // data.nodes = { "projects/roadmap.md": { ... } }
	 * // dest = { path: "projects/roadmap.md", basename: "roadmap", extension: "md" }
	 * const id = resolveGraphNodeId(data, dest);
	 * // id = "projects/roadmap.md"
	 *
	 * @example
	 * // Ghost link stored by basename only (no matching file in the vault).
	 * // data.nodes = { "roadmap": { ... } }
	 * // dest = { path: "roadmap.md", basename: "roadmap", extension: "md" }
	 * const id = resolveGraphNodeId(data, dest);
	 * // id = "roadmap"  (basename match, path without extension)
	 */
	private resolveGraphNodeId(data: RendererData, dest: TFile): Nullable<string> {
		if (data.nodes[dest.path]) return dest.path;
		const noExt = dest.extension === "md" ? dest.path.slice(0, -3) : dest.path;
		if (data.nodes[noExt]) return noExt;
		if (data.nodes[dest.basename]) return dest.basename;
		return dest.path;
	}

	/**
	 * Returns each ancestor folder path of `nodeId` as a `/`-prefixed string,
	 * including the vault root `/`.
	 *
	 * @param nodeId Graph node ID of the file or folder.
	 * @returns Array of `/`-prefixed folder paths from root to the immediate
	 *   parent, in ascending depth order.
	 *
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = getNodeParentFolders(nodeId);
	 * // result = ["/", "/folder", "/folder/subfolder"]
	 */
	private getNodeParentFolders(nodeId: string): string[] {
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
	 * Returns the direct parent folder path of `nodeId` as a `/`-prefixed
	 * string. The vault root `/` is its own parent.
	 *
	 * @param nodeId Graph node ID of the file or folder.
	 * @returns The `/`-prefixed parent folder path.
	 *
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = getNodeParentFolder(nodeId);
	 * // result = "/folder/subfolder"
	 */
	private getNodeParentFolder(nodeId: string): string {
		const splittedNodeId = nodeId.split("/");
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1).filter((e) => e != "");

		return `/${subFoldersSteps.join("/")}`;
	}
}
