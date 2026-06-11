export type I18n = {
	settings: {
		showFolderNodes: {
			name: string;
			desc: string;
		};
		hideRootNode: {
			name: string;
			desc: string;
		};
		nodeColor: {
			name: string;
			desc: string;
		};
		showHeadingNodes: {
			name: string;
			desc: string;
		};
		headingNodeColor: {
			name: string;
			desc: string;
		};
	};
	commands: {
		toggleFolderNodes: {
			name: string;
		};
		toggleHeadingNodes: {
			name: string;
		};
		unfoldAllNodes: {
			name: string;
		};
	};
};
