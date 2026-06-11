import { App, OpenViewState, PaneType, TFolder, Workspace } from "obsidian";
import { GraphLeafWithCustomRenderer } from "interfaces/GraphLeafWithCustomRenderer";
import { Nullable } from "types/Nullable";

/**
 * Manages all DOM-level interactions for the graph view.
 *
 * @remarks
 * Responsibilities:
 * - **Shift key tracking** — capture-phase `keydown`/`keyup`/`blur` listeners
 *   on `window` maintain a boolean that is consulted by the `openLinkText`
 *   wrapper.
 * - **`openLinkText` wrapper** — intercepts folder-node clicks (to reveal the
 *   folder in the file explorer) and Shift+left-click on any graph node (to
 *   toggle fold state) before the native navigation runs.
 * - **Folder revelation** — delegates to the internal `file-explorer` plugin
 *   instance; falls back silently when the undocumented API is unavailable.
 * - **Context-menu suppressor** — installs a per-leaf capture-phase DOM
 *   `contextmenu` listener that swallows the native context menu right after
 *   the PIXI `rightdown` wrapper sets `suppressNextContextMenu`, preventing
 *   the OS context menu from appearing on Shift+right-click.
 *
 * Listeners are cleaned up on unload via `unregisterKeyListeners` and
 * `abortAllContextMenuSuppressors`.
 */
export class GraphInteractions {
	private app: App;
	private getFolderNodeIds: () => Set<string>;
	private getAllNodeIds: () => Set<string>;
	private handleFoldToggle: (nodeId: string) => void;

	/** True while the Shift key is held down. Tracked via capture-phase
	 * keydown/keyup on window, with a blur-reset to handle cases where the
	 * keyup event is missed (e.g. when the window loses focus while Shift is
	 * held). */
	private shiftHeld = false;

	/** Set to `true` by the PIXI `rightdown` wrapper (in
	 * `NodePrototypePatcher`) when it swallows a Shift+right-click with hidden
	 * descendants, so the subsequent DOM `contextmenu` event can be suppressed
	 * without any coordinate hit-testing. Reset immediately after consumption
	 * by the DOM listener. */
	private suppressNextContextMenu = false;

	/** Original `workspace.openLinkText` saved when we wrap it, so we can
	 * restore on unload. */
	private originalOpenLinkText: Nullable<Workspace["openLinkText"]> = null;

	/** WeakMap from a leaf's `containerEl` to its `AbortController`, used to
	 * ensure at most one DOM `contextmenu` suppressor is active per container.
	 * A `WeakMap` is used so containers that are garbage-collected do not keep
	 * controllers alive. */
	private contextMenuAbortControllers: WeakMap<HTMLElement, AbortController> = new WeakMap();

	/** Flat set of all active `AbortController`s so `onunload` can abort them
	 * all in one sweep. */
	private activeAbortControllers: Set<AbortController> = new Set();

	/** Arrow-function handlers stored so the same references can be passed to
	 * `removeEventListener` on unload. */
	private onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Shift") this.shiftHeld = true;
	};
	private onKeyUp = (e: KeyboardEvent): void => {
		if (e.key === "Shift") this.shiftHeld = false;
	};
	private onBlur = (): void => {
		this.shiftHeld = false;
	};

	/**
	 * @param app               Obsidian application instance.
	 * @param getFolderNodeIds  Returns the set of currently injected folder
	 *   node IDs; consulted by the `openLinkText` wrapper.
	 * @param getAllNodeIds      Returns the full set of node IDs from the last
	 *   `setData` pass; used to validate Shift+click targets.
	 * @param handleFoldToggle  Callback invoked when a Shift+left-click on a
	 *   valid graph node is detected.
	 */
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

	/**
	 * Returns the current value of the suppress-context-menu flag.
	 *
	 * @remarks
	 * Read by the DOM `contextmenu` listener installed in
	 * `installContextMenuSuppressor`.
	 */
	getSuppressNextContextMenu(): boolean {
		return this.suppressNextContextMenu;
	}

	/**
	 * Sets the suppress-context-menu flag.
	 *
	 * @param value `true` to arm the suppressor; `false` to reset it.
	 *
	 * @remarks
	 * Called by `NodePrototypePatcher` when a Shift+right-click gesture on a
	 * node with hidden descendants is swallowed by the PIXI `rightdown`
	 * wrapper.
	 */
	setSuppressNextContextMenu(value: boolean): void {
		this.suppressNextContextMenu = value;
	}

	/**
	 * Registers global Shift key tracking listeners on `window`.
	 *
	 * @remarks
	 * All three listeners use capture phase (`true`) so they fire before any
	 * element-level handler. The `blur` listener resets `shiftHeld` when the
	 * window loses focus to prevent the Shift state from getting stuck.
	 *
	 * Must be called during plugin load; paired with `unregisterKeyListeners`.
	 */
	registerKeyListeners(): void {
		window.addEventListener("keydown", this.onKeyDown, true);
		window.addEventListener("keyup", this.onKeyUp, true);
		window.addEventListener("blur", this.onBlur, true);
	}

	/**
	 * Removes the global Shift key tracking listeners installed by
	 * `registerKeyListeners`. Must be called on plugin unload.
	 */
	unregisterKeyListeners(): void {
		window.removeEventListener("keydown", this.onKeyDown, true);
		window.removeEventListener("keyup", this.onKeyUp, true);
		window.removeEventListener("blur", this.onBlur, true);
	}

	/**
	 * Aborts all active context-menu suppression controllers and clears the
	 * tracking sets. Called during plugin unload.
	 *
	 * @remarks
	 * After this call the `contextMenuAbortControllers` WeakMap may still hold
	 * entries for containers that have not been garbage-collected, but those
	 * controllers are already aborted and their listeners are detached by the
	 * AbortSignal mechanism.
	 */
	abortAllContextMenuSuppressors(): void {
		this.activeAbortControllers.forEach((controller) => controller.abort());
		this.activeAbortControllers.clear();
	}

	/**
	 * Wraps `workspace.openLinkText` so that clicks on folder nodes reveal the
	 * corresponding folder in the file explorer instead of failing to resolve a
	 * non-existent file, and so that Shift+left-click on any graph node toggles
	 * its fold state instead of navigating.
	 *
	 * @remarks
	 * The wrapper only intercepts linktexts that match a currently-injected
	 * folder node ID, so regular wikilink clicks are unaffected.
	 *
	 * The Shift+fold gate is guarded by the most recent leaf being a graph
	 * view: clicking a graph node activates its leaf before `openLinkText`
	 * fires, while a Shift+click on an editor wikilink keeps the editor leaf
	 * active — so editor links are never accidentally swallowed.
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
	 * Restores the original `workspace.openLinkText` that was saved by
	 * `wrapOpenLinkText`. A no-op when the wrapper was never installed.
	 */
	unwrapOpenLinkText(): void {
		if (!this.originalOpenLinkText) return;
		this.app.workspace.openLinkText = this.originalOpenLinkText;
		this.originalOpenLinkText = null;
	}

	/**
	 * Reveals the folder backing a folder node in Obsidian's file explorer.
	 *
	 * @param folderNodeId A folder node ID in the form `"/"` (vault root) or
	 *   `"/path/to/folder"`.
	 *
	 * @remarks
	 * Folder node IDs use a leading `/` and a `/`-rooted path; the vault stores
	 * paths without the leading slash, and the vault root is `""`.
	 *
	 * `revealInFolder` is exposed by the internal `file-explorer` plugin
	 * instance and is not part of Obsidian's public API — the call falls back
	 * silently when the method is absent.
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
	 * `rightdown` wrapper swallowed a Shift+right-click.
	 *
	 * @param leaf The graph leaf whose container should receive the listener.
	 *
	 * @remarks
	 * No coordinate hit-testing is involved: the PIXI wrapper sets
	 * `suppressNextContextMenu` and this listener merely consumes the flag.
	 *
	 * One listener per container is enforced: any previous controller for the
	 * same container is aborted before a new one is registered, so repeated
	 * `refreshGraphLeaves` calls never stack listeners. The listener is
	 * installed AFTER `unload/load` so it is never orphaned by a view rebuild.
	 *
	 * The `AbortController` pattern is used instead of `removeEventListener`
	 * to guarantee clean-up even if the container element is replaced.
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
