import { I18n } from "types/I18n";

export const enUS: I18n = {
	settings: {
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
	},
};
