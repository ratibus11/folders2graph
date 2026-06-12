import { getI18n } from "i18n";
import Folders2GraphPlugin from "Main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { I18n } from "types/I18n";
import { Settings } from "interfaces/Settings";

/**
 * Obsidian settings tab for the Folders 2 Graph plugin.
 *
 * @remarks
 * Renders toggle and colour-picker controls for each plugin setting. Each
 * control mutates `plugin.settings` directly, then calls
 * `plugin.saveSettings()` and `plugin.refreshGraphLeaves()` so the graph view
 * reflects the change immediately.
 *
 * The controls are organised in thematic groups replicating the DOM structure
 * of Obsidian's native settings pages: each group is a `div.setting-group`
 * containing the heading and a `div.setting-items` card that visually merges
 * the settings it contains (shared background, hairline separators). Core CSS
 * styles those classes, so the look follows the active theme automatically.
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
	 * Creates a native-looking settings group: a `div.setting-group` wrapper
	 * holding the section heading and a `div.setting-items` card in which the
	 * caller renders the section's controls.
	 *
	 * @param containerEl Parent element of the group (the tab's container).
	 * @param title       Localised section title.
	 * @returns The `div.setting-items` element to which the section's
	 *   `Setting` controls should be attached.
	 */
	private __createSettingsGroup(containerEl: HTMLElement, title: string): HTMLElement {
		const group = containerEl.createDiv({ cls: "setting-group" });
		new Setting(group).setName(title).setHeading();
		return group.createDiv({ cls: "setting-items" });
	}

	/**
	 * Render the settings tab in the UI.
	 *
	 * @remarks
	 * Called by Obsidian whenever the settings panel is opened or the tab is
	 * selected. Clears the container element and rebuilds all controls from
	 * scratch. Groups are ordered by thematic importance: folders, headings,
	 * folder filtering, weighting.
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

		// ── Folders ─────────────────────────────────────────────────────────
		const foldersGroup = this.__createSettingsGroup(containerEl, this.__i18n.settings.sections.folders);

		new Setting(foldersGroup)
			.setName(this.__i18n.settings.showFolderNodes.name)
			.setDesc(this.__i18n.settings.showFolderNodes.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.showFolderNodes).onChange(async (value) => {
					this.__plugin.settings.showFolderNodes = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(foldersGroup)
			.setName(this.__i18n.settings.hideRootNode.name)
			.setDesc(this.__i18n.settings.hideRootNode.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.hideRootNode).onChange(async (value) => {
					this.__plugin.settings.hideRootNode = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(foldersGroup)
			.setName(this.__i18n.settings.nodeColor.name)
			.setDesc(this.__i18n.settings.nodeColor.desc)
			.addColorPicker((component) => {
				component.setValue(this.__plugin.settings.nodeColor).onChange(async (value) => {
					this.__plugin.settings.nodeColor = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		// ── Headings ────────────────────────────────────────────────────────
		const headingsGroup = this.__createSettingsGroup(containerEl, this.__i18n.settings.sections.headings);

		new Setting(headingsGroup)
			.setName(this.__i18n.settings.showHeadingNodes.name)
			.setDesc(this.__i18n.settings.showHeadingNodes.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.showHeadingNodes).onChange(async (value) => {
					this.__plugin.settings.showHeadingNodes = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(headingsGroup)
			.setName(this.__i18n.settings.headingNodeColor.name)
			.setDesc(this.__i18n.settings.headingNodeColor.desc)
			.addColorPicker((component) => {
				component.setValue(this.__plugin.settings.headingNodeColor).onChange(async (value) => {
					this.__plugin.settings.headingNodeColor = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		new Setting(headingsGroup)
			.setName(this.__i18n.settings.headingLinkAnchorMode.name)
			.setDesc(this.__i18n.settings.headingLinkAnchorMode.desc)
			.addDropdown((component) => {
				component
					.addOption("file-file", this.__i18n.settings.headingLinkAnchorMode.optionFileFile)
					.addOption("file-heading", this.__i18n.settings.headingLinkAnchorMode.optionFileHeading)
					.addOption("heading-file", this.__i18n.settings.headingLinkAnchorMode.optionHeadingFile)
					.addOption("heading-heading", this.__i18n.settings.headingLinkAnchorMode.optionHeadingHeading)
					.setValue(this.__plugin.settings.headingLinkAnchorMode)
					.onChange(async (value: string) => {
						this.__plugin.settings.headingLinkAnchorMode = value as Settings["headingLinkAnchorMode"];
						await this.__plugin.saveSettings();
						this.__plugin.refreshGraphLeaves();
					});
			});

		// ── Folder filtering ────────────────────────────────────────────────
		const filterGroup = this.__createSettingsGroup(containerEl, this.__i18n.settings.sections.folderFilter);

		new Setting(filterGroup)
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

		new Setting(filterGroup)
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

		new Setting(filterGroup)
			.setName(this.__i18n.settings.folderFilterHideFiles.name)
			.setDesc(this.__i18n.settings.folderFilterHideFiles.desc)
			.addToggle((component) => {
				component.setValue(this.__plugin.settings.folderFilterHideFiles).onChange(async (value) => {
					this.__plugin.settings.folderFilterHideFiles = value;
					await this.__plugin.saveSettings();
					this.__plugin.refreshGraphLeaves();
				});
			});

		// ── Weighting ───────────────────────────────────────────────────────
		const weightingGroup = this.__createSettingsGroup(containerEl, this.__i18n.settings.sections.weighting);

		new Setting(weightingGroup)
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
