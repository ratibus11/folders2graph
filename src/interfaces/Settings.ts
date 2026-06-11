export type Settings = {
	showFolderNodes: boolean;
	hideRootNode: boolean;
	nodeColor: string;
	showHeadingNodes: boolean;
	headingNodeColor: string;
	/** Node IDs that are hidden because a structural ancestor was collapsed by the user.
	 * Persists across restarts so the collapsed state survives a vault reload. */
	hiddenNodes: Record<string, boolean>;
};
