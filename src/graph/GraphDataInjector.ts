import { App, HeadingCache, TFile, TFolder, getLinkpath } from "obsidian";
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
	 * Folder node IDs (starting with `/`) that were injected as virtual nodes but
	 * whose vault path does not correspond to a real `TFolder`.  Written during
	 * Phase 2 of `setData`; cleared at the start of each pass. Read via
	 * `getGhostFolderIds()` by `GraphInteractions` and `NodePrototypePatcher`.
	 */
	private ghostFolderIds: Set<string> = new Set();

	/**
	 * Heading node IDs (in the form `path#heading`) that were synthesised because
	 * a wikilink references a heading that does not yet exist in the target file's
	 * metadata cache.  Written during heading injection; cleared at the start of
	 * each pass. Read via `getGhostHeadingIds()` by `GraphInteractions` and
	 * `NodePrototypePatcher`.
	 */
	private ghostHeadingIds: Set<string> = new Set();

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
	 * Returns the set of injected folder node IDs that have no corresponding
	 * real `TFolder` in the vault.
	 *
	 * @remarks
	 * A ghost folder arises when a wikilink targets a path whose ancestor
	 * directories do not exist yet (e.g. `[[/a/b/c.md]]` creates ghost folders
	 * `/a` and `/a/b` when neither exists).  Ghost folders participate in all
	 * normal mechanics (folding, weighting, path-filter) but render as outlined
	 * circles instead of filled discs, and clicking them creates the vault folder.
	 *
	 * The set is reset at the start of every `setData` pass.
	 */
	getGhostFolderIds(): Set<string> {
		return this.ghostFolderIds;
	}

	/**
	 * Returns the set of heading node IDs that were synthesised from wikilinks
	 * that reference a heading not present in the target file's metadata cache.
	 *
	 * @remarks
	 * A ghost heading is created when a link contains a `#` fragment and the
	 * target file exists but does not have a matching heading.  The node is
	 * attached to the target file node (not to the source) so that clicking it
	 * inserts the heading at the end of the target file.
	 *
	 * Block-reference fragments (beginning with `^`) are intentionally excluded
	 * because they do not correspond to headings.
	 *
	 * The set is reset at the start of every `setData` pass.
	 */
	getGhostHeadingIds(): Set<string> {
		return this.ghostHeadingIds;
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
	 * 1. Clear `folderNodeIds`, `ghostFolderIds`, `ghostHeadingIds`, and reset
	 *    the structural hierarchy.
	 * 2. Inject folder nodes (when `settings.showFolderNodes` is `true`),
	 *    marking ghost folder IDs for folders that have no corresponding
	 *    `TFolder` in the vault. Includes optional removal of filtered-out file
	 *    nodes and their incoming links (when `settings.folderFilterHideFiles`
	 *    is `true`).
	 * 3. Inject real heading nodes (when `settings.showHeadingNodes` is `true`),
	 *    then synthesise ghost heading nodes for any `#`-fragment wikilinks whose
	 *    target heading is absent from the destination file's metadata cache
	 *    (including links to unresolved files), then rewire fragment-link edges to
	 *    their target heading (real or ghost) node.
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

			// Clear ghost-node tracking sets from the previous pass so stale
			// entries do not affect the current render.
			this.ghostFolderIds.clear();
			this.ghostHeadingIds.clear();

			// Reset structural maps before (re)building them during this setData.
			this.hierarchy.reset();

			// Collects file node IDs that fall outside the filter scope so they can
			// be hidden from the graph when `settings.folderFilterHideFiles` is
			// enabled. Only populated when a folder filter is active; declared here
			// because the heading injection block below also sweeps dangling links
			// toward these IDs.
			const filteredOutFileIds = new Set<string>();

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
						if (this.isPathCoveredByList(containingFolder, filterList)) {
							filteredOutFileIds.add(nodeId);
							return;
						}
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
						if (anchor === null) {
							filteredOutFileIds.add(nodeId);
							return;
						}
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
				// A folder is "ghost" when its vault path does not exist as a
				// TFolder; the vault root is always real. Lookups are memoised
				// inside this pass to avoid redundant vault traversals.
				const folderExistsInVault = new Map<string, boolean>();
				const isFolderReal = (folderId: string): boolean => {
					if (folderId === "/") return true;
					const cached = folderExistsInVault.get(folderId);
					if (cached !== undefined) return cached;
					const vaultPath = folderId.slice(1);
					const real = this.app.vault.getAbstractFileByPath(vaultPath) instanceof TFolder;
					folderExistsInVault.set(folderId, real);
					return real;
				};

				foldersToCreate.forEach((folder) => {
					data.nodes[folder] = {
						type: FOLDER_NODE_TAG,
						links: {},
						folderNode: true,
					};
					this.folderNodeIds.add(folder);
					if (!isFolderReal(folder)) {
						this.ghostFolderIds.add(folder);
					}
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

				// Remove filtered-out file nodes (and their incoming links) from the
				// graph when the user has opted in via `folderFilterHideFiles`.
				// This runs BEFORE heading injection so the removed files never
				// receive heading children, and before the allNodeIds snapshot so
				// those IDs are not considered valid Shift+click targets.
				if (this.settings.folderFilterHideFiles && filteredOutFileIds.size > 0) {
					for (const id of filteredOutFileIds) {
						delete data.nodes[id];
					}
					// Strip links pointing to removed files from every remaining node.
					for (const nodeData of Object.values(data.nodes)) {
						for (const targetId of Object.keys(nodeData.links)) {
							if (filteredOutFileIds.has(targetId)) {
								delete nodeData.links[targetId];
							}
						}
					}
				}
			}

			if (this.settings.showHeadingNodes) {
				// Snapshot the file-like node IDs before injection so we don't
				// iterate over the folder/heading nodes we just added.
				const sourceNodeIds = Object.keys(data.nodes).filter((nodeId) => {
					const nodeData = data.nodes[nodeId];
					return nodeData.type !== FOLDER_NODE_TAG && nodeData.type !== HEADING_NODE_TAG;
				});

				// Derive anchor flags from the setting once per setData pass.
				// Both are `true` for the default "heading-heading" mode, which
				// preserves existing behaviour exactly.
				const mode = this.settings.headingLinkAnchorMode;
				const anchorSourceAtHeading = mode === "heading-file" || mode === "heading-heading";
				const anchorTargetAtHeading = mode === "file-heading" || mode === "heading-heading";

				sourceNodeIds.forEach((nodeId) =>
					this.injectHeadingNodesForFile(data, nodeId, anchorSourceAtHeading, anchorTargetAtHeading),
				);

				// After real headings are in place, scan every source file for links
				// that reference a heading that is absent from the target file — those
				// become ghost heading nodes attached to the target file node.
				// Always active when heading nodes are shown: the anchor mode only
				// governs the link EDGES, never whether ghost headings are displayed.
				// Must run BEFORE rewireFragmentLinksForFile so that ghost heading
				// nodes (including those for unresolved target files) are already
				// present in data.nodes when the rewire pass looks them up.
				sourceNodeIds.forEach((nodeId) =>
					this.injectGhostHeadingNodesForFile(data, nodeId),
				);

				// After ALL real and ghost heading nodes are in place, rewire any edge
				// (native file→file or injected heading→file) whose corresponding link
				// carries a #fragment pointing to an existing or ghost heading: each
				// such edge is redirected to the target heading node (the old edge is
				// removed unless there is also a bare, fragment-free link from the same
				// source anchor to the same target file).
				// Runs whenever target-side anchoring is at a heading (file-heading or
				// heading-heading), and also when source-side anchoring is at a heading
				// (heading-file) to handle native edge removal for under-heading refs.
				sourceNodeIds.forEach((nodeId) =>
					this.rewireFragmentLinksForFile(data, nodeId, anchorSourceAtHeading, anchorTargetAtHeading),
				);

				// Heading injection attaches referenced notes via resolveGraphNodeId,
				// whose fallback returns the destination path even when that node is
				// absent from the data — a heading of a visible file referencing a
				// file removed by the folder filter would therefore create a dangling
				// edge (and a potential ghost node). Sweep those references out.
				if (this.settings.folderFilterHideFiles && filteredOutFileIds.size > 0) {
					for (const nodeData of Object.values(data.nodes)) {
						for (const targetId of Object.keys(nodeData.links)) {
							if (filteredOutFileIds.has(targetId)) {
								delete nodeData.links[targetId];
							}
						}
					}
				}
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
	 * @param data                  Mutable graph data object being built during this setData pass.
	 * @param nodeId                Graph node ID of the source Markdown file.
	 * @param anchorSourceAtHeading When `true`, the source end of an edge for a
	 *   ref under a heading is the heading node; when `false` the source is the
	 *   file node. Derived from `settings.headingLinkAnchorMode`.
	 * @param anchorTargetAtHeading When `true`, fragment refs that resolve to an
	 *   existing heading in the target file will ultimately point to that heading
	 *   node; the actual rewiring is deferred to `rewireFragmentLinksForFile` so
	 *   that all target heading nodes are guaranteed to exist first. When `false`
	 *   the edge always points to the target file node regardless of the fragment.
	 *   Derived from `settings.headingLinkAnchorMode`.
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
	 * For refs under a heading that carry a `#fragment`, this method always
	 * wires the edge to the TARGET FILE NODE, regardless of `anchorTargetAtHeading`.
	 * The `rewireFragmentLinksForFile` pass (which runs after heading nodes for
	 * ALL source files have been created) is responsible for redirecting those
	 * edges to the correct target heading node.  This two-pass design avoids the
	 * ordering bug where a source file processed before its target would find the
	 * target's heading nodes absent from `data.nodes`.
	 *
	 * For `file-file` mode (`!anchorSourceAtHeading && !anchorTargetAtHeading`),
	 * under-heading fragment refs produce no additional edge: the native A→B
	 * edge already captures the relationship, and no heading-node target exists
	 * on this side.
	 *
	 * Block-reference fragments (beginning with `^`) are excluded and always
	 * resolve to the target file node regardless of mode.
	 *
	 * @example
	 * // Source file "docs/guide" has two headings:
	 * //   # Overview        (level 1)
	 * //   ## Installation   (level 2, child of Overview)
	 * //
	 * // Before injection:
	 * // data.nodes = { "docs/guide": { type: "", links: {}, ... } }
	 * //
	 * // After injectHeadingNodesForFile(data, "docs/guide", true, true):
	 * // data.nodes = {
	 * //   "docs/guide":                    { type: "",                links: { "docs/guide#Overview": true } },
	 * //   "docs/guide#Overview":           { type: "f2g_heading_node", links: { "docs/guide#Installation": true } },
	 * //   "docs/guide#Installation":       { type: "f2g_heading_node", links: {} },
	 * // }
	 */
	private injectHeadingNodesForFile(
		data: RendererData,
		nodeId: string,
		anchorSourceAtHeading: boolean,
		anchorTargetAtHeading: boolean,
	): void {
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
		// The source anchor is governed by anchorSourceAtHeading (derived from
		// settings.headingLinkAnchorMode).
		//
		// Fragment resolution (anchorTargetAtHeading) is intentionally NOT
		// performed here: the target file's heading nodes may not yet exist in
		// data.nodes when this method runs (files are processed one at a time).
		// rewireFragmentLinksForFile runs AFTER all files' heading nodes are
		// created and handles the heading→headingNode redirect for every ref.
		refs.forEach((ref) => {
			const owning = this.findOwningHeading(headings, ref.position.start.line);
			if (!owning) return;

			const dest = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(ref.link),
				file.path,
			);
			if (!dest) return;

			const targetFileNodeId = this.resolveGraphNodeId(data, dest);
			if (!targetFileNodeId) return;

			// Determine whether the ref targets a specific heading in the dest file.
			// Block references (^) are excluded — they do not correspond to headings.
			const hashIdx = ref.link.indexOf("#");
			const isFragmentRef = hashIdx >= 0 && !ref.link.slice(hashIdx + 1).startsWith("^");

			// For file-file mode: under-heading fragment refs produce no additional
			// edge — the native A→B edge already captures the relationship.
			if (isFragmentRef && !anchorSourceAtHeading && !anchorTargetAtHeading) return;

			// Choose the source anchor (heading node or file node).
			const sourceId = anchorSourceAtHeading
				? this.buildHeadingNodeId(nodeId, owning.heading)
				: nodeId;

			// Always wire to the target FILE node here.  rewireFragmentLinksForFile
			// will redirect fragment refs to the appropriate target heading node once
			// all heading nodes for every source file have been created.
			data.nodes[sourceId].links[targetFileNodeId] = true;
		});
	}

	/**
	 * Rewires file→file (and heading→file) edges whose source link carries a
	 * `#fragment` that resolves to an existing or ghost heading node in the target
	 * file, and handles native edge removal for under-heading fragment refs when
	 * required by the anchor mode.
	 *
	 * @param data                  Mutable graph data object.
	 * @param nodeId                Graph node ID of the source Markdown file.
	 * @param anchorSourceAtHeading Whether the source side of a fragment link is
	 *   anchored at the heading node (`true`) or the file node (`false`). Derived
	 *   from `settings.headingLinkAnchorMode`.
	 * @param anchorTargetAtHeading Whether the target side of a fragment link is
	 *   anchored at the heading node (`true`) or the file node (`false`). Derived
	 *   from `settings.headingLinkAnchorMode`.
	 *
	 * @remarks
	 * Must be called AFTER both `injectHeadingNodesForFile` and
	 * `injectGhostHeadingNodesForFile` have run for ALL source files so that every
	 * target heading node (real and ghost) is already present in `data.nodes`.
	 *
	 * Returns early without any work when both flags are `false` (file-file mode),
	 * because the native A→B edge is the intended representation and no rewiring
	 * is needed.
	 *
	 * **Target-at-heading modes** (`file-heading` and `heading-heading`):
	 * Scans both file-level refs AND under-heading refs that carry a non-block
	 * `#fragment` resolving to an existing or ghost heading node:
	 * - For file-level refs: adds `sourceFileNode → targetHeadingNode` and
	 *   removes `sourceFileNode → targetFileNode` unless a bare link coexists.
	 * - For under-heading refs: adds `sourceHeadingNode → targetHeadingNode` and
	 *   removes `sourceHeadingNode → targetFileNode` (placed there by
	 *   `injectHeadingNodesForFile`) unless a bare link from the same heading
	 *   coexists.  The bare-link guard is scoped to the specific source heading
	 *   node, not the file node.
	 * The native `A→B` file-level edge is also removed when appropriate.
	 *
	 * When the target file is unresolved (does not exist in the vault),
	 * `getFirstLinkpathDest` returns `null`.  In target-at-heading modes the
	 * pass looks up the ghost heading node created by `injectGhostHeadingNodesForFile`
	 * via `findUnresolvedNodeId` and a case-insensitive search over `ghostHeadingIds`,
	 * then wires the source anchor to that ghost heading node and removes the
	 * `source → unresolvedFileNode` edge (unless a bare link from the same anchor
	 * to that unresolved node coexists).
	 *
	 * **Heading-file mode** (`anchorSourceAtHeading && !anchorTargetAtHeading`):
	 * Does NOT rewire file-level refs (the native `A→B` is the correct
	 * representation for file-level fragment refs in this mode).  Under-heading
	 * fragment refs were given a heading→file edge by `injectHeadingNodesForFile`;
	 * this pass removes the native `A→B` file edge following the bare-link rule.
	 *
	 * Block-reference fragments (`^`) are excluded everywhere.
	 */
	private rewireFragmentLinksForFile(
		data: RendererData,
		nodeId: string,
		anchorSourceAtHeading: boolean,
		anchorTargetAtHeading: boolean,
	): void {
		// file-file: no intervention needed — the native A→B edge is sufficient.
		if (!anchorSourceAtHeading && !anchorTargetAtHeading) return;

		const file = this.app.metadataCache.getFirstLinkpathDest(nodeId, "");
		if (!file || file.extension !== "md") return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return;

		const headings = cache.headings ?? [];
		const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];

		// Collect per-(sourceAnchor, targetFile) information for refs that this
		// pass should handle.
		//
		// The outer key is the SOURCE anchor node ID:
		//   - For file-level refs:      nodeId (the file node)
		//   - For under-heading refs:   the heading node that owns the ref
		//     (only relevant when anchorSourceAtHeading is true; otherwise nodeId)
		//
		// For each target file node ID inside that anchor we track:
		//   - hasBareLink:    true when at least one processed ref from this anchor
		//                     has no fragment (or ^)
		//   - hasFragmentRef: true when at least one fragment ref was collected
		//                     (used to decide whether the sourceAnchor→targetFile
		//                     edge should be removed)
		//   - headingNodes:   target heading node IDs to add as edges
		//                     (only populated when anchorTargetAtHeading is true
		//                     and the heading node exists in data.nodes)
		type TargetInfo = { hasBareLink: boolean; hasFragmentRef: boolean; headingNodes: Set<string> };
		// Map<sourceAnchorId, Map<targetFileNodeId, TargetInfo>>
		const anchorTargets = new Map<string, Map<string, TargetInfo>>();

		const getOrCreateInfo = (anchorId: string, targetId: string): TargetInfo => {
			let targetMap = anchorTargets.get(anchorId);
			if (!targetMap) {
				targetMap = new Map();
				anchorTargets.set(anchorId, targetMap);
			}
			let info = targetMap.get(targetId);
			if (!info) {
				info = { hasBareLink: false, hasFragmentRef: false, headingNodes: new Set() };
				targetMap.set(targetId, info);
			}
			return info;
		};

		// For heading-file mode: also track per-targetFile info for the native A→B
		// edge at the file level.  All under-heading refs (bare and fragment) are
		// aggregated here so the native edge can be removed when appropriate.
		// Map<targetFileNodeId, { hasBareLink, hasFragmentRef }>
		type NativeEdgeInfo = { hasBareLink: boolean; hasFragmentRef: boolean };
		const nativeEdgeMap = new Map<string, NativeEdgeInfo>();
		const getOrCreateNativeInfo = (targetId: string): NativeEdgeInfo => {
			let info = nativeEdgeMap.get(targetId);
			if (!info) {
				info = { hasBareLink: false, hasFragmentRef: false };
				nativeEdgeMap.set(targetId, info);
			}
			return info;
		};

		for (const ref of refs) {
			const owning = this.findOwningHeading(headings, ref.position.start.line);

			// Determine whether this ref is in scope for this pass.
			if (anchorSourceAtHeading && !anchorTargetAtHeading) {
				// heading-file: only under-heading refs matter.
				if (!owning) continue;
			} else if (!anchorSourceAtHeading && anchorTargetAtHeading) {
				// file-heading: both file-level AND under-heading refs contribute;
				// all are tracked against the file node as source anchor.
			} else {
				// heading-heading: both file-level AND under-heading refs are
				// handled; each scoped to its own source anchor node.
			}

			const dest = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(ref.link),
				file.path,
			);

			if (!dest) {
				// ── Unresolved target ────────────────────────────────────────────
				// The target file does not exist in the vault.  Fragment rewiring to
				// a ghost heading only applies when the target side is anchored at a
				// heading node (file-heading or heading-heading modes).
				if (!anchorTargetAtHeading) continue;

				const hashIdx = ref.link.indexOf("#");
				if (hashIdx < 0) continue; // bare link to unresolved file — nothing to rewire

				const fragment = ref.link.slice(hashIdx + 1);
				if (fragment.startsWith("^")) continue; // block reference — skip

				const rawPath = getLinkpath(ref.link.slice(0, hashIdx));
				const unresolvedNodeId = this.findUnresolvedNodeId(data, rawPath);
				if (!unresolvedNodeId || !data.nodes[unresolvedNodeId]) continue;

				// Locate the ghost heading node created by injectGhostHeadingNodesForFile
				// (which has already run before this pass).  The ghost ID uses the exact
				// fragment casing from the first link that created it; search
				// case-insensitively among ghostHeadingIds to find the canonical ID.
				const fragmentLower = fragment.toLowerCase();
				const ghostHeadingId =
					[...this.ghostHeadingIds].find(
						(id) =>
							id.startsWith(unresolvedNodeId + "#") &&
							id.slice(unresolvedNodeId.length + 1).toLowerCase() === fragmentLower,
					) ?? null;
				if (!ghostHeadingId || !data.nodes[ghostHeadingId]) continue;

				// Determine the source anchor for this ref.
				const sourceAnchorId =
					anchorSourceAtHeading && owning
						? this.buildHeadingNodeId(nodeId, owning.heading)
						: nodeId;

				const info = getOrCreateInfo(sourceAnchorId, unresolvedNodeId);
				info.headingNodes.add(ghostHeadingId);
				info.hasFragmentRef = true;
				continue;
			}

			const targetFileNodeId = this.resolveGraphNodeId(data, dest);
			if (!targetFileNodeId || !data.nodes[targetFileNodeId]) continue;

			// Determine the source anchor for this ref.
			// For heading-file mode, under-heading refs get a heading anchor;
			// for file-heading mode, all refs use the file node as source anchor.
			const sourceAnchorId =
				anchorSourceAtHeading && owning
					? this.buildHeadingNodeId(nodeId, owning.heading)
					: nodeId;

			const info = getOrCreateInfo(sourceAnchorId, targetFileNodeId);

			const hashIdx = ref.link.indexOf("#");
			if (hashIdx < 0) {
				// No fragment — bare link from this anchor to the file.
				info.hasBareLink = true;
				if (anchorSourceAtHeading && !anchorTargetAtHeading) {
					// Also track at the file level for native edge removal.
					getOrCreateNativeInfo(targetFileNodeId).hasBareLink = true;
				}
				continue;
			}

			const fragment = ref.link.slice(hashIdx + 1);
			if (fragment.startsWith("^")) {
				// Block reference — treat as a bare file link for edge-removal purposes.
				info.hasBareLink = true;
				if (anchorSourceAtHeading && !anchorTargetAtHeading) {
					getOrCreateNativeInfo(targetFileNodeId).hasBareLink = true;
				}
				continue;
			}

			if (anchorTargetAtHeading) {
				// Fragment ref when target is anchored at a heading: resolve to heading node.
				// Only mark hasFragmentRef when the heading node actually exists — if the
				// heading is absent, no rewiring happened and the source→file edge should stay.
				const destCache = this.app.metadataCache.getFileCache(dest);
				const fragmentLower = fragment.toLowerCase();
				const matchedHeading = destCache?.headings?.find(
					(h) => h.heading.toLowerCase() === fragmentLower,
				);
				if (!matchedHeading) continue;

				const headingNodeId = this.buildHeadingNodeId(targetFileNodeId, matchedHeading.heading);
				if (!data.nodes[headingNodeId]) continue;

				info.headingNodes.add(headingNodeId);
				info.hasFragmentRef = true;
			} else {
				// heading-file, under-heading fragment ref: the heading→file edge was
				// already added by injectHeadingNodesForFile; mark as a fragment ref so
				// the heading→file and native A→B edges are removed (unless a bare link
				// coexists at the respective scope).
				info.hasFragmentRef = true;
				getOrCreateNativeInfo(targetFileNodeId).hasFragmentRef = true;
			}
		}

		// Apply rewiring: for each (sourceAnchor, target) pair with fragment refs,
		// add any pending heading edges and conditionally remove the
		// sourceAnchor→targetFile edge.
		for (const [sourceAnchorId, targetMap] of anchorTargets) {
			const sourceAnchorNode = data.nodes[sourceAnchorId];
			if (!sourceAnchorNode) continue;

			for (const [targetFileNodeId, info] of targetMap) {
				// Add sourceAnchor → targetHeadingNode edges.
				for (const headingNodeId of info.headingNodes) {
					sourceAnchorNode.links[headingNodeId] = true;
				}

				// Remove the sourceAnchor → targetFile edge only when:
				//   - at least one fragment ref was seen (the rewiring has something to replace), and
				//   - there is no bare link from this anchor to this target file.
				if (info.hasFragmentRef && !info.hasBareLink) {
					delete sourceAnchorNode.links[targetFileNodeId];
				}
			}
		}

		// For heading-file mode: also remove the native file→file edge when all
		// under-heading refs to a given target are fragment refs (no bare link).
		if (anchorSourceAtHeading && !anchorTargetAtHeading) {
			const sourceNode = data.nodes[nodeId];
			if (sourceNode) {
				for (const [targetFileNodeId, nInfo] of nativeEdgeMap) {
					if (nInfo.hasFragmentRef && !nInfo.hasBareLink) {
						delete sourceNode.links[targetFileNodeId];
					}
				}
			}
		}
	}

	/**
	 * Scans every wikilink / embed in `nodeId`'s source file for references that
	 * contain a `#` fragment pointing to a heading that does not yet exist in the
	 * target file's metadata cache, and inserts a ghost heading node for each
	 * missing heading.
	 *
	 * @param data   Mutable graph data object being built during this setData pass.
	 * @param nodeId Graph node ID of the source Markdown file.
	 *
	 * @remarks
	 * Ghost heading nodes are ALWAYS created when heading nodes are shown — the
	 * `headingLinkAnchorMode` setting only governs how the link EDGES are
	 * anchored (see `rewireFragmentLinksForFile`), never whether the ghost
	 * heading is displayed.
	 *
	 * This method must be called AFTER `injectHeadingNodesForFile` for all source
	 * files so that real heading nodes are already in `data.nodes` when the
	 * deduplication check runs.  If the derived ID already exists in `data.nodes`
	 * (because the real heading injection created it), no ghost node is added.
	 *
	 * Block-reference fragments (beginning with `^`) are intentionally ignored:
	 * they do not correspond to Markdown headings.
	 *
	 * Ghost heading nodes are attached to the TARGET file node (not the source),
	 * registered as structural children in `StructuralHierarchy`, and recorded in
	 * `ghostHeadingIds`.  Clicking a ghost heading in the graph will insert the
	 * corresponding heading at the end of the target file.
	 *
	 * When the target file does NOT resolve (unresolved wikilink), the ghost
	 * heading is attached to the unresolved node already present in `data.nodes`.
	 * The unresolved node ID is looked up using the same resolution strategy as
	 * `resolveGraphNodeId`: full path with/without `.md`, then basename.  If no
	 * matching node is found the link is ignored silently.  Clicking such a ghost
	 * heading creates the target file with the heading as its only content (see
	 * `GraphInteractions.createGhostHeading`).
	 *
	 * @example
	 * // Source file "notes/index.md" contains [[guide#Installation]] but
	 * // "docs/guide.md" has no heading "Installation":
	 * //
	 * // After injectGhostHeadingNodesForFile(data, "notes/index"):
	 * // data.nodes["docs/guide#Installation"] = { type: "f2g_heading_node", links: {} }
	 * // data.nodes["docs/guide"].links["docs/guide#Installation"] = true
	 * // ghostHeadingIds contains "docs/guide#Installation"
	 *
	 * @example
	 * // Source file "notes/index.md" contains [[/a/b/c#missing]] and the file
	 * // does not exist in the vault.  Obsidian stores the unresolved node as
	 * // e.g. "/a/b/c.md" or "/a/b/c" in data.nodes:
	 * //
	 * // After injectGhostHeadingNodesForFile(data, "notes/index"):
	 * // data.nodes["/a/b/c#missing"] = { type: "f2g_heading_node", links: {} }
	 * // data.nodes["/a/b/c"].links["/a/b/c#missing"] = true
	 * // ghostHeadingIds contains "/a/b/c#missing"
	 */
	private injectGhostHeadingNodesForFile(data: RendererData, nodeId: string): void {
		const file = this.app.metadataCache.getFirstLinkpathDest(nodeId, "");
		if (!file || file.extension !== "md") return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return;

		const refs = [...(cache.links ?? []), ...(cache.embeds ?? [])];

		for (const ref of refs) {
			const rawLink = ref.link;

			// Only process links that contain a heading fragment.
			const hashIdx = rawLink.indexOf("#");
			if (hashIdx < 0) continue;

			const targetPart = rawLink.slice(0, hashIdx);
			const fragment = rawLink.slice(hashIdx + 1);

			// Ignore block references — they start with `^`.
			if (fragment.startsWith("^")) continue;

			// Try to resolve the target file via the metadata cache.
			const targetFile = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(targetPart),
				file.path,
			);

			if (targetFile && targetFile.extension === "md") {
				// ── Resolved target ──────────────────────────────────────────────
				// Determine the graph node ID for the target file.
				const targetNodeId = this.resolveGraphNodeId(data, targetFile);
				if (!targetNodeId || !data.nodes[targetNodeId]) continue;

				// Check whether the target file already has this heading in its cache.
				// Comparison is case-insensitive: Obsidian resolves [[note#introduction]]
				// to the heading "## Introduction", so a case-only difference must not
				// produce a duplicate ghost node.
				const targetCache = this.app.metadataCache.getFileCache(targetFile);
				const existingHeadings = targetCache?.headings ?? [];
				const fragmentLower = fragment.toLowerCase();
				const headingExists = existingHeadings.some(
					(h) => h.heading.toLowerCase() === fragmentLower,
				);
				if (headingExists) continue;

				// Build and register the ghost heading node.
				const ghostId = this.buildHeadingNodeId(targetNodeId, fragment);
				if (data.nodes[ghostId]) continue;

				data.nodes[ghostId] = { type: HEADING_NODE_TAG, links: {} };
				data.nodes[targetNodeId].links[ghostId] = true;
				this.hierarchy.addChild(targetNodeId, ghostId);
				this.ghostHeadingIds.add(ghostId);
			} else {
				// ── Unresolved target ────────────────────────────────────────────
				// The target file does not exist in the vault yet.  Look for the
				// unresolved node in data.nodes using the shared helper, which
				// applies the same candidate set as resolveGraphNodeId.
				const rawPath = getLinkpath(targetPart);
				const unresolvedNodeId = this.findUnresolvedNodeId(data, rawPath);

				if (!unresolvedNodeId) continue;

				const ghostId = this.buildHeadingNodeId(unresolvedNodeId, fragment);
				if (data.nodes[ghostId]) continue;

				data.nodes[ghostId] = { type: HEADING_NODE_TAG, links: {} };
				data.nodes[unresolvedNodeId].links[ghostId] = true;
				this.hierarchy.addChild(unresolvedNodeId, ghostId);
				this.ghostHeadingIds.add(ghostId);
			}
		}
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
	 * Looks up the graph node ID for an unresolved wikilink target using the
	 * same candidate set as `resolveGraphNodeId`, applied to a raw linkpath
	 * string rather than a `TFile`.
	 *
	 * @param data    Mutable graph data object.
	 * @param rawPath Raw linkpath string (as returned by `getLinkpath`), e.g.
	 *   `"/a/b/c.md"` or `"/a/b/c"` or `"c"`.
	 * @returns The matching graph node ID, or `null` when no candidate is found.
	 *
	 * @remarks
	 * Candidates tried in order (matching `resolveGraphNodeId`):
	 * 1. `rawPath` as-is (e.g. `"/a/b/c.md"`).
	 * 2. `rawPath` without `.md` extension (e.g. `"/a/b/c"`).
	 * 3. Basename only, without `.md` (e.g. `"c"`).
	 *
	 * This method is the single source of truth for unresolved-node lookup and
	 * is shared by both `injectGhostHeadingNodesForFile` and
	 * `rewireFragmentLinksForFile` so the two passes always agree on which node
	 * to attach ghost headings to.
	 */
	private findUnresolvedNodeId(data: RendererData, rawPath: string): Nullable<string> {
		if (data.nodes[rawPath]) return rawPath;
		const noExtPath = rawPath.endsWith(".md") ? rawPath.slice(0, -3) : null;
		if (noExtPath && data.nodes[noExtPath]) return noExtPath;
		const lastSlash = rawPath.lastIndexOf("/");
		const lastSegment = lastSlash >= 0 ? rawPath.slice(lastSlash + 1) : rawPath;
		const baseName = lastSegment.endsWith(".md") ? lastSegment.slice(0, -3) : lastSegment;
		if (data.nodes[baseName]) return baseName;
		return null;
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
	 * @param nodeId Graph node ID of the file or folder. May begin with a `/`
	 *   (e.g. unresolved wikilinks such as `"/a/b/c.md"`); leading-slash IDs
	 *   produce an empty first segment after `split("/")` which is filtered out
	 *   before the cumulative path is built.
	 * @returns Array of `/`-prefixed folder paths from root to the immediate
	 *   parent, in ascending depth order.
	 *
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = getNodeParentFolders(nodeId);
	 * // result = ["/", "/folder", "/folder/subfolder"]
	 *
	 * @example
	 * // Unresolved wikilink with leading slash — empty segments filtered out.
	 * const nodeId = "/a/b/c.md";
	 * const result = getNodeParentFolders(nodeId);
	 * // result = ["/", "/a", "/a/b"]
	 */
	private getNodeParentFolders(nodeId: string): string[] {
		const subFolders = ["/"];

		const splittedNodeId = nodeId.split("/");
		// Filter empty segments that arise from a leading "/" (unresolved wikilinks
		// such as "/a/b/c.md" produce ["", "a", "b", "c.md"] after split).
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1).filter((e) => e !== "");

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
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1).filter((e) => e !== "");

		return `/${subFoldersSteps.join("/")}`;
	}
}
