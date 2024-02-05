import { Configuration } from "webpack";
import TerserPlugin from "terser-webpack-plugin";
import CopyPlugin from "copy-webpack-plugin";

import * as paths from "../paths";
import { resolve } from "path";
import { EmptyFileWebpackPlugin } from "./plugins/EmptyFileWebPackPlugin/EmptyFileWebpackPlugin";

const isProduction = process.env.NODE_ENV === "production";

const configuration: Configuration = {
	mode: isProduction ? "production" : "development",
	entry: resolve(paths.SRC, paths.ENTRY_NAME),
	output: {
		path: paths.BUILD,
		filename: paths.BUNDLE_NAME,
		libraryTarget: "commonjs",
		clean: true,
	},
	optimization: {
		minimize: isProduction,
		minimizer: [
			new TerserPlugin({
				extractComments: !isProduction,
				minify: TerserPlugin.uglifyJsMinify,
				terserOptions: {},
			}),
		],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				use: "ts-loader",
				exclude: /node_modules/,
			},
		],
	},
	resolve: {
		modules: [paths.ROOT, "node_modules"],
		extensions: [".ts", ".js"],
	},
	plugins: [
		new CopyPlugin({
			patterns: [
				{
					from: "./manifest.json",
					to: paths.BUILD,
				},
				{
					from: "./LICENSE",
					to: paths.BUILD,
				},
			],
		}),
		!isProduction && new EmptyFileWebpackPlugin({ path: ".hotreload" }),
	],
	externals: {
		obsidian: "commonjs2 obsidian",
	},
};

export default configuration;
