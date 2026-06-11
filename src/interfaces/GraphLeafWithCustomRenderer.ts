import { WorkspaceLeaf } from "obsidian";
import { LeafRenderer } from "./LeafRenderer";

type CustomLeaf = {
	view: {
		renderer: LeafRenderer;
		getViewType: () => string;
		unload: () => void;
		load: () => void;
		/** DOM container of the graph view. Present on all Obsidian views; used to install
		 * the contextmenu suppression listener. */
		containerEl: HTMLElement;
	};
};

export type GraphLeafWithCustomRenderer = WorkspaceLeaf & CustomLeaf;
