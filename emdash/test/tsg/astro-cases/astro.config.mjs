// The template differential test builds this project. Pages are prerendered to dist/ as plain files.
import node from "@astrojs/node";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	adapter: node({ mode: "standalone" }),
	compressHTML: false,
	build: { format: "file" },
	devToolbar: { enabled: false },
});
