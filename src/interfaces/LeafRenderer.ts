/**
 * Shape of Obsidian's internal graph renderer, as accessed through
 * `leaf.view.renderer`.
 *
 * @remarks
 * This is not part of Obsidian's public API. The fields and methods listed here
 * have been determined by inspection of the Obsidian source and may change
 * across Obsidian releases. All accesses in the plugin are guarded accordingly.
 */
export type LeafRenderer = {
	/** Obsidian's native graph data setter. Replaced by the plugin with a
	 * custom wrapper and restored on unload. */
	setData: Function;
	/** The original `setData` saved by the plugin before wrapping. Present only
	 * while the plugin is active. */
	originalSetData?: Function;
	/** Array of graph node instances currently managed by this renderer. */
	nodes: Array<{
		/** Unique node identifier (file path, folder path, or heading wikilink). */
		id: string;
		/** Current x position in renderer-space coordinates. */
		x: number;
		/** Current y position in renderer-space coordinates (y-down). */
		y: number;
		/** Node type tag (see `GraphNode.type`). */
		type: string;
		/** Returns the display size of the node. Not used by the plugin because
		 * Obsidian draws the circle at a fixed local radius (~100) and relies on
		 * the DisplayObject scale — `getSize()` returns the wrong value for
		 * geometry measurements. */
		getSize?: () => number;
		/**
		 * Internal edge count used by Obsidian to derive node size. Equals the
		 * number of currently displayed edges for this node. Temporarily inflated
		 * by the `getSize` patch in `NodePrototypePatcher` when
		 * `weightNodesBySubtree` is enabled, to add the indirect visible
		 * descendant contribution without double-counting direct children.
		 */
		weight?: number;
		/** Returns the fill colour for this node. Patched by `NodePrototypePatcher`
		 * to return the configured colour for folder and heading nodes. */
		getFillColor: () => { a: number; rgb: number };
		/** Original `getFillColor` saved by the prototype patch. */
		originalGetFillColor?: () => { a: number; rgb: number };
		/** PIXI Graphics object used to draw the node circle. May be absent on
		 * some renderer builds; all accesses must be guarded. */
		circle?: {
			/** Clears all drawn geometry. */
			clear: () => void;
			/** Begins a fill operation with the given colour and alpha.
			 * @remarks Draw in white (`0xffffff`) so Obsidian's per-frame `tint`
			 * on the DisplayObject applies the correct node colour, exactly as the
			 * native full circle does. */
			beginFill: (color: number, alpha?: number) => void;
			/** Moves the drawing cursor to `(x, y)` without drawing. */
			moveTo: (x: number, y: number) => void;
			/** Draws an arc. Angles are in radians following PIXI's y-down convention,
			 * so the same direction as screen coordinates — `atan2` gives the correct
			 * on-screen angle without axis inversion. */
			arc: (cx: number, cy: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean) => void;
			/** PIXI Graphics full-circle helper. Used when restoring a collapsed node
			 * to a full circle. Falls back to a full arc (0 → 2π) when absent. */
			drawCircle?: (x: number, y: number, radius: number) => void;
			/** Closes the current path (connects the last point back to `moveTo`). */
			closePath?: () => void;
			/** Ends the fill operation and rasterises the geometry. */
			endFill: () => void;
			/** Returns the local axis-aligned bounding box of the drawn geometry.
			 * Used to measure the native base radius and centre before the first
			 * custom draw. `x` and `y` are the top-left corner in local space. */
			getLocalBounds?: () => { x: number; y: number; width: number; height: number };
			/** PIXI tint colour applied by Obsidian's renderer each frame. Present on
			 * PIXI DisplayObject; stored here for type-narrowing convenience only. */
			tint?: number;
			/**
			 * PIXI hit area override. When set to an object with a `contains(x, y)`
			 * method, PIXI's InteractionManager uses it instead of the drawn geometry
			 * for pointer hit-testing. Set to `null` to restore the default geometry-
			 * based test. Used by `NodePrototypePatcher` to keep ghost ring nodes
			 * (which have no fill) responsive to hover and click events.
			 */
			hitArea?: { contains(x: number, y: number): boolean } | null;
			/** PIXI Graphics line style setter. Used when drawing the ghost ring
			 * outline and when clearing the line style on ghost → real transitions. */
			lineStyle?: (width?: number, color?: number, alpha?: number) => void;
			/** PIXI EventEmitter — registers a listener for the given event name. */
			on?: (event: string, fn: (e: unknown) => void, ctx?: unknown) => void;
			/** PIXI EventEmitter — removes a specific listener for the given event name. */
			off?: (event: string, fn: (e: unknown) => void) => void;
			/** PIXI EventEmitter (eventemitter3) — returns the array of listeners
			 * currently registered for the given event name. Used by the prototype
			 * patch to detach existing listeners before re-wiring them. */
			listeners?: (event: string) => Array<(e: unknown) => void>;
		};
	}>;
	/** O(1) node lookup by ID, available in recent Obsidian builds. Falls back
	 * to a linear scan of `nodes` when absent. */
	nodeLookup?: Record<string, { id: string; x: number; y: number }>;
	/** Signals Obsidian's renderer that the data has changed and a re-render is
	 * needed. */
	changed: () => void;
};
