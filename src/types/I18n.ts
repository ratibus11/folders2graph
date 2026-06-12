/**
 * Structure of the internationalisation object used throughout the plugin.
 *
 * @remarks
 * Each locale module (`enUS`, `frFR`) exports a value that satisfies this type.
 * The active locale is resolved at runtime by `getI18n` from `i18n/index.ts`.
 */
export type I18n = {
	/** Strings used in the settings tab. */
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
		weightNodesBySubtree: {
			name: string;
			desc: string;
		};
	};
	/** Strings used for registered Obsidian commands. */
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
		toggleWeightNodesBySubtree: {
			name: string;
		};
	};
};
