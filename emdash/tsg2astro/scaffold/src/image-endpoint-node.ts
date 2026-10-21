// The image endpoint on Node, /_takeshape/image (astro.node.config.mjs adds the route). It resizes EmDash media with
// sharp, by the imgix parameters src/lib/takeshape/imgix.ts maps. src/lib/takeshape/image-endpoint.ts does the rest.
import type { APIRoute } from "astro";
import { mediaStorage, serveImage } from "./lib/takeshape/image-endpoint.ts";
import { sharpTransform } from "./lib/takeshape/image-sharp.ts";

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) => serveImage(request, mediaStorage(locals), sharpTransform);
