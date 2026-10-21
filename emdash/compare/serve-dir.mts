// Serves a folder the way the old static host does, for tests and for comparing against a build folder.
// /a/ serves a/index.html, /a gives 301 to /a/ when a/index.html exists, a file path serves the file, anything else is 404.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

async function kind(path: string): Promise<"file" | "dir" | null> {
	try {
		const s = await stat(path);
		return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
	} catch {
		return null;
	}
}

export function serveDir(dir: string): Promise<{ url: string; close(): Promise<void> }> {
	const root = resolve(dir);
	const server = createServer(async (req, res) => {
		const send = (status: number, headers: Record<string, string>, body?: Uint8Array | string) => {
			res.writeHead(status, headers);
			res.end(req.method === "HEAD" ? undefined : body);
		};
		const notFound = () => send(404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
		try {
			const raw = new URL(req.url ?? "/", "http://localhost");
			let rel: string;
			try {
				rel = decodeURIComponent(raw.pathname);
			} catch {
				return send(400, { "content-type": "text/plain" }, "Bad request");
			}
			const target = resolve(join(root, rel));
			if (target !== root && !target.startsWith(root + sep)) return notFound();
			const k = await kind(target);
			if (rel.endsWith("/")) {
				const index = join(target, "index.html");
				if (k === "dir" && (await kind(index)) === "file") return send(200, { "content-type": TYPES[".html"] }, await readFile(index));
				return notFound();
			}
			if (k === "file") return send(200, { "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream" }, await readFile(target));
			if (k === "dir" && (await kind(join(target, "index.html"))) === "file") return send(301, { location: `${raw.pathname}/${raw.search}` });
			return notFound();
		} catch {
			send(500, { "content-type": "text/plain" }, "Server error");
		}
	});
	return new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolveListen({
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
