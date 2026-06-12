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
	/**
	 * Controls how `folderFilterList` is applied to folder node injection.
	 *
	 * - `"exclude"` — all folders are injected except those covered by the list.
	 * - `"include"` — only folders covered by the list receive injected nodes.
	 *
	 * Has no effect when `folderFilterList` is empty. Defaults to `"exclude"`.
	 */
	folderFilterMode: "include" | "exclude";
	/**
	 * Vault-relative folder paths used to filter folder node injection.
	 *
	 * @remarks
	 * Paths are stored normalised: no leading or trailing slash, forward-slash
	 * separator (e.g. `"work/projects"`). An entry covers its own folder and
	 * all of its descendants recursively. An empty array disables filtering
	 * entirely, regardless of `folderFilterMode`. Entries that do not match any
	 * vault folder are silently ignored — no vault lookup is performed at
	 * match time.
	 */
	folderFilterList: string[];
	/**
	 * Controls how wikilinks that reference a specific heading (`[[note#Heading]]`)
	 * are represented as graph edges when `showHeadingNodes` is `true`.
	 *
	 * @remarks
	 * Only affects links that contain a `#` fragment pointing to a heading.
	 * Block-reference fragments (beginning with `^`) are always treated as bare
	 * file links regardless of this setting.  Has no effect when
	 * `showHeadingNodes` is `false`.
	 *
	 * For a link `[[B#Section]]` written in file A (optionally under heading H):
	 *
	 * - `"file-file"` — no intervention; the native A→B edge is preserved as-is.
	 *   Ghost heading nodes are NOT created for missing fragments (the target side
	 *   is anchored at the file level).
	 * - `"file-heading"` — the edge becomes A→B#Section (real heading text,
	 *   case-insensitive match).  The native A→B edge is removed unless A also
	 *   has a bare (fragment-free) link to B.  Even when the ref sits under a
	 *   heading source, the source anchor remains the file.  Ghost heading nodes
	 *   are created when the target heading is missing.
	 * - `"heading-file"` — for refs under a source heading H, the edge becomes
	 *   A#H→B (target anchored at the file).  The native A→B edge is removed
	 *   under the same bare-link rule.  Refs at the file level keep the native
	 *   A→B edge unchanged.  Ghost heading nodes are NOT created (target is file).
	 * - `"heading-heading"` — current default behaviour: under heading H, the
	 *   edge is A#H→B#Section; at the file level, A→B#Section.  Native edge
	 *   removed unless a bare link coexists.  Ghost heading nodes created.
	 *
	 * Defaults to `"heading-heading"`.
	 */
	headingLinkAnchorMode: "file-file" | "file-heading" | "heading-file" | "heading-heading";
	/**
	 * When `true`, files that fall outside the folder filter scope are removed
	 * from the graph entirely (along with their heading nodes and any incoming
	 * links) instead of remaining as disconnected native nodes.
	 *
	 * @remarks
	 * "Outside the filter scope" means:
	 * - **Exclude mode** — the file lives inside a subtree covered by the list.
	 * - **Include mode** — no entry in the list covers the file's containing
	 *   folder.
	 *
	 * When `false` (default), filtered-out files stay in the graph as ordinary
	 * Obsidian nodes; they simply receive no folder parent edge.
	 *
	 * Has no effect when `folderFilterList` is empty, because there is no
	 * "outside the scope" in that case. Defaults to `false`.
	 */
	folderFilterHideFiles: boolean;
};
