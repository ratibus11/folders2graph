/**
 * Persistent plugin settings stored in Obsidian's data store.
 *
 * @remarks
 * All settings are read by `Folders2GraphPlugin.settings` and written through
 * `Folders2GraphPlugin.saveSettings`. The `SettingsTab` reads and mutates this
 * object directly via `plugin.settings`.
 */
export type Settings = {
	/** Whether to inject virtual folder nodes into the graph. Defaults to `true`. */
	showFolderNodes: boolean;
	/** Whether to hide the vault-root folder node (`"/"`). Defaults to `false`. */
	hideRootNode: boolean;
	/** CSS hex colour string for folder nodes (e.g. `"#5c8af5"`). */
	nodeColor: string;
	/** Whether to inject heading nodes derived from Markdown files. Defaults to `false`. */
	showHeadingNodes: boolean;
	/** CSS hex colour string for heading nodes (e.g. `"#f5a55c"`). */
	headingNodeColor: string;
	/** Node IDs that are hidden because a structural ancestor was collapsed by the user.
	 * Persists across restarts so the collapsed state survives a vault reload. */
	hiddenNodes: Record<string, boolean>;
};
