import { WorkspaceLeaf } from "obsidian";
import { LeafRenderer } from "./LeafRenderer";

type CustomLeaf = {
	view: {
		renderer: LeafRenderer;
		getViewType: () => string;
		unload: () => void;
		load: () => void;
	};
};

export type GraphLeafWithCustomRenderer = WorkspaceLeaf & CustomLeaf;
