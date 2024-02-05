import { WorkspaceLeaf } from "obsidian";
import { LeafRenderer } from "./LeafRenderer";

interface CustomLeaf {
	view: {
		renderer: LeafRenderer;
	};
}

export type GraphLeafWithCustomRenderer = WorkspaceLeaf & CustomLeaf;
