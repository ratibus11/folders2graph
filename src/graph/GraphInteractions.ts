import { App, OpenViewState, PaneType, TFolder, Workspace } from "obsidian";
import { GraphLeafWithCustomRenderer } from "interfaces/GraphLeafWithCustomRenderer";
import { Nullable } from "types/Nullable";

/**
 * Manages all DOM-level interactions for the graph: Shift key tracking, the
 * `openLinkText` wrapper that intercepts folder-node clicks and fold-toggle
 * gestures, folder revelation in the file explorer, and the per-leaf DOM
 * `contextmenu` suppressor that swallows the native context menu after a
 * Shift+right-click on a node with hidden descendants.
 */
export class GraphInteractions {
	private app: App;
	private getFolderNodeIds: () => Set<string>;
	private getAllNodeIds: () => Set<string>;
	private handleFoldToggle: (nodeId: string) => void;

	/** True while the Shift key is held down. Tracked via capture-phase
	 * keydown/keyup on window, with a blur-reset to handle cases where keyup
	 * is missed. */
	private shiftHeld = false;

	/** Set to true by the PIXI rightdown wrapper when it swallows a
	 * Shift+right-click with hidden descendants, so the subsequent DOM
	 * `contextmenu` event can be suppressed without any coordinate
	 * hit-testing. Reset immediately after consumption. */
	private suppressNextContextMenu = false;

	/** Original `workspace.openLinkText` saved when we wrap it, so we can
	 * restore on unload. */
	private originalOpenLinkText: Nullable<Workspace["openLinkText"]> = null;

	/** WeakMap from a leaf's containerEl to its AbortController, used for
	 * the DOM contextmenu suppression listener. */
	private contextMenuAbortControllers: WeakMap<HTMLElement, AbortController> = new WeakMap();

	/** Flat set of all active AbortControllers so onunload can abort them all. */
	private activeAbortControllers: Set<AbortController> = new Set();

	/** Arrow-function handlers stored so the same references can be passed to
	 * removeEventListener on unload. */
	private onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Shift") this.shiftHeld = true;
	};
	private onKeyUp = (e: KeyboardEvent): void => {
		if (e.key === "Shift") this.shiftHeld = false;
	};
	private onBlur = (): void => {
		this.shiftHeld = false;
	};

	constructor(
		app: App,
		getFolderNodeIds: () => Set<string>,
		getAllNodeIds: () => Set<string>,
		handleFoldToggle: (nodeId: string) => void,
	) {
		this.app = app;
		this.getFolderNodeIds = getFolderNodeIds;
		this.getAllNodeIds = getAllNodeIds;
		this.handleFoldToggle = handleFoldToggle;
	}

	/** Returns the current value of the suppress-context-menu flag. */
	getSuppressNextContextMenu(): boolean {
		return this.suppressNextContextMenu;
	}

	/** Sets the suppress-context-menu flag. Called by `NodePrototypePatcher`
	 * when a Shift+right-click gesture is swallowed. */
	setSuppressNextContextMenu(value: boolean): void {
		this.suppressNextContextMenu = value;
	}

	/**
	 * Registers global Shift key tracking listeners on `window`. Must be
	 * called during plugin load; paired with `unregisterKeyListeners`.
	 */
	registerKeyListeners(): void {
		window.addEventListener("keydown", this.onKeyDown, true);
		window.addEventListener("keyup", this.onKeyUp, true);
		window.addEventListener("blur", this.onBlur, true);
	}

	/**
	 * Removes the global Shift key tracking listeners installed by
	 * `registerKeyListeners`.
	 */
	unregisterKeyListeners(): void {
		window.removeEventListener("keydown", this.onKeyDown, true);
		window.removeEventListener("keyup", this.onKeyUp, true);
		window.removeEventListener("blur", this.onBlur, true);
	}

	/**
	 * Aborts all active contextmenu suppression controllers and clears the
	 * tracking sets. Called during plugin unload.
	 */
	abortAllContextMenuSuppressors(): void {
		this.activeAbortControllers.forEach((controller) => controller.abort());
		this.activeAbortControllers.clear();
	}

	/**
	 * Wraps `workspace.openLinkText` so that clicks on folder nodes reveal the
	 * corresponding folder in the file explorer instead of failing to resolve a
	 * non-existent file. The wrapper only intercepts linktexts that match a
	 * currently-injected folder node ID, so regular wikilink clicks are
	 * unaffected.
	 */
	wrapOpenLinkText(): void {
		const workspace = this.app.workspace;
		this.originalOpenLinkText = workspace.openLinkText.bind(workspace);

		workspace.openLinkText = (
			linktext: string,
			sourcePath: string,
			newLeaf?: PaneType | boolean,
			openViewState?: OpenViewState,
		): Promise<void> => {
			// Shift+left-click on a graph node → toggle its fold state instead of
			// navigating. Guarded on the most recent leaf being a graph view:
			// clicking a node activates its leaf before openLinkText fires, while
			// a Shift+click on an editor wikilink keeps the editor leaf active —
			// so editor links are never swallowed.
			const activeIsGraph =
				this.app.workspace.getMostRecentLeaf()?.view?.getViewType?.() === "graph";
			if (this.shiftHeld && activeIsGraph && this.getAllNodeIds().has(linktext)) {
				this.handleFoldToggle(linktext);
				return Promise.resolve();
			}

			if (this.getFolderNodeIds().has(linktext)) {
				this.revealFolderInExplorer(linktext);
				return Promise.resolve();
			}
			return this.originalOpenLinkText!(linktext, sourcePath, newLeaf, openViewState);
		};
	}

	/**
	 * Restores the original `workspace.openLinkText`.
	 */
	unwrapOpenLinkText(): void {
		if (!this.originalOpenLinkText) return;
		this.app.workspace.openLinkText = this.originalOpenLinkText;
		this.originalOpenLinkText = null;
	}

	/**
	 * Reveals the folder backing a folder node in Obsidian's file explorer.
	 * Folder node IDs use a leading `/` and a `/`-rooted path (e.g.
	 * `/work/notes`); the vault stores paths without the leading slash, and
	 * the vault root is `""`.
	 */
	private revealFolderInExplorer(folderNodeId: string): void {
		const vaultPath = folderNodeId === "/" ? "" : folderNodeId.slice(1);
		const folder: Nullable<TFolder> =
			vaultPath === ""
				? this.app.vault.getRoot()
				: (this.app.vault.getAbstractFileByPath(vaultPath) as Nullable<TFolder>);
		if (!folder) return;

		// Make sure a file-explorer leaf exists and is in focus.
		let leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
		if (!leaf) {
			const leftLeaf = this.app.workspace.getLeftLeaf(false);
			if (leftLeaf) {
				leftLeaf.setViewState({ type: "file-explorer" });
				leaf = leftLeaf;
			}
		}
		if (!leaf) return;
		this.app.workspace.revealLeaf(leaf);

		// `revealInFolder` is exposed by the internal `file-explorer` plugin
		// instance. Not part of the public API — fall back silently if it ever
		// moves.
		const fileExplorerInstance = (this.app as unknown as {
			internalPlugins?: {
				getPluginById?: (id: string) => { instance?: { revealInFolder?: (f: TFolder) => void } };
			};
		}).internalPlugins?.getPluginById?.("file-explorer")?.instance;

		fileExplorerInstance?.revealInFolder?.(folder);
	}

	/**
	 * Installs a capture-phase DOM `contextmenu` listener on the graph view
	 * container that suppresses the native context menu right after the PIXI
	 * rightdown wrapper swallowed a Shift+right-click. No coordinate
	 * hit-testing is involved: the PIXI wrapper sets `suppressNextContextMenu`
	 * and this listener merely consumes the flag.
	 *
	 * One listener per container: any previous controller for the same
	 * container is aborted before registering, so repeated `refreshGraphLeaves`
	 * calls never stack listeners.
	 */
	installContextMenuSuppressor(leaf: GraphLeafWithCustomRenderer): void {
		const containerEl = leaf.view.containerEl;

		const existing = this.contextMenuAbortControllers.get(containerEl);
		if (existing) {
			existing.abort();
			this.activeAbortControllers.delete(existing);
		}

		const controller = new AbortController();
		this.contextMenuAbortControllers.set(containerEl, controller);
		this.activeAbortControllers.add(controller);

		containerEl.addEventListener(
			"contextmenu",
			(event: MouseEvent) => {
				if (this.suppressNextContextMenu) {
					event.preventDefault();
					event.stopPropagation();
					this.suppressNextContextMenu = false;
				}
				// No flag — let the event through so the native context menu appears.
			},
			{ capture: true, signal: controller.signal },
		);
	}
}
