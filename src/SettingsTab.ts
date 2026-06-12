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

	/** Timer handle used to debounce graph refreshes when the filter list textarea changes. */
	private __filterListRefreshTimer: number | null = null;

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
			.setName(this.__i18n.settings.folderFilterMode.name)
			.setDesc(this.__i18n.settings.folderFilterMode.desc)
			.addDropdown((component) => {
				component
					.addOption("exclude", "Exclude")
					.addOption("include", "Include")
					.setValue(this.__plugin.settings.folderFilterMode)
					.onChange(async (value: string) => {
						this.__plugin.settings.folderFilterMode = value as "include" | "exclude";
						await this.__plugin.saveSettings();
						this.__plugin.refreshGraphLeaves();
					});
			});

		new Setting(containerEl)
			.setName(this.__i18n.settings.folderFilterList.name)
			.setDesc(this.__i18n.settings.folderFilterList.desc)
			.addTextArea((component) => {
				component
					.setValue(this.__plugin.settings.folderFilterList.join("\n"))
					.onChange((raw: string) => {
						// Parse and normalise: trim, backslashes→slashes, strip leading/trailing
						// slashes, drop empties, deduplicate.
						const normalised = [
							...new Set(
								raw
									.split("\n")
									.map((line) =>
										line
											.trim()
											.replace(/\\/g, "/")
											.replace(/^\/+|\/+$/g, ""),
									)
									.filter((line) => line.length > 0),
							),
						];
						this.__plugin.settings.folderFilterList = normalised;
						// Fire-and-forget save; do not await so the onChange handler stays sync.
						void this.__plugin.saveSettings();
						// Debounce the graph refresh to avoid reloading on every keystroke.
						if (this.__filterListRefreshTimer !== null) {
							window.clearTimeout(this.__filterListRefreshTimer);
						}
						this.__filterListRefreshTimer = window.setTimeout(() => {
							this.__filterListRefreshTimer = null;
							this.__plugin.refreshGraphLeaves();
						}, 600);
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

		new Setting(containerEl)
			.setName(this.__i18n.settings.weightNodesBySubtree.name)
			.setDesc(this.__i18n.settings.weightNodesBySubtree.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.weightNodesBySubtree).onChange(async (value) => {
					this.__plugin.settings.weightNodesBySubtree = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});
	}

}
