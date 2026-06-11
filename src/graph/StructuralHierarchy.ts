import { Settings } from "interfaces/Settings";

/**
 * Manages the structural parent/child maps for the graph hierarchy.
 *
 * This class is pure state — it has no Obsidian dependency. It tracks which
 * nodes are structural parents/children (folders contain files; files contain
 * headings) and provides collapsed-state queries used by the renderer.
 *
 * @remarks
 * "Structural" relationships are hierarchy links injected by this plugin:
 * - folder → direct child folder
 * - folder → file it contains
 * - file → root heading
 * - heading → direct sub-heading
 *
 * Regular note-to-note wikilinks are NOT structural and are never registered
 * here.
 */
export class StructuralHierarchy {
	/** For every node ID, the list of IDs that are its direct structural children
	 * (sub-folders, direct files, or headings). */
	private children: Record<string, string[]> = {};

	/** Inverse of `children`: maps each child node ID to its structural parent. */
	private parent: Record<string, string> = {};

	/** Pre-computed set of node IDs that are currently fully collapsed. Updated
	 * by `computeCollapsedSet` once per setData for O(1) frame-time lookups. */
	private collapsedNodeIds: Set<string> = new Set();

	/**
	 * Maps each node ID that has structural children to its total number of
	 * visible structural descendants at all depths (direct + indirect). Leaf
	 * nodes have no entry — their accessors fall back to `0`. Updated by
	 * `computeVisibleDescendantCounts` once per setData.
	 */
	private visibleDescendantCounts: Map<string, number> = new Map();

	/**
	 * Maps each node ID to the count of visible structural descendants that are
	 * NOT direct children (i.e. total visible descendants minus visible direct
	 * children). Updated by `computeVisibleDescendantCounts` once per setData.
	 * Used by `getSize` patching for an O(1) lookup per call.
	 */
	private indirectVisibleDescendantCounts: Map<string, number> = new Map();

	/** Reference to plugin settings, used to read `hiddenNodes`. */
	private settings: Settings;

	/**
	 * @param settings Plugin settings object. The instance is shared with the
	 *   plugin so mutations to `settings.hiddenNodes` are visible here without
	 *   re-injection.
	 */
	constructor(settings: Settings) {
		this.settings = settings;
	}

	/**
	 * Clears the relationship maps and every pre-computed cache (collapsed set,
	 * visible descendant counts) in preparation for a fresh setData pass.
	 *
	 * @remarks
	 * Must be called at the start of every `GraphDataInjector.install` callback
	 * so stale relationships from the previous graph state are not carried over.
	 */
	reset(): void {
		this.children = {};
		this.parent = {};
		this.collapsedNodeIds = new Set();
		this.visibleDescendantCounts = new Map();
		this.indirectVisibleDescendantCounts = new Map();
	}

	/**
	 * Registers `childId` as a structural child of `parentId` in both maps.
	 *
	 * @param parentId ID of the structural parent node.
	 * @param childId  ID of the structural child node.
	 *
	 * @remarks
	 * Self-relationships are silently ignored: the root folder `/` is its own
	 * computed parent (`getNodeParentFolder("/")` returns `/`), and registering
	 * it as its own child would cause folding the root to hide the root node
	 * itself.
	 *
	 * @example
	 * // Register a folder → file relationship.
	 * hierarchy.addChild("/projects", "projects/tasks.md");
	 * // hierarchy.getChildren("/projects") = ["projects/tasks.md"]
	 * // hierarchy.getParent("projects/tasks.md") = "/projects"
	 *
	 * @example
	 * // Self-reference (vault root) is silently ignored.
	 * hierarchy.addChild("/", "/");
	 * // hierarchy.getChildren("/") = []  (unchanged)
	 */
	addChild(parentId: string, childId: string): void {
		if (parentId === childId) return;
		if (!this.children[parentId]) {
			this.children[parentId] = [];
		}
		this.children[parentId].push(childId);
		this.parent[childId] = parentId;
	}

	/**
	 * Returns all structural descendants of `nodeId` via an iterative
	 * depth-first traversal of the children map.
	 *
	 * @param nodeId The node whose subtree is to be collected.
	 * @returns Flat array of all descendant node IDs in DFS order; empty when
	 *   `nodeId` has no registered children.
	 *
	 * @remarks
	 * A `visited` Set guards against accidental cycles in the children map,
	 * which should never occur in normal use but could arise from corrupted
	 * state.
	 *
	 * @example
	 * // Given the tree:  /work  →  work/project  →  work/project/note.md
	 * //                                           →  work/project/readme.md
	 * hierarchy.addChild("/work", "work/project");
	 * hierarchy.addChild("work/project", "work/project/note.md");
	 * hierarchy.addChild("work/project", "work/project/readme.md");
	 *
	 * const result = hierarchy.getAllDescendants("/work");
	 * // result contains ["work/project", "work/project/readme.md", "work/project/note.md"]
	 * // (DFS order; exact ordering depends on stack pop sequence)
	 *
	 * const empty = hierarchy.getAllDescendants("work/project/note.md");
	 * // empty = []
	 */
	getAllDescendants(nodeId: string): string[] {
		const descendants: string[] = [];
		const visited = new Set<string>();
		const stack: string[] = [...(this.children[nodeId] ?? [])];

		while (stack.length > 0) {
			const current = stack.pop()!;
			if (visited.has(current)) continue;
			visited.add(current);
			descendants.push(current);
			const kids = this.children[current];
			if (kids) {
				for (const child of kids) {
					stack.push(child);
				}
			}
		}

		return descendants;
	}

	/**
	 * Returns the direct structural children of `nodeId`.
	 *
	 * @param nodeId The node to query.
	 * @returns The children array, or an empty array if none are registered.
	 */
	getChildren(nodeId: string): string[] {
		return this.children[nodeId] ?? [];
	}

	/**
	 * Returns the structural parent ID of `nodeId`.
	 *
	 * @param nodeId The node to query.
	 * @returns The parent node ID, or `undefined` if `nodeId` is a root-level
	 *   node with no registered parent.
	 */
	getParent(nodeId: string): string | undefined {
		return this.parent[nodeId];
	}

	/**
	 * Returns true if `nodeId` is fully collapsed: it has at least one
	 * structural child and every descendant is present in
	 * `settings.hiddenNodes`.
	 *
	 * @param nodeId The node to test.
	 *
	 * @remarks
	 * For frame-time use, prefer `isCollapsed(nodeId)` after
	 * `computeCollapsedSet` has been called for the current graph data.
	 */
	private isNodeCollapsed(nodeId: string): boolean {
		const kids = this.children[nodeId];
		if (!kids || kids.length === 0) return false;
		const descendants = this.getAllDescendants(nodeId);
		if (descendants.length === 0) return false;
		return descendants.every((id) => this.settings.hiddenNodes[id]);
	}

	/**
	 * Builds the full set of collapsed node IDs from the current children map
	 * and `settings.hiddenNodes`, replacing `collapsedNodeIds`.
	 *
	 * @remarks
	 * Called once per `setData` pass by `GraphDataInjector` so that
	 * `NodePrototypePatcher`'s render override can do O(1)
	 * `isCollapsed(id)` lookups instead of recomputing per node per frame.
	 *
	 * @example
	 * // Hierarchy: /src → src/index.md, src/utils.md
	 * // hiddenNodes = { "src/index.md": true, "src/utils.md": true }
	 * // (all descendants of "/src" are hidden)
	 *
	 * hierarchy.computeCollapsedSet();
	 * hierarchy.isCollapsed("/src");
	 * // true  — both children are hidden
	 *
	 * // If only one child is hidden:
	 * // hiddenNodes = { "src/index.md": true }
	 * hierarchy.computeCollapsedSet();
	 * hierarchy.isCollapsed("/src");
	 * // false — src/utils.md is still visible
	 */
	computeCollapsedSet(): void {
		const collapsed = new Set<string>();
		for (const nodeId of Object.keys(this.children)) {
			if (this.isNodeCollapsed(nodeId)) {
				collapsed.add(nodeId);
			}
		}
		this.collapsedNodeIds = collapsed;
	}

	/**
	 * Returns true if `nodeId` is in the pre-computed collapsed set.
	 *
	 * @param nodeId The node to test.
	 * @returns `true` when every structural descendant of `nodeId` is hidden.
	 *
	 * @remarks
	 * Only accurate after `computeCollapsedSet` has been called for the
	 * current graph data. Used in the PIXI render override to decide whether
	 * to draw the half-disc.
	 *
	 * @example
	 * // After computeCollapsedSet() with hiddenNodes covering all of /src's descendants:
	 * hierarchy.isCollapsed("/src");
	 * // true  — renders as a half-disc
	 *
	 * hierarchy.isCollapsed("src/index.md");
	 * // false — leaf node (no children), never considered collapsed
	 */
	isCollapsed(nodeId: string): boolean {
		return this.collapsedNodeIds.has(nodeId);
	}

	/**
	 * Performs a bottom-up memoised DFS over the structural children map to
	 * compute, for each node, the total number of visible structural descendants
	 * at all depths and the subset that are indirect (non-direct-child)
	 * descendants. Results are stored in `visibleDescendantCounts` and
	 * `indirectVisibleDescendantCounts` for O(1) lookups at frame time.
	 *
	 * @remarks
	 * A child present in `settings.hiddenNodes` is pruned along with its entire
	 * sub-tree: if the child is hidden, none of its descendants are counted
	 * either. This correctly models the "folded node shrinks" behaviour: when all
	 * descendants are hidden (folded), the indirect count drops to zero and the
	 * node reverts to its native size.
	 *
	 * Called once per `setData` pass by `GraphDataInjector`, immediately after
	 * `computeCollapsedSet`.
	 *
	 * @example
	 * // Hierarchy:
	 * //   /work  →  work/project  →  work/project/note.md   (visible)
	 * //                           →  work/project/old.md    (hidden)
	 * //
	 * // hiddenNodes = { "work/project/old.md": true }
	 * //
	 * // After computeVisibleDescendantCounts():
	 * //   visibleDescendantCounts("/work")        = 2  (work/project + note.md)
	 * //   indirectVisibleDescendantCounts("/work") = 1  (note.md is indirect for /work)
	 * //   visibleDescendantCounts("work/project") = 1  (note.md only)
	 * //   indirectVisibleDescendantCounts("work/project") = 0
	 */
	computeVisibleDescendantCounts(): void {
		this.visibleDescendantCounts = new Map();
		this.indirectVisibleDescendantCounts = new Map();

		// Memoised recursive helper: returns total visible descendant count for nodeId.
		// The `computing` set tracks nodes currently on the recursion stack: memoisation
		// alone would not terminate on an accidental cycle (the cache entry is only
		// written AFTER the recursion returns), so — like `getAllDescendants` — we guard
		// defensively against corrupted state by treating a back-edge as zero.
		const computing = new Set<string>();
		const countFor = (nodeId: string): number => {
			const cached = this.visibleDescendantCounts.get(nodeId);
			if (cached !== undefined) return cached;
			if (computing.has(nodeId)) return 0;

			const kids = this.children[nodeId];
			if (!kids || kids.length === 0) {
				this.visibleDescendantCounts.set(nodeId, 0);
				this.indirectVisibleDescendantCounts.set(nodeId, 0);
				return 0;
			}

			computing.add(nodeId);
			let total = 0;
			let directVisible = 0;
			for (const childId of kids) {
				if (this.settings.hiddenNodes[childId]) {
					// Child is hidden — prune the entire sub-tree.
					continue;
				}
				directVisible++;
				total += 1 + countFor(childId);
			}
			computing.delete(nodeId);

			this.visibleDescendantCounts.set(nodeId, total);
			this.indirectVisibleDescendantCounts.set(nodeId, total - directVisible);
			return total;
		};

		for (const nodeId of Object.keys(this.children)) {
			countFor(nodeId);
		}
	}

	/**
	 * Returns the number of visible structural descendants of `nodeId` that are
	 * NOT direct children (i.e. grandchildren and deeper). Used by the
	 * `getSize` patch to inflate `weight` without double-counting the direct
	 * children that Obsidian already counts natively via displayed edges.
	 *
	 * @param nodeId The node to query.
	 * @returns The indirect visible descendant count, or `0` when the node has
	 *   none or the counts have not been computed yet.
	 *
	 * @remarks
	 * Only accurate after `computeVisibleDescendantCounts` has been called for
	 * the current graph data.
	 *
	 * @example
	 * // Hierarchy: /work → work/project → work/project/note.md (all visible)
	 * // After computeVisibleDescendantCounts():
	 * hierarchy.getIndirectVisibleDescendantCount("/work");
	 * // 1  — work/project/note.md is an indirect descendant of /work
	 *
	 * hierarchy.getIndirectVisibleDescendantCount("work/project");
	 * // 0  — work/project/note.md is a direct child, not indirect
	 */
	getIndirectVisibleDescendantCount(nodeId: string): number {
		return this.indirectVisibleDescendantCounts.get(nodeId) ?? 0;
	}

	/**
	 * Returns true if at least one structural descendant of `nodeId` is
	 * currently hidden in `settings.hiddenNodes`.
	 *
	 * @param nodeId The node to test.
	 *
	 * @remarks
	 * Used by both the PIXI right-click wrapper (to decide whether to swallow
	 * the gesture) and `FoldingManager.handleRecursiveUnfold` (to decide
	 * whether there is anything to reveal).
	 *
	 * @example
	 * // Hierarchy: /docs → docs/guide.md → docs/guide.md#Introduction
	 * // hiddenNodes = { "docs/guide.md#Introduction": true }
	 *
	 * hierarchy.hasHiddenDescendant("/docs");
	 * // true  — a grandchild is hidden
	 *
	 * hierarchy.hasHiddenDescendant("docs/guide.md");
	 * // true  — a direct child (the heading node) is hidden
	 *
	 * hierarchy.hasHiddenDescendant("docs/guide.md#Introduction");
	 * // false — leaf node, no descendants at all
	 */
	hasHiddenDescendant(nodeId: string): boolean {
		return this.getAllDescendants(nodeId).some((id) => this.settings.hiddenNodes[id]);
	}
}
