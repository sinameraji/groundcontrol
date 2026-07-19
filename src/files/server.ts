import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

/**
 * Extension → Content-Type. Text types carry charset=utf-8.
 *
 * Mission artifacts are SANDBOX-AUTHORED (a prompt-injected agent controls
 * their bytes), so nothing is ever served as active content: html/svg/js ship
 * as text/plain, every response carries nosniff + a deny-all CSP. A
 * booby-trapped report.html must never script this origin — it could read the
 * whole artifact archive.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".html": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".css": "text/css; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/** On every response: no MIME sniffing, no scripting, no embedding. */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Uniform refusal — never reveals whether/why a path was rejected. */
function notFound(res: http.ServerResponse, method: string): void {
  const body = "not found\n";
  res.writeHead(404, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(method === "HEAD" ? undefined : body);
}

function badRequest(res: http.ServerResponse, method: string): void {
  const body = "bad request\n";
  res.writeHead(400, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(method === "HEAD" ? undefined : body);
}

async function serveDirectory(
  realRoot: string,
  realTarget: string,
  rawPath: string,
  method: string,
  res: http.ServerResponse
): Promise<void> {
  const entries = await readdir(realTarget, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const files = entries
    .filter((e) => !e.isDirectory())
    .map((e) => e.name)
    .sort();

  // Absolute hrefs built from the (still-encoded) request path so links work
  // whether or not the request had a trailing slash.
  const urlDir = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
  const items: string[] = [];
  if (realTarget !== realRoot) {
    items.push(`<li><a href="${escapeHtml(`${urlDir}../`)}">../</a></li>`);
  }
  for (const name of dirs) {
    const href = escapeHtml(urlDir + encodeURIComponent(name) + "/");
    items.push(`<li><a href="${href}">${escapeHtml(name)}/</a></li>`);
  }
  for (const name of files) {
    const href = escapeHtml(urlDir + encodeURIComponent(name));
    items.push(`<li><a href="${href}">${escapeHtml(name)}</a></li>`);
  }

  const title = escapeHtml(decodeURIComponent(urlDir));
  const html =
    `<!doctype html>\n<meta charset="utf-8">\n<title>${title}</title>\n` +
    `<h1>${title}</h1>\n<ul>\n${items.join("\n")}\n</ul>\n`;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(method === "HEAD" ? undefined : html);
}

async function handle(
  realRoot: string,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    const body = "method not allowed\n";
    res.writeHead(405, {
      ...SECURITY_HEADERS,
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    badRequest(res, method);
    return;
  }
  if (decoded.includes("\0")) {
    badRequest(res, method);
    return;
  }

  // Resolve against the REAL root, then require the target's realpath to stay
  // inside it — refuses traversal and symlinks out of the tree alike.
  const target = path.resolve(realRoot, `.${path.sep}${decoded}`);
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    notFound(res, method);
    return;
  }
  if (
    realTarget !== realRoot &&
    !realTarget.startsWith(realRoot + path.sep)
  ) {
    notFound(res, method);
    return;
  }

  let st;
  try {
    st = await stat(realTarget);
  } catch {
    notFound(res, method);
    return;
  }

  if (st.isDirectory()) {
    await serveDirectory(realRoot, realTarget, rawPath, method, res);
    return;
  }
  if (!st.isFile()) {
    notFound(res, method);
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": contentTypeFor(realTarget),
    "Content-Length": st.size,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(realTarget);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/**
 * Read-only static file server for ARTIFACTS_ROOT.
 *
 * Rules (security-critical — see DESIGN.md):
 *  - binds `host` (default 127.0.0.1) ONLY; tailnet exposure happens via
 *    `tailscale serve` in front of it
 *  - GET and HEAD only → anything else 405
 *  - decode the URL path, resolve against root, then fs.realpath BOTH the
 *    root and the target and require target ∈ root — rejects traversal AND
 *    symlinks pointing out of the tree → 404 (never reveal why)
 *  - directories: minimal HTML listing with escaped names, files linked
 *    relative; files: streamed with a Content-Type from the extension map
 *    and charset=utf-8 for text
 *  - artifacts are sandbox-authored: html/svg/js are served as text/plain and
 *    every response carries nosniff + a deny-all CSP, so agent output can
 *    never run as active content on this origin
 *  - no writes, no uploads, no directory creation, ever
 */
export async function startFileServer(
  root: string,
  port: number,
  host = "127.0.0.1"
): Promise<http.Server> {
  const realRoot = await realpath(root);
  const server = http.createServer((req, res) => {
    void handle(realRoot, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return await new Promise<http.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
