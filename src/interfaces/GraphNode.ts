/**
 * Represents a single node in the graph data passed to Obsidian's renderer via
 * `setData`.
 *
 * @remarks
 * The `type` field is used by the plugin to distinguish injected folder nodes
 * (`f2g_node`) and heading nodes (`f2g_heading_node`) from native file nodes.
 * The `folderNode` flag provides a secondary marker used when iterating the
 * node map to build structural links (a folder node whose `folderNode` is
 * `true` is treated as a regular child for link-wiring purposes).
 */
export type GraphNode = {
	/** Node type tag. Native file nodes have an empty string or Obsidian-internal
	 * value; injected folder nodes use `"f2g_node"`; heading nodes use
	 * `"f2g_heading_node"`. */
	type: string;
	/** Map from target node ID to `true`, representing outgoing graph links. */
	links: Record<string, boolean>;
	/** Present and `true` on injected folder nodes. */
	folderNode?: boolean;
};
