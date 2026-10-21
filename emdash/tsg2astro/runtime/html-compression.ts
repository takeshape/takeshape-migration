/**
 * tsg.yml `htmlCompression`: takeshape-ssg ran minimize 2.2.0 over every page it wrote.
 * The middleware runs the same over each HTML response, with the options
 * site.ts holds, so pages print as the old site's did. minimize loads on the first page that needs it.
 */
type Minimizer = { parse(html: string): string };

const minimizers = new Map<string, Promise<Minimizer>>();

export async function compressHtml(html: string, options: Record<string, unknown>): Promise<string> {
	const key = JSON.stringify(options);
	let minimizer = minimizers.get(key);
	if (!minimizer) {
		minimizer = import("minimize").then((m) => new m.default(options));
		minimizers.set(key, minimizer);
	}
	return (await minimizer).parse(html);
}

/**
 * A response with htmlCompression applied (`options` null when tsg.yml has it off): HTML pages only. EmDash's own
 * (/_emdash/) stay as EmDash sends them, and so does an answer without a body (304, 204, 205), which a Response
 * cannot be given one for.
 */
export async function compressResponse(response: Response, pathname: string, options: Record<string, unknown> | null): Promise<Response> {
	if (!options || pathname.startsWith("/_emdash/") || response.body === null || !response.headers.get("content-type")?.startsWith("text/html")) return response;
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(await compressHtml(await response.text(), options), { status: response.status, statusText: response.statusText, headers });
}
