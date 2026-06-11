import { WorkspaceLeaf } from "obsidian";
import { LeafRenderer } from "./LeafRenderer";

/**
 * Augmented `WorkspaceLeaf` type that exposes the graph view's internal
 * renderer and the DOM container element.
 *
 * @remarks
 * Obsidian's `WorkspaceLeaf` does not publicly type the `view` property beyond
 * a generic `View`. This intersection type narrows the shape to what the plugin
 * actually uses, reducing the need for `as unknown` casts.
 *
 * The `renderer` may be `undefined` immediately after the leaf is created and
 * before the graph view finishes initialising — all consumers must guard
 * against this (see `Folders2GraphPlugin.__isReadyGraphLeaf`).
 */
type CustomLeaf = {
	view: {
		/** The internal graph renderer. May be `undefined` during view
		 * initialisation; guard with `__isReadyGraphLeaf` before use. */
		renderer: LeafRenderer;
		/** Returns the Obsidian view type identifier (e.g. `"graph"`). */
		getViewType: () => string;
		/** Tears down the view's internal state and listeners. */
		unload: () => void;
		/** Re-initialises the view. Called after `unload` to apply changes
		 * made by the plugin's `setData` override. */
		load: () => void;
		/** DOM container of the graph view. Used to install the contextmenu
		 * suppression listener in `GraphInteractions`. */
		containerEl: HTMLElement;
	};
};

/**
 * A `WorkspaceLeaf` intersected with the graph-specific view shape used by
 * this plugin.
 */
export type GraphLeafWithCustomRenderer = WorkspaceLeaf & CustomLeaf;
