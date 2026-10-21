// Runs the site on Node, with content in data.db and media in uploads/: npm run dev:node, build:node and start:node.
import node from "@astrojs/node";
import { defineConfig } from "astro/config";
import { local } from "emdash/astro";
import { sqlite } from "emdash/db";
import { shared } from "./astro.shared.mjs";

export default defineConfig({
	...shared({
		database: sqlite({ url: "file:./data.db" }),
		storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
		imageEndpoint: new URL("./src/image-endpoint-node.ts", import.meta.url),
	}),
	adapter: node({ mode: "standalone" }),
});
