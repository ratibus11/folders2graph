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
				const filterList = this.settings.folderFilterList;
				const filterMode = this.settings.folderFilterMode;
				const filtering = filterList.length > 0;

				// ── Phase 1 ─────────────────────────────────────────────────────
				// Iterate non-folder nodes to decide which folder nodes to create
				// and which file→folder parent mappings to register.
				//
				// foldersToCreate: Set of `/`-prefixed folder IDs that will receive
				//   a virtual node. The vault root "/" is always present.
				// nodeParentMap: Maps each non-folder node ID to the `/`-prefixed
				//   folder ID that should be its structural parent.

				const foldersToCreate = new Set<string>();
				foldersToCreate.add("/");
				const nodeParentMap = new Map<string, string>();

				Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
					if (nodeData.folderNode || nodeData.type === FOLDER_NODE_TAG) return;

					if (!filtering) {
						// No filter: add all ancestor folders and map to direct parent.
						this.getNodeParentFolders(nodeId).forEach((f) => foldersToCreate.add(f));
						nodeParentMap.set(nodeId, this.getNodeParentFolder(nodeId));
					} else if (filterMode === "exclude") {
						// Exclude mode: skip the file entirely if its containing folder is
						// covered by the exclusion list; otherwise add only the non-covered
						// ancestor folders.
						const containingFolder = this.getNodeContainingFolder(nodeId);
						if (this.isPathCoveredByList(containingFolder, filterList)) return;
						this.getNodeParentFolders(nodeId)
							.filter((f) => f === "/" || !this.isPathCoveredByList(f.slice(1), filterList))
							.forEach((f) => foldersToCreate.add(f));
						nodeParentMap.set(nodeId, this.getNodeParentFolder(nodeId));
					} else {
						// Include mode: find the shallowest covering entry for this file.
						// If none, the file gets no folder attachment.
						const anchor = this.findShallowestCoveringEntry(
							this.getNodeContainingFolder(nodeId),
							filterList,
						);
						if (anchor === null) return;
						const anchorFolderId = `/${anchor}`;
						foldersToCreate.add(anchorFolderId);
						// Add every ancestor of the file that is at or below the anchor.
						this.getNodeParentFolders(nodeId).forEach((f) => {
							if (f === "/") return; // root is always present; skip here
							const rel = f.slice(1); // strip leading "/"
							if (rel === anchor || rel.startsWith(anchor + "/")) {
								foldersToCreate.add(f);
							}
						});
						nodeParentMap.set(nodeId, this.getNodeParentFolder(nodeId));
					}
				});

				// ── Phase 2 ─────────────────────────────────────────────────────
				// Create virtual folder nodes for every path collected in Phase 1.

				foldersToCreate.forEach((folder) => {
					data.nodes[folder] = {
						type: FOLDER_NODE_TAG,
						links: {},
						folderNode: true,
					};
					this.folderNodeIds.add(folder);
				});

				// ── Phase 3 ─────────────────────────────────────────────────────
				// Wire folder→folder edges. Rule: for each folder ≠ "/", if its
				// natural parent folder is in foldersToCreate, cable to that parent;
				// otherwise cable to "/". This uniform rule handles anchors and
				// nested include entries automatically.

				foldersToCreate.forEach((folderId) => {
					if (folderId === "/") return;
					const naturalParent = this.getNodeParentFolder(folderId);
					const parentId = foldersToCreate.has(naturalParent) ? naturalParent : "/";
					data.nodes[parentId].links[folderId] = true;
					this.hierarchy.addChild(parentId, folderId);
				});

				// ── Phase 4 ─────────────────────────────────────────────────────
				// Wire file→folder edges from Phase 1 mappings.
				// Only cable when the mapped parent folder was actually created.

				nodeParentMap.forEach((parentFolderId, nodeId) => {
					if (!foldersToCreate.has(parentFolderId)) return;
					data.nodes[parentFolderId].links[nodeId] = true;
					this.hierarchy.addChild(parentFolderId, nodeId);
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
	 * Returns the vault-relative folder path that directly contains `nodeId`,
	 * without any leading slash. For a file at the vault root the result is an
	 * empty string.
	 *
	 * @param nodeId Graph node ID of the file (e.g. `"work/projects/note.md"`).
	 * @returns Vault-relative parent folder path (e.g. `"work/projects"`), or
	 *   `""` for files at the root level (`"/"` → `""`).
	 *
	 * @example
	 * getNodeContainingFolder("work/projects/note.md"); // "work/projects"
	 * getNodeContainingFolder("readme.md");             // ""
	 */
	private getNodeContainingFolder(nodeId: string): string {
		return this.getNodeParentFolder(nodeId).slice(1);
	}

	/**
	 * Returns `true` when `vaultPath` is exactly matched by an entry in `list`
	 * or is a descendant of one (matched by segment boundary, not substring).
	 *
	 * @param vaultPath Vault-relative path to test, without leading slash
	 *   (e.g. `"work/projects"`). For a file at the vault root this value is
	 *   `""` (the empty string, as returned by `getNodeContainingFolder`). An
	 *   empty `vaultPath` never matches any entry because the normalisation step
	 *   eliminates empty entries from the list — this is a deliberate correctness
	 *   property that prevents root-level files from being inadvertently filtered.
	 * @param list      Normalised filter list (no leading/trailing slashes).
	 * @returns `true` when at least one entry in `list` covers `vaultPath`.
	 *
	 * @remarks
	 * Matching is always done by full path segment: the entry `"tra"` does NOT
	 * match `"travail"` because the segment boundary check requires either an
	 * exact match or the path continuing with `"/"` after the entry.
	 *
	 * Entries that point to non-existent vault folders simply never match — no
	 * vault lookup is performed.
	 *
	 * @example
	 * isPathCoveredByList("work/projects",       ["work"]);           // true
	 * isPathCoveredByList("work/projects/sub",   ["work/projects"]);  // true
	 * isPathCoveredByList("work",                ["work/projects"]);  // false
	 * isPathCoveredByList("travail",             ["tra"]);            // false
	 * isPathCoveredByList("work",                ["work"]);           // true
	 * isPathCoveredByList("",                    ["work"]);           // false (root file)
	 */
	private isPathCoveredByList(vaultPath: string, list: string[]): boolean {
		return list.some(
			(entry) => vaultPath === entry || vaultPath.startsWith(entry + "/"),
		);
	}

	/**
	 * Returns the entry in `list` that covers `vaultPath` and has the fewest
	 * path segments (i.e. is the shallowest ancestor), or `null` when no entry
	 * covers it.
	 *
	 * @param vaultPath Vault-relative path to test, without leading slash.
	 * @param list      Normalised filter list (no leading/trailing slashes).
	 * @returns The shallowest covering entry string, or `null`.
	 *
	 * @remarks
	 * When multiple entries cover `vaultPath` (e.g. `["work", "work/projects"]`
	 * both cover `"work/projects/note"`), the one with fewer segments wins —
	 * `"work"` in this case — so the file is anchored as high as possible.
	 *
	 * @example
	 * findShallowestCoveringEntry("work/projects/note", ["work", "work/projects"]);
	 * // "work"
	 *
	 * findShallowestCoveringEntry("personal/diary", ["work"]);
	 * // null
	 */
	private findShallowestCoveringEntry(vaultPath: string, list: string[]): string | null {
		let best: string | null = null;
		let bestDepth = Infinity;
		for (const entry of list) {
			if (vaultPath === entry || vaultPath.startsWith(entry + "/")) {
				const depth = entry.split("/").length;
				if (depth < bestDepth) {
					bestDepth = depth;
					best = entry;
				}
			}
		}
		return best;
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
