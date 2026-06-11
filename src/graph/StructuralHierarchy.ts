import { Settings } from "interfaces/Settings";

/**
 * Manages the structural parent/child maps for the graph hierarchy.
 *
 * This class is pure state — it has no Obsidian dependency. It tracks which
 * nodes are structural parents/children (folders contain files; files contain
 * headings) and provides collapsed-state queries used by the renderer.
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

	constructor(settings: Settings) {
		this.settings = settings;
	}

	/** Clears both maps in preparation for a fresh setData pass. */
	reset(): void {
		this.children = {};
		this.parent = {};
	}

	/**
	 * Registers `childId` as a structural child of `parentId` in both maps.
	 *
	 * Self-relationships are ignored: the root folder `/` is its own computed
	 * parent (`getNodeParentFolder("/")` returns `/`), and registering it as its
	 * own child would make folding the root hide the root node itself.
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
	 * depth-first traversal of the children map. A `visited` Set guards
	 * against accidental cycles.
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
	 * Returns the direct structural children of `nodeId`, or an empty array if
	 * none are registered.
	 */
	getChildren(nodeId: string): string[] {
		return this.children[nodeId] ?? [];
	}

	/**
	 * Returns the structural parent ID of `nodeId`, or `undefined` if `nodeId`
	 * is a root-level node with no registered parent.
	 */
	getParent(nodeId: string): string | undefined {
		return this.parent[nodeId];
	}

	/**
	 * Returns true if `nodeId` is fully collapsed: it has at least one
	 * structural child and every descendant is present in `settings.hiddenNodes`.
	 * For frame-time use, prefer `isCollapsed(nodeId)` after `computeCollapsedSet`.
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
	 * and `settings.hiddenNodes`. Call this once per setData so frame-time
	 * rendering can do O(1) `isCollapsed(id)` lookups.
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
	 * Only accurate after `computeCollapsedSet` has been called for the
	 * current graph data.
	 */
	isCollapsed(nodeId: string): boolean {
		return this.collapsedNodeIds.has(nodeId);
	}

	/**
	 * Returns true if at least one structural descendant of `nodeId` is
	 * currently hidden in `settings.hiddenNodes`.
	 */
	hasHiddenDescendant(nodeId: string): boolean {
		return this.getAllDescendants(nodeId).some((id) => this.settings.hiddenNodes[id]);
	}
}
