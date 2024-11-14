import { GraphNode } from "./GraphNode";

export type RendererData = {
	numLinks: number;
	nodes: Record<string, GraphNode>;
};
