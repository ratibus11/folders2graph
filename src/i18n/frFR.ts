import { I18n } from "types/I18n";

export const frFR: I18n = {
	settings: {
		hideRootNode: {
			name: "Cacher le nœud racine",
			desc: "Cacher ou non le nœud du dossier racine ('/') dans la vue graphique. (affiché par défaut)",
		},
		nodeColor: {
			name: "Couleur du nœud",
			desc: "Couleur avec laquelle afficher les nœuds dans la vue graphique. (par défaut à #5c8af5)",
		},
		showHeadingNodes: {
			name: "Afficher les nœuds de titre",
			desc: "Ajoute un nœud pour chaque titre Markdown et y rattache les notes mentionnées sous ce titre. Un clic sur un nœud de titre ouvre la note source à cette section. (caché par défaut)",
		},
		headingNodeColor: {
			name: "Couleur des nœuds de titre",
			desc: "Couleur des nœuds de titre dans la vue graphique. (par défaut à #f5a55c)",
		},
	},
};
