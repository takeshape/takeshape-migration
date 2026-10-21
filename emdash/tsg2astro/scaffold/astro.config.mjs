// Builds the site for Cloudflare Workers, with content in D1 and media in R2: npm run dev, build and deploy.
import cloudflare from "@astrojs/cloudflare";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import { shared } from "./astro.shared.mjs";

export default defineConfig({
	...shared({
		// coalesce sends the SELECTs a request issues together as one D1 batch (EmDash calls it experimental)
		database: d1({ binding: "DB", session: "auto", coalesce: true }),
		storage: r2({ binding: "MEDIA" }),
		imageEndpoint: new URL("./src/image-endpoint.ts", import.meta.url),
	}),
	adapter: cloudflare(),
});
