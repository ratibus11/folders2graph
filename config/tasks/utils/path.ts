import { existsSync, statSync } from "fs";
import { fileURLToPath } from "url";

export function doesUrlExists(url: URL): boolean {
	return existsSync(fileURLToPath(url));
}

export function doesUrlIsFile(url: URL, throwOnError: boolean = true): boolean {
	const doesExists = doesUrlExists(url);
	if (!doesExists) {
		return false;
	}

	return statSync(fileURLToPath(url)).isFile();
}

export function doesUrlIsDirectory(url: URL): boolean {
	const doesExists = doesUrlExists(url);
	if (!doesExists) {
		return false;
	}

	return statSync(fileURLToPath(url)).isDirectory();
}
