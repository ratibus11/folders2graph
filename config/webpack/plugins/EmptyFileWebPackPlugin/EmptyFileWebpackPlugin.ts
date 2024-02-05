import { Compiler } from "webpack";
import { EmptyFileWebpackPluginOptions } from "./EmptyFileWebpackPluginOptions";
import { join, resolve } from "path";
import { writeFileSync } from "fs";
import { doesUrlExists, doesUrlIsDirectory } from "../../../tasks/utils/path";

export class EmptyFileWebpackPlugin {
	private options: EmptyFileWebpackPluginOptions;

	constructor(options: EmptyFileWebpackPluginOptions) {
		this.options = options;
	}

	apply(compiler: Compiler) {
		compiler.hooks.afterEmit.tap("EmptyFileWebpackPlugin", (compilation) => {
			const outputPath = compiler.options.output.path ?? process.cwd();
			const filePath = new URL(join(outputPath, this.options.path));

			if (doesUrlExists(filePath)) {
				if (this.options.overwrite) {
					throw new Error(`File path at '${filePath}' already exists.`);
				}
				return;
			}

			const folderPath = new URL(resolve(filePath.toString(), ".."));
			if (!doesUrlExists(folderPath)) {
				throw new Error(`Folder path at '${folderPath}' does not exist.`);
			}
			if (!doesUrlIsDirectory(folderPath)) {
				throw new Error(`Folder path at '${folderPath}' is not a directory.`);
			}

			writeFileSync(filePath.toString(), "");
		});
	}
}
