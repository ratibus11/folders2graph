import { resolve } from "path";

export const ROOT = resolve(process.cwd());
export const SRC = resolve(ROOT, "src");
export const BUILD = resolve(ROOT, "build");

export const ENTRY_NAME = "Main.ts";
export const BUNDLE_NAME = "main.js";

export const CONFIG = resolve(ROOT, "config");
