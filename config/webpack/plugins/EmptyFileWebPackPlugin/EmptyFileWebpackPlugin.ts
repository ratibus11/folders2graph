import { Compiler } from "webpack";
import { EmptyFileWebpackPluginOptions } from "./EmptyFileWebpackPluginOptions";
import { join, resolve } from "path";
import { writeFileSync } from "fs";
import { doesUrlExists, doesUrlIsDirectory } from "../../../tasks/utils/path";
import { fileURLToPath, pathToFileURL } from "url";

export class EmptyFileWebpackPlugin {
	private options: EmptyFileWebpackPluginOptions;

	constructor(options: EmptyFileWebpackPluginOptions) {
		this.options = options;
	}

	apply(compiler: Compiler) {
		compiler.hooks.afterEmit.tap("EmptyFileWebpackPlugin", (compilation) => {
			const outputPath = compiler.options.output.path ?? process.cwd();
			const filePath = pathToFileURL(join(outputPath, this.options.path));

			if (doesUrlExists(filePath)) {
				if (this.options.overwrite) {
					throw new Error(`File path at '${filePath}' already exists.`);
				}
				return;
			}

			const folderPath = pathToFileURL(resolve(fileURLToPath(filePath), ".."));
			if (!doesUrlExists(folderPath)) {
				throw new Error(`Folder path at '${folderPath}' does not exist.`);
			}
			if (!doesUrlIsDirectory(folderPath)) {
				throw new Error(`Folder path at '${folderPath}' is not a directory.`);
			}

			writeFileSync(fileURLToPath(filePath), "");
		});
	}
}
