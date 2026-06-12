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
		/** Internal options engine of the graph view (Obsidian internal API).
		 * `getOptions`/`setOptions` carry the per-leaf graph configuration
		 * (filters, groups, display flags) — the same payload the Bookmarks
		 * plugin serialises and restores. Used to preserve per-leaf options
		 * across the plugin's `unload/load` refresh cycle, because the view's
		 * own `onload` resets them to the global graph options. */
		dataEngine?: {
			getOptions?: () => unknown;
			setOptions?: (options: unknown) => void;
			/** Reads `filterOptions.search.getValue()`, reconstructs the filter
			 * query, and triggers a graph refresh. Must be called after
			 * `filterOptions.search.setValue()` to push the new value into the
			 * engine. Internal Obsidian API — may be absent. */
			updateSearch?: () => void;
			/** Alternative async update path present in some Obsidian builds.
			 * `run()` immediately executes the deferred update. Internal API —
			 * may be absent. */
			requestUpdateSearch?: { run?: () => void };
			/** Exposes the graph filter controls so the plugin can pre-fill the
			 * search field programmatically. Internal Obsidian API — may be absent. */
			filterOptions?: {
				/** The search component inside the filter panel. Exposes the
				 * standard Obsidian `TextComponent` `getValue`/`setValue` interface.
				 * Internal API — may be absent. */
				search?: {
					getValue?: () => string;
					setValue?: (value: string) => unknown;
				};
			};
		};
		/** Opens the graph controls panel and focuses the search field. Calls
		 * `dataEngine.controlsEl.removeClass("is-close")`,
		 * `filterOptions.setCollapsed(false, true)`, and
		 * `search.autoSelect()` internally. Internal Obsidian API — may be absent. */
		showSearch?: () => void;
	};
};

/**
 * A `WorkspaceLeaf` intersected with the graph-specific view shape used by
 * this plugin.
 */
export type GraphLeafWithCustomRenderer = WorkspaceLeaf & CustomLeaf;
