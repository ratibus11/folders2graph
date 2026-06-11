import { I18n } from "types/I18n";
import { enUS } from "./enUS";
import { frFR } from "./frFR";

export { enUS, frFR };

/**
 * Returns the {@link I18n} object matching the language code stored in
 * Obsidian's `localStorage`. Defaults to English when no match is found.
 *
 * @returns The active locale object.
 *
 * @remarks
 * Obsidian writes the user's chosen language to `localStorage` under the key
 * `"language"` (e.g. `"en"`, `"fr"`). This function is called at plugin load
 * time and whenever UI strings need to be rendered.
 */
export function getI18n(): I18n {
	switch (window.localStorage.getItem("language")) {
		case "fr":
			return frFR;
		default:
			return enUS;
	}
}
