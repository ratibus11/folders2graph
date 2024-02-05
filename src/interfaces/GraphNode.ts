export interface GraphNode {
	type: string;
	links: Record<string, boolean>;
	folderNode?: boolean;
}
