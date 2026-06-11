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
 */
export class FoldingManager {
	private app: App;
	private settings: Settings;
	private hierarchy: StructuralHierarchy;
	private save: () => Promise<void>;
	private refresh: () => void;

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
	 * - No structural children → no-op.
	 * - All descendants hidden (fully folded) → unfold ONE level: the direct
	 *   children are removed from `hiddenNodes`; each child keeps its own
	 *   folded state, so there is no recursion.
	 * - Otherwise (fully or partially visible) → fold: every structural
	 *   descendant is added to `hiddenNodes`.
	 *
	 * The state is persisted on every change and all graph leaves are refreshed.
	 * A single descendant traversal is used to derive the folded state and to
	 * apply the change.
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
	 * subtree, unconditionally — every hidden structural descendant is
	 * revealed, whatever the current state (fully folded, partially folded or
	 * mixed). No-op when nothing is hidden.
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
	 * node ID against the vault. Purging is conservative: when an ID format is
	 * unrecognised the entry is kept rather than risking destruction of user
	 * state.
	 *
	 * Purging is intentionally based on vault existence, NOT on what is
	 * currently rendered — purging against the rendered graph would incorrectly
	 * remove all heading entries when `showHeadingNodes` is off.
	 *
	 * @returns `true` if at least one entry was removed and settings must be saved.
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
	 * Rules by ID format:
	 * - Folder IDs start with `/` (or equal `/`): `/` is always valid (vault
	 *   root); others are valid when
	 *   `app.vault.getAbstractFileByPath(id.slice(1))` returns a TFolder.
	 * - Heading IDs contain `#`: the portion before the first `#` must resolve
	 *   to a file via `metadataCache.getFirstLinkpathDest`, AND the portion
	 *   after the first `#` must appear as a heading text in that file's cache.
	 * - Everything else (plain file IDs): valid when either
	 *   `metadataCache.getFirstLinkpathDest(id, "")` or
	 *   `vault.getAbstractFileByPath(id)` returns a non-null result. The graph
	 *   may store IDs as full paths or as basenames without extension, so both
	 *   lookups are tried.
	 *
	 * When in doubt the method returns `true` (conservative: keep the entry).
	 * A superfluous entry in hiddenNodes is invisible to the user; a premature
	 * purge destroys their carefully arranged collapsed state.
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
