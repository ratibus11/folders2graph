import { LeafRenderer } from "interfaces/LeafRenderer";
import { Settings } from "interfaces/Settings";
import { StructuralHierarchy } from "graph/StructuralHierarchy";

const FOLDER_NODE_TAG = "f2g_node";
const HEADING_NODE_TAG = "f2g_heading_node";

/**
 * Patches and restores the Node class prototype shared by all graph node
 * instances across all leaves.
 *
 * @remarks
 * Because the prototype is shared across ALL graph leaves, the patch must NOT
 * capture any per-leaf or per-renderer state. All data is accessed through:
 * - The injected `settings` and `hierarchy` references (shared singletons).
 * - Per-instance properties (`this.id`, `this.renderer`, `this.circle`, …)
 *   read at call time inside the patched methods.
 *
 * The patch covers:
 * - `getFillColor` — returns the configured colour for folder / heading nodes.
 * - `getDisplayText` — strips the file-path prefix from heading node labels.
 * - Render method (`render` | `draw` | `updateGraphics`, whichever is present
 *   in the current Obsidian build) — wraps PIXI circle listeners once per
 *   node instance to intercept Shift+right-click, and redraws collapsed nodes
 *   as a half-disc on every frame.
 *
 * `patch` is idempotent: a second call on an already-patched prototype is a
 * no-op, guarded by the `__f2gPatched` flag.
 */
export class NodePrototypePatcher {
	private settings: Settings;
	private hierarchy: StructuralHierarchy;
	private handleRecursiveUnfold: (nodeId: string) => void;
	private setSuppressNextContextMenu: (value: boolean) => void;
	private getSuppressNextContextMenu: () => boolean;

	/**
	 * @param settings                    Plugin settings; read for node colours.
	 * @param hierarchy                   Structural hierarchy; queried for
	 *   `isCollapsed`, `getParent`, and `hasHiddenDescendant` at render time.
	 * @param handleRecursiveUnfold       Callback that triggers a full subtree
	 *   unfold when Shift+right-click is detected on a node with hidden
	 *   descendants.
	 * @param getSuppressNextContextMenu  Returns the current value of the
	 *   suppress-context-menu flag, set by the PIXI rightdown wrapper and
	 *   consumed by the DOM `contextmenu` listener.
	 * @param setSuppressNextContextMenu  Sets the suppress-context-menu flag.
	 *   Called by the PIXI rightdown wrapper when swallowing a gesture.
	 */
	constructor(
		settings: Settings,
		hierarchy: StructuralHierarchy,
		handleRecursiveUnfold: (nodeId: string) => void,
		getSuppressNextContextMenu: () => boolean,
		setSuppressNextContextMenu: (value: boolean) => void,
	) {
		this.settings = settings;
		this.hierarchy = hierarchy;
		this.handleRecursiveUnfold = handleRecursiveUnfold;
		this.getSuppressNextContextMenu = getSuppressNextContextMenu;
		this.setSuppressNextContextMenu = setSuppressNextContextMenu;
	}

	/**
	 * Patches the Node class prototype so every node instance — current and
	 * future — returns the configured colour for folder / heading nodes,
	 * renders collapsed nodes as a semi-circle, and intercepts
	 * Shift+right-click to trigger recursive unfold.
	 *
	 * @param renderer Any mounted graph renderer; used only to access the first
	 *   node instance and obtain its prototype. The renderer reference is NOT
	 *   captured by the patch.
	 *
	 * @remarks
	 * Patching the prototype (rather than each instance) ensures the overrides
	 * survive node recreations triggered by Obsidian without going through our
	 * custom `setData`.
	 *
	 * A no-op when `renderer.nodes` is empty or the prototype already carries
	 * the `__f2gPatched` flag.
	 */
	patch(renderer: LeafRenderer): void {
		if (renderer.nodes.length === 0) return;

		const proto = Object.getPrototypeOf(renderer.nodes[0]);
		if (proto.__f2gPatched) return;

		const originalGetFillColor = proto.getFillColor;
		const patcher = this;

		proto.__f2gOriginalGetFillColor = originalGetFillColor;
		proto.getFillColor = function () {
			if (this.type === FOLDER_NODE_TAG) {
				return { a: 1, rgb: patcher.getColorNumber(patcher.settings.nodeColor) };
			}
			if (this.type === HEADING_NODE_TAG) {
				return { a: 1, rgb: patcher.getColorNumber(patcher.settings.headingNodeColor) };
			}
			return originalGetFillColor.call(this);
		};

		// Heading nodes use the wikilink syntax `path#heading` as their ID so
		// the native click handler resolves to the right section, but we want
		// the label to show only the heading text. Override `getDisplayText`
		// when the prototype exposes it.
		const originalGetDisplayText = proto.getDisplayText;
		if (typeof originalGetDisplayText === "function") {
			proto.__f2gOriginalGetDisplayText = originalGetDisplayText;
			proto.getDisplayText = function () {
				if (this.type === HEADING_NODE_TAG) {
					return patcher.extractHeadingFromNodeId(this.id);
				}
				return originalGetDisplayText.call(this);
			};
		}

		// Patch the node render method (its name varies across Obsidian builds)
		// so that, once per node instance, the PIXI listeners of the node circle
		// are wrapped to intercept Shift+right-click. Obsidian registers its own
		// circle listeners (which open the native context menu) BEFORE ours, so
		// simply adding another listener could not prevent the native behaviour —
		// the existing listeners are detached and re-invoked conditionally instead.
		const renderMethodName = (["render", "draw", "updateGraphics"] as const).find(
			(name) => typeof proto[name] === "function",
		) as string | undefined;

		if (renderMethodName) {
			const originalRender = proto[renderMethodName];
			proto[`__f2gOriginal_${renderMethodName}`] = originalRender;

			proto[renderMethodName] = function (...args: unknown[]) {
				originalRender.apply(this, args);

				// Early-out: nothing to do if there is no PIXI circle to patch.
				if (!this.circle) return;

				// Wrap the circle's PIXI listeners once per node instance. The
				// wrapping is discarded naturally when unload/load reconstructs
				// the graph view nodes.
				if (!this.__f2gRightClickWrapped) {
					this.__f2gRightClickWrapped = true;
					try {
						const circle = this.circle as {
							on?: (event: string, fn: (e: unknown) => void, ctx?: unknown) => void;
							off?: (event: string, fn: (e: unknown) => void) => void;
							listeners?: (event: string) => Array<(e: unknown) => void>;
						};
						const nodeId: string = this.id;

						// Helper: detach all existing listeners for an event and return them.
						const detach = (eventName: string): Array<(e: unknown) => void> => {
							const fns = circle.listeners?.(eventName) ?? [];
							for (const fn of fns) {
								circle.off?.(eventName, fn);
							}
							return fns;
						};

						// Helper: forward an event to all original listeners.
						const forward = (fns: Array<(e: unknown) => void>, e: unknown) => {
							for (const fn of fns) {
								fn.call(undefined, e);
							}
						};

						// Wrap rightdown: the gate that triggers unfold and sets the suppress flag.
						const origRightdown = detach("rightdown");
						circle.on?.("rightdown", (e: unknown) => {
							const ev = e as { data?: { originalEvent?: MouseEvent }; nativeEvent?: MouseEvent };
							const native = ev?.data?.originalEvent ?? ev?.nativeEvent;
							if (native?.shiftKey && patcher.hierarchy.hasHiddenDescendant(nodeId)) {
								patcher.setSuppressNextContextMenu(true);
								patcher.handleRecursiveUnfold(nodeId);
								// Do NOT forward — we are suppressing the native context menu.
								return;
							}
							forward(origRightdown, e);
						});

						// Wrap rightup: swallow if the suppress flag is already set (same gesture).
						const origRightup = detach("rightup");
						circle.on?.("rightup", (e: unknown) => {
							if (patcher.getSuppressNextContextMenu()) {
								// Flag still set → this rightup belongs to the swallowed gesture.
								return;
							}
							forward(origRightup, e);
						});

						// Wrap rightclick: same — swallow companion events of the same gesture.
						const origRightclick = detach("rightclick");
						circle.on?.("rightclick", (e: unknown) => {
							if (patcher.getSuppressNextContextMenu()) {
								return;
							}
							forward(origRightclick, e);
						});

						// Wrap pointerdown: swallow only button=2 + Shift + hiddenDescendant to
						// avoid interfering with left-button drag/navigation events.
						const origPointerdown = detach("pointerdown");
						circle.on?.("pointerdown", (e: unknown) => {
							const ev = e as { data?: { originalEvent?: MouseEvent }; nativeEvent?: MouseEvent };
							const native = ev?.data?.originalEvent ?? ev?.nativeEvent;
							if (
								native?.button === 2 &&
								native?.shiftKey &&
								patcher.hierarchy.hasHiddenDescendant(nodeId)
							) {
								// Swallow — rightdown handles the actual action.
								return;
							}
							forward(origPointerdown, e);
						});
					} catch (err) {
						// Silently ignore — if the PIXI API differs, native behaviour is preserved.
					}
				}

				const isCollapsed = patcher.hierarchy.isCollapsed(this.id);

				if (isCollapsed) {
					// ── FOLDED STATE ──────────────────────────────────────────────────────
					// Redraw the half-disc every frame so that:
					//   • the orientation tracks the parent as positions change during layout,
					//   • any full-circle repaint by Obsidian (e.g. on hover) is overridden.
					// This is bounded to the number of visible collapsed nodes, so it is
					// acceptable in practice.
					try {
						// Measure the native base radius AND centre from the local geometry on
						// first encounter (before we clear it). Both are cached per-instance.
						//
						// Obsidian draws the circle at a large local radius (~100) and uses the
						// DisplayObject scale for sizing, so `getSize()` returns the wrong
						// value here — we must read local geometry instead.
						//
						// The centre must be captured because PIXI geometry is not necessarily
						// centred on (0, 0) — drawing at (0, 0) would appear shifted by one
						// radius. Fallbacks: radius=100, centre=(0, 0).
						//
						// Color: draw in white (0xffffff) so that Obsidian's per-frame `tint`
						// on the DisplayObject applies the correct node colour (hover included),
						// exactly as the native full circle does.
						if (!this.__f2gBaseRadius) {
							let r = 0;
							let cx = 0;
							let cy = 0;
							if (typeof this.circle.getLocalBounds === "function") {
								const b = this.circle.getLocalBounds();
								r = Math.max(b.width, b.height) / 2;
								cx = b.x + b.width / 2;
								cy = b.y + b.height / 2;
							}
							this.__f2gBaseRadius = r > 0 && isFinite(r) ? r : 100;
							this.__f2gBaseCenter = { x: cx, y: cy };
						}
						const baseRadius: number = this.__f2gBaseRadius;
						const baseCenter: { x: number; y: number } = this.__f2gBaseCenter ?? { x: 0, y: 0 };
						const cx: number = baseCenter.x;
						const cy: number = baseCenter.y;

						// Determine the angle pointing toward the structural parent: the rounded
						// side of the half-disc faces the parent (arc from angle − π/2 to
						// angle + π/2). Renderer coordinates and PIXI arc angles share the same
						// y-down convention, so atan2 gives the correct on-screen direction.
						// Falls back to upward (−π/2) when the parent position is unavailable.
						let angle = -Math.PI / 2;
						const parentId = patcher.hierarchy.getParent(this.id);
						if (parentId !== undefined) {
							// O(1) lookup through this.renderer.nodeLookup when available,
							// falling back to a scan of this.renderer.nodes. Always read from
							// the per-instance renderer — the prototype is shared across all
							// graph leaves, so no renderer reference may be captured here.
							const r = this.renderer;
							let parentNode: { x: number; y: number } | undefined;
							if (r?.nodeLookup) {
								parentNode = r.nodeLookup[parentId];
							} else if (r?.nodes) {
								parentNode = r.nodes.find((n: { id: string }) => n.id === parentId);
							}
							if (parentNode) {
								angle = Math.atan2(parentNode.y - this.y, parentNode.x - this.x);
							}
						}

						this.circle.clear();
						this.circle.beginFill(0xffffff, 1);
						this.circle.moveTo(cx, cy);
						this.circle.arc(cx, cy, baseRadius, angle - Math.PI / 2, angle + Math.PI / 2);
						if (typeof this.circle.closePath === "function") {
							this.circle.closePath();
						}
						this.circle.endFill();

						this.__f2gHalfDrawn = true;
					} catch (err) {
						// Restore the normal circle if the custom drawing failed mid-way — a
						// clear() without a successful redraw would leave the node invisible.
						try {
							originalRender.apply(this, args);
						} catch (err2) {
							// Silently ignore if originalRender also fails.
						}
					}
				} else if (this.__f2gHalfDrawn) {
					// ── TRANSITION: just unfolded ── restore the full circle once. Obsidian
					// does not redraw the circle geometry on its own when a node changes
					// state, so a custom drawing persists until we replace it explicitly.
					try {
						const baseRadius: number = this.__f2gBaseRadius ?? 100;
						const baseCenter: { x: number; y: number } = this.__f2gBaseCenter ?? { x: 0, y: 0 };

						this.circle.clear();
						this.circle.beginFill(0xffffff, 1);
						if (typeof this.circle.drawCircle === "function") {
							this.circle.drawCircle(baseCenter.x, baseCenter.y, baseRadius);
						} else {
							this.circle.moveTo(baseCenter.x, baseCenter.y);
							this.circle.arc(baseCenter.x, baseCenter.y, baseRadius, 0, 2 * Math.PI);
						}
						this.circle.endFill();
					} catch (err) {
						try {
							originalRender.apply(this, args);
						} catch (err2) {
							// Silently ignore if originalRender also fails.
						}
					}
					this.__f2gHalfDrawn = false;
				}
			};
		}

		proto.__f2gPatched = true;
	}

	/**
	 * Restores the original `getFillColor`, `getDisplayText`, and render method
	 * on the Node prototype.
	 *
	 * @param renderer Any mounted graph renderer; used only to access the node
	 *   prototype. The renderer reference is NOT stored.
	 *
	 * @remarks
	 * Called on plugin unload. A no-op when the prototype does not carry the
	 * `__f2gPatched` flag (e.g. when the renderer had no nodes at patch time).
	 */
	unpatch(renderer: LeafRenderer): void {
		if (renderer.nodes.length === 0) return;

		const proto = Object.getPrototypeOf(renderer.nodes[0]);
		if (!proto.__f2gPatched) return;

		proto.getFillColor = proto.__f2gOriginalGetFillColor;
		delete proto.__f2gOriginalGetFillColor;

		if (proto.__f2gOriginalGetDisplayText) {
			proto.getDisplayText = proto.__f2gOriginalGetDisplayText;
			delete proto.__f2gOriginalGetDisplayText;
		}

		// Restore the patched render method, whichever name was found at patch time.
		for (const name of ["render", "draw", "updateGraphics"]) {
			const savedName = `__f2gOriginal_${name}`;
			if (proto[savedName]) {
				proto[name] = proto[savedName];
				delete proto[savedName];
			}
		}

		delete proto.__f2gPatched;
	}

	/**
	 * Converts a CSS hex colour string to the 24-bit integer format used by
	 * Obsidian's graph renderer (and PIXI tint).
	 *
	 * @param hexColor A 7-character CSS hex colour string (e.g. `"#5c8af5"`).
	 * @returns The colour as a 24-bit integer whose bits are the concatenation
	 *   of the 8-bit binary values of the R, G, and B channels.
	 *
	 * @remarks
	 * Obsidian's renderer stores per-node colours as plain JavaScript numbers
	 * in the same format used by PIXI `tint` values.
	 *
	 * @example
	 * const color = "#001100"; // R=0x00, G=0x11, B=0x00
	 * const result = getColorNumber(color);
	 * // result = 0x001100 = 4352
	 */
	getColorNumber(hexColor: string): number {
		const r = parseInt(hexColor.substring(1, 3), 16).toString(2).padStart(8, "0");
		const g = parseInt(hexColor.substring(3, 5), 16).toString(2).padStart(8, "0");
		const b = parseInt(hexColor.substring(5, 7), 16).toString(2).padStart(8, "0");

		return parseInt(r + g + b, 2);
	}

	/**
	 * Extracts the heading portion of a heading node ID.
	 *
	 * @param nodeId A heading node ID in the form `path#heading`.
	 * @returns The heading text after the first `#`, or the full `nodeId` when
	 *   no `#` is present.
	 *
	 * @remarks
	 * Uses `indexOf` (first `#`) so that headings whose text itself contains
	 * `#` characters are handled consistently — such IDs are a known degraded
	 * case where the heading text will be truncated at the second `#`.
	 */
	extractHeadingFromNodeId(nodeId: string): string {
		const idx = nodeId.indexOf("#");
		return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
	}
}
