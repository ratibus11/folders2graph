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
	 * Called by Obsidian when the settings panel is closed or another tab is
	 * selected. Cancels any pending debounce timer so it cannot fire after the
	 * UI has been torn down.
	 */
	public override hide(): void {
		if (this.__filterListRefreshTimer !== null) {
			window.clearTimeout(this.__filterListRefreshTimer);
			this.__filterListRefreshTimer = null;
		}
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
		// Cancel any timer left over from a previous display cycle; the UI is
		// being rebuilt from scratch so a stale callback would be meaningless.
		if (this.__filterListRefreshTimer !== null) {
			window.clearTimeout(this.__filterListRefreshTimer);
			this.__filterListRefreshTimer = null;
		}

		let { containerEl } = this;

		containerEl.empty();

		// General settings come first, without a heading, then the controls are
		// grouped under section headings — mirroring Obsidian's own settings pages.
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

		new Setting(containerEl).setName(this.__i18n.settings.sections.folders).setHeading();

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

		new Setting(containerEl).setName(this.__i18n.settings.sections.folderFilter).setHeading();

		new Setting(containerEl)
			.setName(this.__i18n.settings.folderFilterMode.name)
			.setDesc(this.__i18n.settings.folderFilterMode.desc)
			.addDropdown((component) => {
				component
					.addOption("exclude", this.__i18n.settings.folderFilterMode.optionExclude)
					.addOption("include", this.__i18n.settings.folderFilterMode.optionInclude)
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
						// Fire-and-forget: onChange must stay synchronous (the debounce below
						// relies on a non-async handler), and saveSettings already serialises
						// concurrent calls internally, so skipping await here is safe.
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
			.setName(this.__i18n.settings.folderFilterHideFiles.name)
			.setDesc(this.__i18n.settings.folderFilterHideFiles.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.folderFilterHideFiles).onChange(async (value) => {
					this.__plugin.settings.folderFilterHideFiles = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(containerEl).setName(this.__i18n.settings.sections.headings).setHeading();

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
