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
		weightNodesBySubtree: {
			name: "Pondérer les nœuds par leur sous-arbre complet",
			desc: "Lorsqu'activé, la taille d'un nœud reflète tous ses descendants structurels visibles — dossiers, fichiers et titres à tous les niveaux — et non seulement ses enfants directs. Les nœuds repliés redeviennent petits car leurs descendants masqués ne comptent plus. (désactivé par défaut)",
		},
		folderFilterMode: {
			name: "Mode de filtrage des dossiers",
			desc: "Inclure : seuls les dossiers listés apparaissent dans le graphe. Exclure : les dossiers listés sont masqués du graphe. Sans effet si la liste de filtrage est vide.",
		},
		folderFilterList: {
			name: "Liste de filtrage des dossiers",
			desc: "Un chemin relatif au coffre par ligne. Chaque entrée couvre le dossier et toute sa descendance. Les slashes de début et de fin sont retirés automatiquement. Laisser vide pour désactiver le filtrage.",
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
			name: "Activer ou désactiver la pondération par sous-arbre",
		},
		toggleRootNode: {
			name: "Afficher ou masquer le nœud racine",
		},
	},
};
