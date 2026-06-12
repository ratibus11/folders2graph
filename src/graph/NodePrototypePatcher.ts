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
	private isGhostNode: (nodeId: string) => boolean;

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
	 * @param isGhostNode                 Returns `true` when a node ID belongs
	 *   to a ghost folder or ghost heading (content that exists only as a
	 *   virtual placeholder pending vault creation).  Also applies to Obsidian's
	 *   native `"unresolved"` node type, which is tested directly on the instance
	 *   without going through this callback.
	 */
	constructor(
		settings: Settings,
		hierarchy: StructuralHierarchy,
		handleRecursiveUnfold: (nodeId: string) => void,
		getSuppressNextContextMenu: () => boolean,
		setSuppressNextContextMenu: (value: boolean) => void,
		isGhostNode: (nodeId: string) => boolean,
	) {
		this.settings = settings;
		this.hierarchy = hierarchy;
		this.handleRecursiveUnfold = handleRecursiveUnfold;
		this.getSuppressNextContextMenu = getSuppressNextContextMenu;
		this.setSuppressNextContextMenu = setSuppressNextContextMenu;
		this.isGhostNode = isGhostNode;
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
	 *
	 * @example
	 * // Half-disc orientation: the rounded side faces the structural parent.
	 * // If the collapsed node sits at (100, 200) and its parent is at (100, 50),
	 * // the parent is directly above → angle = Math.atan2(50 - 200, 100 - 100) = -π/2
	 * // Arc drawn from -π/2 − π/2 = -π  to  -π/2 + π/2 = 0  (upper half-disc).
	 * //
	 * // If the parent is to the right at (300, 200):
	 * // angle = Math.atan2(200 - 200, 300 - 100) = 0
	 * // Arc drawn from -π/2  to  π/2  (right-facing half-disc).
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

		// Patch getSize so that, when weightNodesBySubtree is enabled, the
		// node's effective weight is temporarily inflated by the count of
		// indirect visible descendants before the native size calculation runs.
		// This reuses the native size curve without introducing an arbitrary
		// pixel offset. Direct children are already counted by Obsidian via the
		// number of displayed edges (this.weight), so only indirect descendants
		// are added to avoid double-counting.
		const originalGetSize = proto.getSize;
		if (typeof originalGetSize === "function") {
			proto.__f2gOriginalGetSize = originalGetSize;

			/**
			 * @remarks
			 * Obsidian derives node size from `this.weight`, which equals the
			 * number of edges (links) currently displayed for the node. Direct
			 * structural children already contribute to `weight` as visible
			 * edges, so we only need to add the *indirect* visible descendant
			 * count to capture grandchildren and deeper. We temporarily inflate
			 * `this.weight`, call the original function, then restore — this way
			 * the native size curve is reused without modification.
			 *
			 * If `this.weight` is not a number (Obsidian build divergence), we
			 * fall back to the original unmodified — adding an integer directly
			 * to a size-in-pixels value on an unknown scale would produce
			 * aberrantly large bubbles.
			 *
			 * @example
			 * // Hierarchy: /work → work/project → note.md (all visible, enabled)
			 * // this.id = "/work", this.weight = 1 (one edge: /work → work/project)
			 * // indirect = 1 (note.md is an indirect descendant of /work)
			 * // → this.weight is temporarily set to 2, original runs, weight restored.
			 */
			proto.getSize = function () {
				if (!patcher.settings.weightNodesBySubtree) {
					return originalGetSize.call(this);
				}
				const indirect = patcher.hierarchy.getIndirectVisibleDescendantCount(this.id);
				if (indirect <= 0) {
					return originalGetSize.call(this);
				}
				// The native weight is the number of displayed edges. Inflate it
				// temporarily by the indirect visible descendant count, call the
				// original size function to preserve its curve, then restore. The
				// restore is in a finally block: leaving the weight inflated after
				// an exception would permanently corrupt the node's native size.
				const savedWeight = this.weight;
				if (typeof savedWeight === "number") {
					this.weight = savedWeight + indirect;
					try {
						return originalGetSize.call(this);
					} finally {
						this.weight = savedWeight;
					}
				}
				// Fallback: weight is not a number — return the original unchanged
				// to avoid adding a raw count to an unknown pixel scale.
				return originalGetSize.call(this);
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
				// A node is "ghost" when its ID is in the ghost-folder / ghost-heading
				// sets, or when Obsidian itself marks it as an unresolved wikilink
				// target (type === "unresolved"). The collapsed state takes priority:
				// a ghost that is also folded renders as a half-disc, not a ring.
				const isGhost =
					this.type === "unresolved" ||
					patcher.isGhostNode(this.id);

				// ── Shared geometry measurement ─────────────────────────────────────────
				// Measure the native base radius and centre from the local PIXI geometry
				// on the first frame that needs a custom draw (before we clear it).  Both
				// values are cached per-instance so subsequent frames skip the measurement.
				//
				// Obsidian draws the circle at a large local radius (~100) and uses the
				// DisplayObject scale for sizing, so `getSize()` returns the wrong value
				// here — we must read local geometry instead.  The centre is captured
				// because PIXI geometry is not necessarily centred on (0, 0): drawing at
				// (0, 0) would shift the disc by one radius.  Fallbacks: radius=100,
				// centre=(0, 0).
				//
				// The measurement block runs for collapsed AND ghost branches; it is placed
				// here (before the if/else) so neither branch duplicates it.
				if ((isCollapsed || isGhost) && !this.__f2gBaseRadius) {
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

				if (isCollapsed) {
					// ── FOLDED STATE ──────────────────────────────────────────────────────
					// Redraw the half-disc every frame so that:
					//   • the orientation tracks the parent as positions change during layout,
					//   • any full-circle repaint by Obsidian (e.g. on hover) is overridden.
					// This is bounded to the number of visible collapsed nodes, so it is
					// acceptable in practice.
					//
					// @remarks
					// A ghost node can be folded (e.g. user Shift+clicked it). The fold
					// state survives across setData calls for as long as the ghost is
					// displayed in the graph: FoldingManager.purge() exempts entries whose
					// ID matches a currently-displayed ghost node. When the backing wikilink
					// is removed (and the ghost disappears), the purge resumes and the fold
					// state is discarded on the next setData pass.
					//
					// Color: draw in white (0xffffff) so that Obsidian's per-frame `tint`
					// on the DisplayObject applies the correct node colour (hover included),
					// exactly as the native full circle does.
					try {
						const baseRadius: number = this.__f2gBaseRadius ?? 100;
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
						this.__f2gGhostDrawn = false;
					} catch (err) {
						// Restore the normal circle if the custom drawing failed mid-way — a
						// clear() without a successful redraw would leave the node invisible.
						try {
							originalRender.apply(this, args);
						} catch (err2) {
							// Silently ignore if originalRender also fails.
						}
					}
				} else if (isGhost) {
					// ── GHOST STATE ───────────────────────────────────────────────────────
					// Redraw an outlined ring (hollow circle) every frame so that:
					//   • any full-disc repaint by Obsidian (e.g. on hover) is overridden,
					//   • the ghost visual is consistent across frames.
					// White stroke + Obsidian tint ensures hover colour works correctly,
					// matching the convention used by the half-disc drawing above.
					try {
						const baseRadius: number = this.__f2gBaseRadius ?? 100;
						const baseCenter: { x: number; y: number } = this.__f2gBaseCenter ?? { x: 0, y: 0 };
						const cx: number = baseCenter.x;
						const cy: number = baseCenter.y;

						// Stroke thickness ≈ 18 % of the base radius gives a clearly visible
						// ring without overly eating into the node's hit area.
						const thickness = baseRadius * 0.18;

						this.circle.clear();
						// Transparent fill keeps the PIXI hit area intact so the node
						// remains clickable in the centre of the ring.
						this.circle.beginFill(0xffffff, 0);
						this.circle.lineStyle(thickness, 0xffffff, 1);
						this.circle.drawCircle(cx, cy, baseRadius - thickness / 2);
						this.circle.endFill();

						this.__f2gGhostDrawn = true;
						this.__f2gHalfDrawn = false;
					} catch (err) {
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
					this.__f2gGhostDrawn = false;
				} else if (this.__f2gGhostDrawn) {
					// ── TRANSITION: ghost → real ── restore the full circle once. The
					// ghost flag is cleared so subsequent frames do not re-enter this branch.
					try {
						const baseRadius: number = this.__f2gBaseRadius ?? 100;
						const baseCenter: { x: number; y: number } = this.__f2gBaseCenter ?? { x: 0, y: 0 };

						this.circle.clear();
						this.circle.lineStyle(0); // clear any active line style
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
					this.__f2gGhostDrawn = false;
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

		if (proto.__f2gOriginalGetSize) {
			proto.getSize = proto.__f2gOriginalGetSize;
			delete proto.__f2gOriginalGetSize;
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
	private getColorNumber(hexColor: string): number {
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
	 *
	 * **Sync contract:** this method splits on the **first** `#` character.
	 * `GraphInteractions.createGhostHeading` uses the same first-`#` split to
	 * reconstruct `filePart` and `headingText` from a ghost heading ID.  Both
	 * must remain consistent on the `path#heading` format whenever the ID scheme
	 * changes.
	 *
	 * @example
	 * const label = extractHeadingFromNodeId("docs/guide#Getting Started");
	 * // label = "Getting Started"
	 *
	 * @example
	 * // Degraded case: heading text contains a `#` character.
	 * const label = extractHeadingFromNodeId("notes/faq#What is C#?");
	 * // label = "What is C"  — truncated at the second `#`
	 *
	 * @example
	 * // No `#` present — full nodeId returned (should not occur for heading nodes).
	 * const label = extractHeadingFromNodeId("docs/guide");
	 * // label = "docs/guide"
	 */
	private extractHeadingFromNodeId(nodeId: string): string {
		const idx = nodeId.indexOf("#");
		return idx >= 0 ? nodeId.slice(idx + 1) : nodeId;
	}
}
