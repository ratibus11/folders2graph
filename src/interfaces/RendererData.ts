import { GraphNode } from "./GraphNode";

/**
 * The data object passed to Obsidian's internal graph renderer via `setData`.
 *
 * @remarks
 * This is the shape of the argument that Obsidian passes to the internal
 * `renderer.setData` method. The plugin intercepts this call to inject virtual
 * folder and heading nodes before forwarding to the original implementation.
 */
export type RendererData = {
	/** Total number of links across all nodes. */
	numLinks: number;
	/** Map from node ID to node data. The plugin mutates this map in-place to
	 * add virtual nodes and to remove hidden ones before forwarding to the
	 * original `setData`. */
	nodes: Record<string, GraphNode>;
};
