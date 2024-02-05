import dotenv from "dotenv";
import { resolve } from "path";

import * as paths from "../paths";
import { cpSync, mkdirSync, readFileSync } from "fs";
import { doesUrlExists, doesUrlIsDirectory, doesUrlIsFile } from "./utils/path";

function initEnv() {
	dotenv.config({ path: resolve(paths.CONFIG, ".env/.env.test") });
}

function getVaultUrl(): URL {
	const vaultPathEnvKey = "VAULT_PATH";
	const vaultPathString = process.env[vaultPathEnvKey];

	if (!vaultPathString) {
		throw new Error(`.env value from key ${vaultPathEnvKey} is not defined.`);
	}

	const vaultUrl = new URL(vaultPathString);

	if (!doesUrlExists(vaultUrl)) {
		throw new Error(`.env value from key ${vaultPathEnvKey} at '${vaultPathString}' does not exist.`);
	}
	if (!doesUrlIsDirectory(vaultUrl)) {
		throw new Error(`.env value from key ${vaultPathEnvKey} at '${vaultPathString}' is not a directory.`);
	}

	return vaultUrl;
}

function getBuildPath(): URL {
	const buildPathString = paths.BUILD;
	const buildPath = new URL(buildPathString);

	if (!doesUrlExists(buildPath)) {
		throw new Error(`Build path at '${buildPathString}' does not exist.`);
	}
	if (!doesUrlIsDirectory(buildPath)) {
		throw new Error(`Build path at '${buildPathString}' is not a directory.`);
	}

	return buildPath;
}

function getPluginName(): string {
	const manifestPathString = resolve(paths.ROOT, "manifest.json");
	const manifestPath = new URL(manifestPathString);

	if (!doesUrlExists(manifestPath)) {
		throw new Error(`Plugin manifest path at '${manifestPathString}' does not exist.`);
	}
	if (!doesUrlIsFile(manifestPath)) {
		throw new Error(`Plugin manifest path at '${manifestPathString}' is not a file.`);
	}

	let rawManifest: string;
	let parsedManifest: any;

	try {
		rawManifest = readFileSync(manifestPath.toString(), "utf-8");
	} catch (e) {
		throw new Error(`Could not read plugin manifest file at '${manifestPathString}': ${e}`);
	}

	try {
		parsedManifest = JSON.parse(rawManifest);
	} catch (e) {
		throw new Error(`Could not parse plugin manifest file at '${manifestPathString}': ${e}`);
	}

	if (!parsedManifest.id) {
		throw new Error(`Plugin manifest file at '${manifestPathString}' does not contain an 'id' field.`);
	}

	const pluginId = String(parsedManifest.id);
	if (!/^[a-zA-Z0-9\-_]+$/.exec(pluginId)) {
		throw new Error(
			`Plugin manifest file at '${manifestPathString}' contains an invalid 'id' field. Please use only alphanumeric characters, dashes and underscores.`,
		);
	}

	return pluginId;
}

function main() {
	initEnv();
	const vaultUrl = getVaultUrl();
	const buildPath = getBuildPath();
	const pluginName = getPluginName();

	if (!doesUrlExists(vaultUrl)) {
		throw new Error(`Vault path at '${vaultUrl}' does not exist.`);
	}
	if (!doesUrlIsDirectory(vaultUrl)) {
		throw new Error(`Vault path at '${vaultUrl}' is not a directory.`);
	}

	const vaultDotObsidianFolderUrl = new URL(resolve(vaultUrl.toString(), ".obsidian"));
	if (!doesUrlExists(vaultDotObsidianFolderUrl)) {
		console.log(`Creating .obsidian directory in vault at '${vaultDotObsidianFolderUrl}'.`);
		mkdirSync(vaultDotObsidianFolderUrl);
	}
	if (!doesUrlIsDirectory(vaultDotObsidianFolderUrl)) {
		throw new Error(`.obsidian path at '${vaultDotObsidianFolderUrl}' is not a directory.`);
	}

	const vaultPluginsFolderUrl = new URL(resolve(vaultDotObsidianFolderUrl.toString(), "plugins"));
	if (!doesUrlExists(vaultPluginsFolderUrl)) {
		console.log(`Creating plugins directory in vault at '${vaultPluginsFolderUrl}'.`);
		mkdirSync(vaultPluginsFolderUrl);
	}

	const pluginFolderUrl = new URL(resolve(vaultPluginsFolderUrl.toString(), pluginName));
	cpSync(buildPath.toString(), pluginFolderUrl.toString(), { recursive: true, force: true });
}

main();
