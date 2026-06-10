import { I18n } from "types/I18n";
import { enUS } from "./enUS";
import { frFR } from "./frFR";

export { enUS, frFR };

/**
 * Returns the I18n object matching the language code stored in Obsidian's localStorage.
 * Defaults to English when no match is found.
 */
export function getI18n(): I18n {
	switch (window.localStorage.getItem("language")) {
		case "fr":
			return frFR;
		default:
			return enUS;
	}
}
