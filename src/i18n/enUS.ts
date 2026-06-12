import { I18n } from "types/I18n";

/**
 * English (United States) locale strings.
 *
 * @remarks
 * Used as the default locale when no matching language code is found in
 * `localStorage`.
 */
export const enUS: I18n = {
	settings: {
		showFolderNodes: {
			name: "Show folder nodes",
			desc: "Display your vault's folder structure as nodes in the graph view. Disable to focus on note-to-note connections only. (displayed by default)",
		},
		hideRootNode: {
			name: "Hide root node",
			desc: "Either hide or show the root folder node ('/') in the graph view. (displayed by default)",
		},
		nodeColor: {
			name: "Node color",
			desc: "Color to display nodes in the graph view. (defaulted to #5c8af5)",
		},
		showHeadingNodes: {
			name: "Show heading nodes",
			desc: "Add a node for each Markdown heading and link the notes mentioned under it. Clicking a heading node opens the source note at that section. (hidden by default)",
		},
		headingNodeColor: {
			name: "Heading node color",
			desc: "Color used to display heading nodes in the graph view. (defaulted to #f5a55c)",
		},
		weightNodesBySubtree: {
			name: "Weight nodes by full subtree",
			desc: "When enabled, the size of a node reflects all of its visible structural descendants at every depth (folders, files, headings), not just its direct children. Folded nodes shrink because their hidden descendants no longer count. (disabled by default)",
		},
	},
	commands: {
		toggleFolderNodes: {
			name: "Show or hide folder nodes",
		},
		toggleHeadingNodes: {
			name: "Show or hide heading nodes",
		},
		unfoldAllNodes: {
			name: "Unfold all graph nodes",
		},
		toggleWeightNodesBySubtree: {
			name: "Toggle subtree weight for graph nodes",
		},
	},
};
