import { existsSync, statSync } from "fs";

export function doesUrlExists(url: URL): boolean {
	return existsSync(url.toString());
}

export function doesUrlIsFile(url: URL, throwOnError: boolean = true): boolean {
	const doesExists = doesUrlExists(url);
	if (!doesExists) {
		return false;
	}

	return statSync(url.toString()).isFile();
}

export function doesUrlIsDirectory(url: URL): boolean {
	const doesExists = doesUrlExists(url);
	if (!doesExists) {
		return false;
	}

	return statSync(url.toString()).isDirectory();
}
