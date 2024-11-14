export type GraphNode = {
	type: string;
	links: Record<string, boolean>;
	folderNode?: boolean;
};
