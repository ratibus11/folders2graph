import { GraphNode } from "./GraphNode";

export interface RendererData {
	numLinks: number;
	nodes: Record<string, GraphNode>;
}
