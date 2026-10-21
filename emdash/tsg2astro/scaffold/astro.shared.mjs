// The Astro options both configs share: astro.config.mjs (Cloudflare) and astro.node.config.mjs (Node).
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { htmlparser2Root } from "./takeshape-vite.mjs";

// EmDash reads EMDASH_SITE_URL from process.env when the site builds, and only then registers its media for
// resizing. Astro does not put .env there, so load it here. A variable already set in the shell wins.
try {
	process.loadEnvFile();
} catch {
	// no .env
}

/**
 * The image endpoint, where src/lib/takeshape/filters.ts points images that pass a size (IMAGE_ENDPOINT in
 * src/lib/takeshape/imgix.ts). Each config gives its own file: the Images binding on Workers, sharp on Node.
 */
function takeshapeImages(entrypoint) {
	return {
		name: "takeshape-images",
		hooks: {
			"astro:config:setup": ({ injectRoute }) => injectRoute({ pattern: "/_takeshape/image", entrypoint, prerender: false }),
		},
	};
}

/** The shared options, with EmDash on the config's database and storage, and the config's image endpoint. */
export function shared({ database, storage, imageEndpoint }) {
	return {
		output: "server",
		// The templates translated from Nunjucks rely on the whitespace between inline elements.
		compressHTML: false,
		trailingSlash: "ignore",
		image: {
			layout: "constrained",
			responsiveStyles: true,
		},
		devToolbar: { enabled: false },
		// One copy of moment. Without this, the Workers bundle gives moment-timezone moment's ES build and
		// moment's locale files its CommonJS build, so a locale that src/lib/takeshape/site.ts loads never
		// reaches the date filter.
		vite: {
			resolve: { alias: [{ find: /^moment$/, replacement: "moment/moment.js" }] },
			// The server's dependency optimizer (workerd under astro dev) cannot resolve a require minimize's parser makes
			environments: { ssr: { optimizeDeps: { rolldownOptions: { plugins: [htmlparser2Root()] } } } },
		},
		integrations: [react(), emdash({ database, storage }), takeshapeImages(imageEndpoint)],
	};
}
