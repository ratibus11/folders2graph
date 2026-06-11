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
	 * Clears both maps in preparation for a fresh setData pass.
	 *
	 * @remarks
	 * Must be called at the start of every `GraphDataInjector.install` callback
	 * so stale relationships from the previous graph state are not carried over.
	 */
	reset(): void {
		this.children = {};
		this.parent = {};
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
	 */
	isCollapsed(nodeId: string): boolean {
		return this.collapsedNodeIds.has(nodeId);
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
	 */
	hasHiddenDescendant(nodeId: string): boolean {
		return this.getAllDescendants(nodeId).some((id) => this.settings.hiddenNodes[id]);
	}
}
