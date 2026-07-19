import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFileServer } from "../src/files/server.js";

const NASTY = "<img src=x>.txt";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw client so traversal paths reach the server byte-for-byte. */
function rawRequest(
  port: number,
  method: string,
  path: string
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startFileServer", () => {
  let root: string;
  let outside: string;
  let servers: http.Server[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gc-files-"));
    outside = await mkdtemp(join(tmpdir(), "gc-outside-"));
    servers = [];
    await writeFile(join(root, "report.md"), "# hi\n", "utf8");
    await mkdir(join(root, "m-1"));
    await writeFile(join(root, "m-1", NASTY), "nasty\n", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
  });

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve()))
      )
    );
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  async function start(): Promise<number> {
    const server = await startFileServer(root, 0);
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  it("serves a file with the right content-type and length", async () => {
    const port = await start();
    const res = await rawRequest(port, "GET", "/report.md");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-length"]).toBe(String(res.body.length));
    expect(res.body).toBe("# hi\n");
  });

  it("HTML-escapes nasty filenames in directory listings", async () => {
    const port = await start();
    const res = await rawRequest(port, "GET", "/m-1/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).not.toContain("<img");
    expect(res.body).toContain("&lt;img src=x&gt;.txt");
    // href is percent-encoded, and a subdirectory listing links back up.
    expect(res.body).toContain("%3Cimg%20src%3Dx%3E.txt");
    expect(res.body).toContain("../");
  });

  it("rejects raw path traversal with 404", async () => {
    const port = await start();
    const res = await rawRequest(port, "GET", "/../../../../etc/passwd");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("root:");
  });

  it("rejects encoded traversal with 404 and %00 with 400", async () => {
    const port = await start();
    const res = await rawRequest(
      port,
      "GET",
      "/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"
    );
    expect(res.status).toBe(404);
    const nul = await rawRequest(port, "GET", "/report.md%00.html");
    expect(nul.status).toBe(400);
  });

  it("rejects a symlink pointing outside the root with 404", async () => {
    const port = await start();
    const res = await rawRequest(port, "GET", "/leak.txt");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("secret");
  });

  it("rejects non-GET/HEAD methods with 405", async () => {
    const port = await start();
    const res = await rawRequest(port, "POST", "/report.md");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  it("never serves sandbox-authored artifacts as active content", async () => {
    // A prompt-injected agent controls artifact bytes: html/svg/js must come
    // back inert (text/plain + nosniff + deny-all CSP) or a booby-trapped
    // report could script this origin and read the whole archive.
    await writeFile(join(root, "evil.html"), "<script>alert(1)</script>", "utf8");
    await writeFile(join(root, "evil.svg"), "<svg onload=alert(1)/>", "utf8");
    const port = await start();
    for (const name of ["evil.html", "evil.svg"]) {
      const res = await rawRequest(port, "GET", `/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; sandbox"
      );
    }
    // The listing (our own HTML) also carries the hardening headers.
    const listing = await rawRequest(port, "GET", "/");
    expect(listing.headers["x-content-type-options"]).toBe("nosniff");
    expect(listing.headers["content-security-policy"]).toBe(
      "default-src 'none'; sandbox"
    );
  });
});
