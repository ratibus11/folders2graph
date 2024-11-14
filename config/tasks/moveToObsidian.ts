import dotenv from "dotenv";
import { resolve } from "path";

import * as paths from "../paths";
import { cpSync, mkdirSync, readFileSync } from "fs";
import { doesUrlExists, doesUrlIsDirectory, doesUrlIsFile } from "./utils/path";
import { fileURLToPath, pathToFileURL } from "url";

const envFileName = ".env.test";

function initEnv() {
	dotenv.config({ path: resolve(paths.CONFIG, ".env", envFileName) });
}

function getVaultUrl(): URL {
	const vaultPathEnvKey = "VAULT_PATH";
	const vaultPathString = process.env[vaultPathEnvKey];

	if (!vaultPathString) {
		throw new Error(`${envFileName} value from key ${vaultPathEnvKey} is not defined.`);
	}

	const vaultUrl = pathToFileURL(vaultPathString);

	if (!doesUrlExists(vaultUrl)) {
		throw new Error(`${envFileName} value from key ${vaultPathEnvKey} at '${vaultPathString}' does not exist.`);
	}
	if (!doesUrlIsDirectory(vaultUrl)) {
		throw new Error(`${envFileName} value from key ${vaultPathEnvKey} at '${vaultPathString}' is not a directory.`);
	}

	return vaultUrl;
}

function getBuildPath(): URL {
	const buildPathString = paths.BUILD;
	const buildPath = pathToFileURL(buildPathString);

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
	const manifestPath = pathToFileURL(manifestPathString);

	if (!doesUrlExists(manifestPath)) {
		throw new Error(`Plugin manifest path at '${manifestPathString}' does not exist.`);
	}
	if (!doesUrlIsFile(manifestPath)) {
		throw new Error(`Plugin manifest path at '${manifestPathString}' is not a file.`);
	}

	let rawManifest: string;
	let parsedManifest: any;

	try {
		rawManifest = readFileSync(fileURLToPath(manifestPath), "utf-8");
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

	const vaultDotObsidianFolderUrl = pathToFileURL(resolve(fileURLToPath(vaultUrl), ".obsidian"));
	if (!doesUrlExists(vaultDotObsidianFolderUrl)) {
		console.log(`Creating .obsidian directory in vault at '${vaultDotObsidianFolderUrl}'.`);
		mkdirSync(vaultDotObsidianFolderUrl);
	}
	if (!doesUrlIsDirectory(vaultDotObsidianFolderUrl)) {
		throw new Error(`.obsidian path at '${vaultDotObsidianFolderUrl}' is not a directory.`);
	}

	const vaultPluginsFolderUrl = pathToFileURL(resolve(fileURLToPath(vaultDotObsidianFolderUrl), "plugins"));
	if (!doesUrlExists(vaultPluginsFolderUrl)) {
		console.log(`Creating plugins directory in vault at '${vaultPluginsFolderUrl}'.`);
		mkdirSync(vaultPluginsFolderUrl);
	}

	const pluginFolderUrl = pathToFileURL(resolve(fileURLToPath(vaultPluginsFolderUrl), pluginName));
	cpSync(fileURLToPath(buildPath), fileURLToPath(pluginFolderUrl), { recursive: true, force: true });
}

main();
