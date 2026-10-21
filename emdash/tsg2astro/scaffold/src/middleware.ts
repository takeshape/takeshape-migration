// takeshape-ssg wrote every page as <folder>/index.html, and its host served it at <folder>/ and at
// <folder>/index.html. Old links and sitemaps sometimes use the second, so it gets the same page here.
// With tsg.yml's htmlCompression on, takeshape-ssg also ran minimize over every page; the site's pages get the
// same here, while EmDash's own (/_emdash/) stay as EmDash sends them. Each request runs with the site's public
// origin, which image and file URLs start with, as TakeShape's CDN URLs were absolute.
import type { MiddlewareHandler } from "astro";
import { indexFileTarget } from "./lib/takeshape/context.ts";
import { mediaImageTarget } from "./lib/takeshape/imgix.ts";
import { compressResponse } from "./lib/takeshape/html-compression.ts";
import { publicOrigin, withPublicOrigin } from "./lib/takeshape/public-origin.ts";
import { htmlCompression } from "./lib/takeshape/site.ts";

export const onRequest: MiddlewareHandler = (context, next) =>
	withPublicOrigin(publicOrigin(context.url), async () => {
		// TakeShape's asset url took imgix parameters, so EmDash media with them goes through the image endpoint
		const media = mediaImageTarget(context.url);
		if (media) return context.rewrite(media);
		const target = indexFileTarget(context.url);
		const response = target ? await context.rewrite(target) : await next();
		return compressResponse(response, context.url.pathname, htmlCompression);
	});
