import { I18n } from "types/I18n";

/**
 * French (France) locale strings.
 *
 * @remarks
 * Selected when `localStorage.getItem("language")` returns `"fr"`.
 */
export const frFR: I18n = {
	settings: {
		sections: {
			folders: "Dossiers",
			folderFilter: "Filtrage des dossiers",
			headings: "Titres",
			weighting: "Pondération",
		},
		showFolderNodes: {
			name: "Afficher les dossiers",
			desc: "Afficher la structure des dossiers du coffre dans la vue graphique. (affiché par défaut)",
		},
		hideRootNode: {
			name: "Cacher le dossier racine",
			desc: "Cacher ou afficher le nœud du dossier racine ('/') dans la vue graphique. (affiché par défaut)",
		},
		nodeColor: {
			name: "Couleur des nœuds de dossier",
			desc: "Couleur avec laquelle afficher les nœuds des dossiers dans la vue graphique. (par défaut à #5c8af5)",
		},
		showHeadingNodes: {
			name: "Afficher les nœuds de titre",
			desc: "Afficher la structure des titres de chaque note dans la vue graphique. (caché par défaut)",
		},
		headingNodeColor: {
			name: "Couleur des nœuds de titre",
			desc: "Couleur avec laquelle afficher les nœuds des titres dans la vue graphique. (par défaut à #f5a55c)",
		},
		weightNodesBySubtree: {
			name: "Pondérer les nœuds par leurs descendants",
			desc: "Lorsqu'activé, la taille d'un nœud est proportionnelle au nombre de descendants liés et affichés dans le graphe. (désactivé par défaut)",
		},
		folderFilterMode: {
			name: "Mode de filtrage des dossiers",
			desc: "Inclure : seuls les dossiers listés apparaissent dans le graphe. Exclure : les dossiers listés sont masqués du graphe.",
			optionExclude: "Exclure",
			optionInclude: "Inclure",
		},
		folderFilterList: {
			name: "Liste de filtrage des dossiers",
			desc: "La liste des dossiers à inclure ou exclure du graphe, selon le mode de filtrage sélectionné. Est une liste de chemins relatifs à la racine du coffre. Un chemin de dossier par ligne.",
		},
		folderFilterHideFiles: {
			name: "Masquer les fichiers hors filtre",
			desc: "Lorsqu'activé, les fichiers et titres dont les dossiers sont exclus du graphe sont également exclus.",
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
		toggleWeightNodesBySubtree: {
			name: "Activer ou désactiver la pondération par les descendants",
		},
		toggleRootNode: {
			name: "Afficher ou masquer le nœud racine",
		},
	},
};
