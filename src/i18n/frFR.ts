import { I18n } from "types/I18n";

/**
 * French (France) locale strings.
 *
 * @remarks
 * Selected when `localStorage.getItem("language")` returns `"fr"`.
 */
export const frFR: I18n = {
	settings: {
		showFolderNodes: {
			name: "Afficher les nœuds de dossier",
			desc: "Affiche la structure des dossiers de votre coffre comme des nœuds dans la vue graphique. Désactiver pour ne voir que les liens entre les notes. (affiché par défaut)",
		},
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
	commands: {
		toggleFolderNodes: {
			name: "Afficher ou masquer les nœuds de dossier",
		},
		toggleHeadingNodes: {
			name: "Afficher ou masquer les nœuds de titre",
		},
		unfoldAllNodes: {
			name: "Déplier tous les nœuds du graphe",
		},
	},
};
