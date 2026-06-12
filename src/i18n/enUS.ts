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
		sections: {
			folders: "Folders",
			folderFilter: "Folder filtering",
			headings: "Headings",
			weighting: "Weighting",
		},
		showFolderNodes: {
			name: "Show folders",
			desc: "Display the vault's folder structure in the graph view. (displayed by default)",
		},
		hideRootNode: {
			name: "Hide root folder",
			desc: "Hide or show the root folder node ('/') in the graph view. (displayed by default)",
		},
		nodeColor: {
			name: "Folder node color",
			desc: "Color used to display folder nodes in the graph view. (defaulted to #5c8af5)",
		},
		showHeadingNodes: {
			name: "Show heading nodes",
			desc: "Display each note's heading structure in the graph view. (hidden by default)",
		},
		headingNodeColor: {
			name: "Heading node color",
			desc: "Color used to display heading nodes in the graph view. (defaulted to #f5a55c)",
		},
		weightNodesBySubtree: {
			name: "Weight nodes by their descendants",
			desc: "When enabled, the size of a node is proportional to the number of linked descendants displayed in the graph. (disabled by default)",
		},
		folderFilterMode: {
			name: "Folder filter mode",
			desc: "Include: only the listed folders appear in the graph. Exclude: the listed folders are hidden from the graph.",
			optionExclude: "Exclude",
			optionInclude: "Include",
		},
		folderFilterList: {
			name: "Folder filter list",
			desc: "The list of folders to include in or exclude from the graph, depending on the selected filter mode. A list of paths relative to the vault root. One folder path per line.",
		},
		folderFilterHideFiles: {
			name: "Hide filtered-out files",
			desc: "When enabled, files and headings whose folders are excluded from the graph are excluded as well.",
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
			name: "Enable or disable weighting by descendants",
		},
		toggleRootNode: {
			name: "Show or hide the root node",
		},
	},
};
