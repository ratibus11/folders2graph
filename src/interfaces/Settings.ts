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
	/**
	 * Node IDs that are hidden because a structural ancestor was collapsed by the user.
	 * Persists across restarts so the collapsed state survives a vault reload.
	 *
	 * @example
	 * // After the user Shift+clicks the "/projects" folder node to collapse it,
	 * // and the "/projects/archive" sub-folder was already collapsed independently:
	 * hiddenNodes = {
	 *   "projects/roadmap.md": true,
	 *   "projects/archive": true,
	 *   "projects/archive/old-spec.md": true,
	 * }
	 * // Folder IDs are `/`-prefixed; file IDs are plain paths or basenames;
	 * // heading IDs use the `path#heading` wikilink format.
	 */
	hiddenNodes: Record<string, boolean>;
	/**
	 * When `true`, the display size of a node reflects all of its visible
	 * structural descendants at every depth, not just its direct visible children.
	 * Folding a node causes its descendants to disappear, which reduces its
	 * weight and therefore its size. Defaults to `false`.
	 *
	 * @remarks
	 * Obsidian natively scales node size by the number of displayed edges
	 * (`weight`). This setting adds the indirect visible descendant count on top
	 * of that so deeply nested sub-trees push the ancestor's size higher.
	 */
	weightNodesBySubtree: boolean;
};
