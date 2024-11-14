import * as i18n from "i18n";
import Folders2GraphPlugin from "Main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { I18n } from "types/I18n";

export class SettingsTab extends PluginSettingTab {
	private __i18n: I18n = this.__getI18n();

	private __plugin: Folders2GraphPlugin;

	constructor(app: App, plugin: Folders2GraphPlugin) {
		super(app, plugin);
		this.__plugin = plugin;
	}

	/**
	 * Render the settings tab in the UI.
	 */
	public display(): void {
		let { containerEl } = this;

		containerEl.empty();
		new Setting(containerEl)
			.setName(this.__i18n.settings.hideRootNode.name)
			.setDesc(this.__i18n.settings.hideRootNode.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.hideRootNode).onChange((value) => {
					this.__plugin.settings.hideRootNode = value;
					this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});
	}

	/**
	 * Get the I18n object based on the language code stored in the Obsidian app localstorage.
	 * @returns The I18n object.
	 */
	private __getI18n(): I18n {
		const languageCode = window.localStorage.getItem("language");

		switch (languageCode) {
			case "fr":
				return i18n.frFR;
			default:
				return i18n.enUS;
		}
	}
}
