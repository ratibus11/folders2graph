import { getI18n } from "i18n";
import Folders2GraphPlugin from "Main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { I18n } from "types/I18n";

/**
 * Obsidian settings tab for the Folders 2 Graph plugin.
 *
 * @remarks
 * Renders toggle and colour-picker controls for each plugin setting. Each
 * control mutates `plugin.settings` directly, then calls
 * `plugin.saveSettings()` and `plugin.refreshGraphLeaves()` so the graph view
 * reflects the change immediately.
 */
export class SettingsTab extends PluginSettingTab {
	private __i18n: I18n = getI18n();

	private __plugin: Folders2GraphPlugin;

	/**
	 * @param app    Obsidian application instance, forwarded to the base class.
	 * @param plugin Plugin instance whose `settings`, `saveSettings`, and
	 *   `refreshGraphLeaves` are used by the controls.
	 */
	constructor(app: App, plugin: Folders2GraphPlugin) {
		super(app, plugin);
		this.__plugin = plugin;
	}

	/**
	 * Render the settings tab in the UI.
	 *
	 * @remarks
	 * Called by Obsidian whenever the settings panel is opened or the tab is
	 * selected. Clears the container element and rebuilds all controls from
	 * scratch.
	 */
	public override display(): void {
		let { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName(this.__i18n.settings.showFolderNodes.name)
			.setDesc(this.__i18n.settings.showFolderNodes.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.showFolderNodes).onChange(async (value) => {
					this.__plugin.settings.showFolderNodes = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(containerEl)
			.setName(this.__i18n.settings.hideRootNode.name)
			.setDesc(this.__i18n.settings.hideRootNode.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.hideRootNode).onChange(async (value) => {
					this.__plugin.settings.hideRootNode = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(containerEl)
			.setName(this.__i18n.settings.nodeColor.name)
			.setDesc(this.__i18n.settings.nodeColor.desc)
			.addColorPicker((component) => {
				component.setValue(this.__plugin.settings.nodeColor).onChange(async (value) => {
					this.__plugin.settings.nodeColor = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(containerEl)
			.setName(this.__i18n.settings.showHeadingNodes.name)
			.setDesc(this.__i18n.settings.showHeadingNodes.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.showHeadingNodes).onChange(async (value) => {
					this.__plugin.settings.showHeadingNodes = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(containerEl)
			.setName(this.__i18n.settings.headingNodeColor.name)
			.setDesc(this.__i18n.settings.headingNodeColor.desc)
			.addColorPicker((component) => {
				component.setValue(this.__plugin.settings.headingNodeColor).onChange(async (value) => {
					this.__plugin.settings.headingNodeColor = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});
	}

}
