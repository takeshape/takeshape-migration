// Vite plugins the translated site needs, for astro.shared.mjs. Kept apart from it so they load without Astro.
import { dirname, join } from "node:path";

/**
 * htmlparser2 3.x, which minimize 2.2.0 (tsg.yml's htmlCompression) loads, requires its own package root as "../".
 * Vite's dependency optimizer for workerd could not resolve that, so `astro dev` with the Cloudflare config stopped
 * before it started. This points the require at the package's lib/index.js. The production build resolves it on its own.
 */
export function htmlparser2Root() {
	return {
		name: "takeshape-htmlparser2-root",
		resolveId(source, importer) {
			if (source === "../" && importer && /[\\/]htmlparser2[\\/]lib[\\/][^\\/]+\.js$/.test(importer)) return join(dirname(importer), "index.js");
			return null;
		},
	};
}
