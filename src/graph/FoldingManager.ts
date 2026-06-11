import { App, TFolder } from "obsidian";
import { Settings } from "interfaces/Settings";
import { StructuralHierarchy } from "graph/StructuralHierarchy";

/**
 * Handles fold/unfold operations on graph nodes and persistence of the
 * collapsed state.
 *
 * `FoldingManager` reads and mutates `settings.hiddenNodes`, then delegates
 * persistence to the `save` callback and graph refresh to the `refresh`
 * callback — keeping it decoupled from the plugin lifecycle.
 *
 * @remarks
 * All fold operations persist the result via `save` and immediately trigger
 * `refresh` so the graph view reflects the new state without requiring the
 * user to do anything.
 */
export class FoldingManager {
	private app: App;
	private settings: Settings;
	private hierarchy: StructuralHierarchy;
	private save: () => Promise<void>;
	private refresh: () => void;

	/**
	 * @param app       Obsidian application instance, used for vault lookups in `purge`.
	 * @param settings  Plugin settings whose `hiddenNodes` map is mutated directly.
	 * @param hierarchy Structural hierarchy used to traverse parent/child relationships.
	 * @param save      Callback that persists `settings` to disk; called after every
	 *   state change.
	 * @param refresh   Callback that re-renders all graph leaves; called after every
	 *   state change.
	 */
	constructor(
		app: App,
		settings: Settings,
		hierarchy: StructuralHierarchy,
		save: () => Promise<void>,
		refresh: () => void,
	) {
		this.app = app;
		this.settings = settings;
		this.hierarchy = hierarchy;
		this.save = save;
		this.refresh = refresh;
	}

	/**
	 * Handles Shift+left-click on a node: fold, or unfold one level.
	 *
	 * @param nodeId The node that was Shift+clicked.
	 *
	 * @remarks
	 * Behaviour by current state:
	 * - **No structural children** → no-op.
	 * - **All descendants hidden** (fully folded) → unfold ONE level: the
	 *   direct children are removed from `hiddenNodes`; each child keeps its
	 *   own folded state, so there is no recursion.
	 * - **Otherwise** (fully or partially visible) → fold: every structural
	 *   descendant is added to `hiddenNodes`.
	 *
	 * A single descendant traversal is used to derive the folded state and to
	 * apply the change.
	 *
	 * @example
	 * // Case 1 — all descendants visible → fold (hide all descendants).
	 * // Hierarchy: /notes → notes/a.md, notes/b.md
	 * // Before: hiddenNodes = {}
	 * foldingManager.handleFoldToggle("/notes");
	 * // After:  hiddenNodes = { "notes/a.md": true, "notes/b.md": true }
	 *
	 * @example
	 * // Case 2 — partially visible → fold (same behaviour as case 1).
	 * // Before: hiddenNodes = { "notes/a.md": true }
	 * foldingManager.handleFoldToggle("/notes");
	 * // After:  hiddenNodes = { "notes/a.md": true, "notes/b.md": true }
	 *
	 * @example
	 * // Case 3 — fully folded → unfold ONE level (direct children only).
	 * // Hierarchy: /notes → notes/sub (which itself has notes/sub/deep.md hidden)
	 * // Before: hiddenNodes = { "notes/sub": true, "notes/sub/deep.md": true }
	 * foldingManager.handleFoldToggle("/notes");
	 * // After:  hiddenNodes = { "notes/sub/deep.md": true }
	 * // notes/sub is now visible but remains collapsed (its child is still hidden).
	 */
	handleFoldToggle(nodeId: string): void {
		const children = this.hierarchy.getChildren(nodeId);
		if (children.length === 0) return;

		const descendants = this.hierarchy.getAllDescendants(nodeId);
		if (descendants.length === 0) return;

		const isCollapsed = descendants.every((id) => this.settings.hiddenNodes[id]);

		if (isCollapsed) {
			// Unfold one level: reveal direct children only.
			for (const childId of children) {
				delete this.settings.hiddenNodes[childId];
			}
		} else {
			// Fold: hide every structural descendant.
			for (const descId of descendants) {
				this.settings.hiddenNodes[descId] = true;
			}
		}

		this.save();
		this.refresh();
	}

	/**
	 * Handles Shift+right-click on a node: recursively unfolds the whole
	 * subtree unconditionally — every hidden structural descendant is
	 * revealed, regardless of the current state (fully folded, partially
	 * folded, or mixed). No-op when nothing is hidden under `nodeId`.
	 *
	 * @param nodeId The node that was Shift+right-clicked.
	 *
	 * @example
	 * // Mixed hidden state: /src → src/api (hidden) → src/api/index.md (hidden)
	 * //                           src/utils.md (visible)
	 * // Before: hiddenNodes = { "src/api": true, "src/api/index.md": true }
	 * foldingManager.handleRecursiveUnfold("/src");
	 * // After:  hiddenNodes = {}
	 * // All hidden descendants revealed in one shot, regardless of nesting depth.
	 */
	handleRecursiveUnfold(nodeId: string): void {
		const toUnhide = this.hierarchy
			.getAllDescendants(nodeId)
			.filter((id) => this.settings.hiddenNodes[id]);
		if (toUnhide.length === 0) return;

		for (const descId of toUnhide) {
			delete this.settings.hiddenNodes[descId];
		}

		this.save();
		this.refresh();
	}

	/**
	 * Purges stale entries from `settings.hiddenNodes` by checking each stored
	 * node ID against the vault.
	 *
	 * @returns `true` if at least one entry was removed and settings must be
	 *   saved; `false` when the map was already clean.
	 *
	 * @remarks
	 * Purging is intentionally conservative: when an ID format is unrecognised
	 * the entry is kept rather than risking destruction of user state. A
	 * superfluous entry in `hiddenNodes` is invisible to the user; a premature
	 * purge destroys their carefully arranged collapsed state.
	 *
	 * Purging is based on vault existence, NOT on what is currently rendered —
	 * purging against the rendered graph would incorrectly remove all heading
	 * entries when `showHeadingNodes` is off, or all folder entries when
	 * `showFolderNodes` is off.
	 */
	purge(): boolean {
		let purged = false;
		for (const id of Object.keys(this.settings.hiddenNodes)) {
			if (!this.isNodeIdValidInVault(id)) {
				delete this.settings.hiddenNodes[id];
				purged = true;
			}
		}
		return purged;
	}

	/**
	 * Returns true if a node ID stored in `settings.hiddenNodes` still
	 * corresponds to a real vault item, independent of the current
	 * `showFolderNodes`/`showHeadingNodes` toggles.
	 *
	 * @param id A node ID from `settings.hiddenNodes`.
	 * @returns `true` when the ID maps to an existing vault item, or when the
	 *   format is unrecognised (conservative keep).
	 *
	 * @remarks
	 * Rules by ID format:
	 * - **Folder IDs** (start with `/`, or equal `/`): `/` is always valid
	 *   (vault root); others are valid when
	 *   `app.vault.getAbstractFileByPath(id.slice(1))` returns a `TFolder`.
	 * - **Heading IDs** (contain `#`): the portion before the first `#` must
	 *   resolve to a file via `metadataCache.getFirstLinkpathDest`, AND the
	 *   portion after the first `#` must appear as a heading text in that
	 *   file's cache.
	 * - **Plain file IDs**: valid when either
	 *   `metadataCache.getFirstLinkpathDest(id, "")` or
	 *   `vault.getAbstractFileByPath(id)` returns a non-null result. Both are
	 *   tried because the graph stores IDs either as full paths or as basenames
	 *   without extension.
	 *
	 * @example
	 * // Folder ID — vault root is always valid.
	 * foldingManager.isNodeIdValidInVault("/");
	 * // true
	 *
	 * @example
	 * // Folder ID — arbitrary sub-folder (valid when the TFolder exists in vault).
	 * foldingManager.isNodeIdValidInVault("/projects/2024");
	 * // true   when vault contains the folder  projects/2024
	 * // false  when the folder has been deleted or renamed
	 *
	 * @example
	 * // Heading ID — file part + heading text are both validated.
	 * foldingManager.isNodeIdValidInVault("journal/2024-01-15#Daily note");
	 * // true   when  journal/2024-01-15.md  exists and has a heading "Daily note"
	 * // false  when the file or heading is missing
	 *
	 * @example
	 * // Plain file ID stored as basename (ghost link / unique-name vault).
	 * foldingManager.isNodeIdValidInVault("readme");
	 * // true  when  getFirstLinkpathDest("readme", "")  resolves to a TFile
	 *
	 * @example
	 * // Plain file ID stored as full path.
	 * foldingManager.isNodeIdValidInVault("folder/note.md");
	 * // true  when  vault.getAbstractFileByPath("folder/note.md")  is non-null
	 */
	isNodeIdValidInVault(id: string): boolean {
		// Folder node: starts with `/`.
		if (id.startsWith("/")) {
			if (id === "/") return true; // Vault root is always present.
			const vaultPath = id.slice(1);
			const item = this.app.vault.getAbstractFileByPath(vaultPath);
			return item instanceof TFolder;
		}

		// Heading node: contains `#`.
		const hashIdx = id.indexOf("#");
		if (hashIdx >= 0) {
			const filePart = id.slice(0, hashIdx);
			const headingText = id.slice(hashIdx + 1);
			const file = this.app.metadataCache.getFirstLinkpathDest(filePart, "");
			if (!file) return false;
			const headings = this.app.metadataCache.getFileCache(file)?.headings;
			if (!headings) return false;
			return headings.some((h) => h.heading === headingText);
		}

		// Plain file node: try linkpath resolution first (handles basenames
		// without ext), then a direct path lookup.
		if (this.app.metadataCache.getFirstLinkpathDest(id, "") !== null) return true;
		if (this.app.vault.getAbstractFileByPath(id) !== null) return true;
		return false;
	}
}
