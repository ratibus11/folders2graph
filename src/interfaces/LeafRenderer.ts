export type LeafRenderer = {
	setData: Function;
	originalSetData?: Function;
	nodes: Array<{
		id: string;
		x: number;
		y: number;
		type: string;
		getSize?: () => number;
		getFillColor: () => { a: number; rgb: number };
		originalGetFillColor?: () => { a: number; rgb: number };
		/** PIXI Graphics object used to draw the node circle. May be absent on some
		 * renderer builds; access must always be guarded. */
		circle?: {
			clear: () => void;
			beginFill: (color: number, alpha?: number) => void;
			moveTo: (x: number, y: number) => void;
			arc: (cx: number, cy: number, radius: number, startAngle: number, endAngle: number, anticlockwise?: boolean) => void;
			/** PIXI Graphics full-circle helper. Used when restoring a collapsed node to a
			 * full circle. Falls back to a full arc (0 → 2π) when absent. */
			drawCircle?: (x: number, y: number, radius: number) => void;
			closePath?: () => void;
			endFill: () => void;
			/** Returns the local axis-aligned bounding box of the drawn geometry. Used to
			 * measure the native base radius and centre before any scale is applied.
			 * `x` and `y` are the top-left corner of the bounding box in local space. */
			getLocalBounds?: () => { x: number; y: number; width: number; height: number };
			/** PIXI tint colour applied by Obsidian's renderer each frame. Present on PIXI
			 * DisplayObject; stored here for type-narrowing convenience only. */
			tint?: number;
			/** PIXI EventEmitter — registers a listener for the given event name. */
			on?: (event: string, fn: (e: unknown) => void, ctx?: unknown) => void;
			/** PIXI EventEmitter — removes a specific listener for the given event name. */
			off?: (event: string, fn: (e: unknown) => void) => void;
			/** PIXI EventEmitter (eventemitter3) — returns the array of listeners currently
			 * registered for the given event name. */
			listeners?: (event: string) => Array<(e: unknown) => void>;
		};
	}>;
	/** O(1) node lookup by ID, available in recent Obsidian builds. Falls back to scanning
	 * `nodes` when absent. */
	nodeLookup?: Record<string, { id: string; x: number; y: number }>;
	changed: () => void;
};
