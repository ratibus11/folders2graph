import { Plugin, WorkspaceLeaf } from "obsidian";

import { GraphLeafWithCustomRenderer } from "interfaces/GraphLeafWithCustomRenderer";
import { LeafRenderer } from "interfaces/LeafRenderer";
import { RendererData } from "interfaces/RendererData";

import { Nullable } from "types/Nullable";
import { Settings } from "interfaces/Settings";
import { SettingsTab } from "SettingsTab";

const FOLDER_NODE_TAG = "f2g_node";

export default class Folders2GraphPlugin extends Plugin {
	public override settings: Settings = {
		hideRootNode: false,
		nodeColor: "#5c8af5",
	};

	/**
	 * Triggered when the plugin is loaded.
	 */
	public override async onload(): Promise<void> {
		// Load settings tab.
		await this.__loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

		// When a leaf changes, refresh all graph leaves.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf: Nullable<WorkspaceLeaf>) => {
				this.refreshGraphLeaves([leaf as GraphLeafWithCustomRenderer]);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshGraphLeaves();
			}),
		);

		// Iterates through all tabs which are of type "graph".
		this.refreshGraphLeaves();
	}

	/**
	 * Triggered when the plugin is unloaded.
	 */
	public override onunload(): void {
		this.__getLeavesOfTypeGraph().forEach((leaf) => {
			// Restablish the original data setter in the render, then delete the custom on, then reload the leaf.
			if (leaf.view.renderer.originalSetData) {
				leaf.view.renderer.setData = leaf.view.renderer.originalSetData;
				delete leaf.view.renderer.originalSetData;
			}

			this.__unpatchNodePrototype(leaf.view.renderer);

			leaf.view.unload();
			leaf.view.load();
			leaf.view.renderer.changed();
		});
	}

	/**
	 * Refreshes the provided graph leaves.
	 * @param leaves The leaves to refresh. If not provided, all graph leaves will be refreshed.
	 * @note If a leaf is not a graph, it will be ignored.
	 */
	public refreshGraphLeaves(leaves: GraphLeafWithCustomRenderer[] = this.__getLeavesOfTypeGraph()): void {
		leaves.forEach((leaf) => {
			if (!this.__isReadyGraphLeaf(leaf)) return;
			this.__injectDataInLeaf(leaf);
			leaf.view.unload();
			leaf.view.load();
			leaf.view.renderer.changed();
		});
	}

	/**
	 * A graph leaf is considered ready when its view type is `graph` AND its renderer has
	 * been mounted. The renderer can briefly be undefined when the `active-leaf-change`
	 * event fires before the graph view finishes initializing, so this guard prevents the
	 * downstream code from crashing on `renderer.*`.
	 */
	private __isReadyGraphLeaf(leaf: Nullable<GraphLeafWithCustomRenderer>): leaf is GraphLeafWithCustomRenderer {
		return !!leaf && !!leaf.view && leaf.view.getViewType() === "graph" && !!leaf.view.renderer;
	}

	/**
	 * Renders the graph leaf with a custom renderer.
	 * @param leaf The graph leaf to render.
	 */
	private __injectDataInLeaf(leaf: GraphLeafWithCustomRenderer): void {
		const renderer = leaf.view.renderer;

		// Store the original data setter in another property, then override the data setter with a custom one.
		if (renderer.originalSetData == undefined) {
			renderer.originalSetData = renderer.setData;
		}

		// Define the custom data setter.
		renderer.setData = (data: RendererData) => {
			const folders = new Set("/");

			// Get all folders of the nodes. Uses the ID of the node.
			// eg. file "folder/subfolder/file.md" will generate the following folders: "/", "/folder", "/folder/subfolder
			Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
				const nodeSubFolders = this.__getNodeParentFolders(nodeId);

				if (!nodeData.folderNode && nodeData.type != FOLDER_NODE_TAG && nodeSubFolders != null) {
					nodeSubFolders.forEach(folders.add, folders);
				}
			});

			// Add a node for each folder.
			folders.forEach((folder) => {
				data.nodes[folder] = {
					type: FOLDER_NODE_TAG,
					links: {},
					folderNode: true,
				};
			});

			// Add the links between the nodes and the folders.
			Object.entries(data.nodes).forEach(([nodeId, nodeData]) => {
				if (nodeData.type != FOLDER_NODE_TAG || nodeData.folderNode) {
					const directParent = this.__getNodeParentFolder(nodeId);
					data.nodes[directParent].links[nodeId] = true;
				}
			});

			if (!renderer.originalSetData) {
				throw new Error("originalSetData is undefined.");
			}

			if (this.settings.hideRootNode && data.nodes["/"]) {
				delete data.nodes["/"];
			}

			const result = renderer.originalSetData(data);

			this.__patchNodePrototype(renderer);

			return result;
		};
	}

	/**
	 * Patches the Node class prototype so every node instance — current and future —
	 * returns the configured color for folder nodes. Patching the prototype (rather than
	 * each instance) ensures the override survives node recreations triggered by Obsidian
	 * (e.g. toggling orphans, tag filters) without going through our custom `setData`.
	 */
	private __patchNodePrototype(renderer: LeafRenderer): void {
		if (renderer.nodes.length === 0) return;

		const proto = Object.getPrototypeOf(renderer.nodes[0]);
		if (proto.__f2gPatched) return;

		const originalGetFillColor = proto.getFillColor;
		const plugin = this;

		proto.__f2gOriginalGetFillColor = originalGetFillColor;
		proto.getFillColor = function () {
			if (this.type === FOLDER_NODE_TAG) {
				return { a: 1, rgb: plugin.__getNodeColorNumber() };
			}
			return originalGetFillColor.call(this);
		};
		proto.__f2gPatched = true;
	}

	/**
	 * Restores the original `getFillColor` on the Node prototype. Called on plugin unload.
	 */
	private __unpatchNodePrototype(renderer: LeafRenderer): void {
		if (renderer.nodes.length === 0) return;

		const proto = Object.getPrototypeOf(renderer.nodes[0]);
		if (!proto.__f2gPatched) return;

		proto.getFillColor = proto.__f2gOriginalGetFillColor;
		delete proto.__f2gOriginalGetFillColor;
		delete proto.__f2gPatched;
	}

	/**
	 * Get all leaves of type "graph".
	 * @returns The leaves of type "graph".
	 */
	private __getLeavesOfTypeGraph(): GraphLeafWithCustomRenderer[] {
		return this.app.workspace.getLeavesOfType("graph") as GraphLeafWithCustomRenderer[];
	}

	/**
	 * Get the parent folders of a node.
	 * @param nodeId The ID of the node.
	 * @returns Will return each folder and subfolder of the node.
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = __getNodeParentFolders(nodeId);
	 * // result = ["/", "/folder", "/folder/subfolder"]
	 */
	private __getNodeParentFolders(nodeId: string): string[] {
		const subFolders = ["/"];

		const splittedNodeId = nodeId.split("/");
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1);

		let currentFolder = "";
		subFoldersSteps.forEach((subfolder) => {
			currentFolder += "/" + subfolder;
			subFolders.push(currentFolder);
		});

		return subFolders;
	}

	/**
	 * Get the parent folder of a node.
	 * @param nodeId The ID of the node.
	 * @returns The parent folder of the node.
	 * @example
	 * const nodeId = "folder/subfolder/file.md";
	 * const result = __getNodeParentFolder(nodeId);
	 * // result = "/folder/subfolder"
	 */
	private __getNodeParentFolder(nodeId: string): string {
		const splittedNodeId = nodeId.split("/");
		const subFoldersSteps = splittedNodeId.slice(0, splittedNodeId.length - 1).filter((e) => e != "");

		return `/${subFoldersSteps.join("/")}`;
	}

	/**
	 * Refresh settings and apply them to `this.settings`.
	 */
	private async __loadSettings() {
		this.settings = Object.assign({}, this.settings, await this.loadData());
	}

	/**
	 * Call the Obsidian API to save the settings.
	 */
	public async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Get the node color number.
	 * @description The color is stored in hex format and the renderer uses a number which is the concatenation of the binary values of the RGB components.
	 * @example
	 * const color = "#001100"; // (00000000 00000001 0000001)
	 * const result = __getNodeColorNumber(color);
	 * // result = 129
	 * @returns
	 */
	private __getNodeColorNumber(): number {
		const r = parseInt(this.settings.nodeColor.substring(1, 3), 16).toString(2).padStart(8, "0");
		const g = parseInt(this.settings.nodeColor.substring(3, 5), 16).toString(2).padStart(8, "0");
		const b = parseInt(this.settings.nodeColor.substring(5, 7), 16).toString(2).padStart(8, "0");

		return parseInt(r + g + b, 2);
	}
}
