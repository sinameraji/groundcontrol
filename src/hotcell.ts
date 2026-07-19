import { HotcellClient } from "@hotcell/sdk";
import type { CreateOptions, Sandbox, SandboxMetrics } from "@hotcell/sdk";
import type { Config } from "./types.js";

/**
 * Thin wrapper over @hotcell/sdk plus the OpenCode command builders.
 *
 * IMPLEMENTATION NOTE: read node_modules/@hotcell/sdk/dist/index.d.ts for the
 * exact client surface (HotcellClient, getSandbox options, execStream event
 * shapes) and adapt — this wrapper exists precisely so the rest of the app
 * never touches SDK types directly.
 */

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxHandle {
  id: string;
  /** Run a command, buffer output. */
  exec(cmd: string): Promise<ExecResult>;
  /** Run a command, calling onLine for each stdout line as it streams. */
  execStreaming(
    cmd: string,
    onLine?: (line: string) => void
  ): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Binary-safe read (base64 over exec if the SDK read is text-only). */
  readFileBinary(path: string): Promise<Buffer>;
  destroy(): Promise<void>;
}

export interface CreateSandboxOpts {
  repo?: string;
  ref?: string;
  setup?: string[];
  /** Wire the egress gateway (OPENROUTER_* env inside, key stays on host). */
  egress: boolean;
  /** Per-mission LLM spend ceiling in USD. */
  spendCapUsd?: number;
  image?: string;
}

export class Hotcell {
  private readonly client: HotcellClient;
  private readonly cfg: Pick<
    Config,
    "hotcellEndpoint" | "hotcellApiKey" | "sandboxImage"
  >;

  constructor(
    cfg: Pick<Config, "hotcellEndpoint" | "hotcellApiKey" | "sandboxImage">
  ) {
    this.cfg = cfg;
    this.client = new HotcellClient({
      endpoint: cfg.hotcellEndpoint,
      apiKey: cfg.hotcellApiKey,
    });
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    const create: CreateOptions = {};

    const image = opts.image ?? this.cfg.sandboxImage;
    if (image !== undefined) create.image = image;
    if (opts.repo !== undefined) create.repo = opts.repo;
    if (opts.ref !== undefined) create.repoRef = opts.ref;
    if (opts.setup !== undefined) create.setup = opts.setup;

    if (!opts.egress) {
      create.egress = false;
    } else if (opts.spendCapUsd !== undefined) {
      // Per-token policy cap + sandbox-wide backstop, both at the mission cap.
      create.egress = { spendCapUsd: opts.spendCapUsd };
      create.egressSpendCapUsd = opts.spendCapUsd;
    } else {
      create.egress = true;
    }

    const sandbox = await this.client.getSandbox(undefined, create);
    return wrapSandbox(sandbox);
  }

  /**
   * Best-effort destroy of a sandbox by id (orphan reaping after a restart).
   * Checks the daemon's list first — getSandbox(id) would otherwise
   * get-or-CREATE a fresh sandbox under that id. Never throws.
   */
  async destroySandbox(id: string): Promise<void> {
    try {
      const existing = await this.client.list();
      if (!existing.some((s) => s.id === id)) return;
      const sandbox = await this.client.getSandbox(id);
      await sandbox.destroy();
    } catch {
      /* daemon down or sandbox already gone — nothing to reap */
    }
  }

  /**
   * Token/cost snapshot for a sandbox (GET /sandboxes/:id/metrics?live=0 —
   * usage.providerTokensIn/Out + cost.total). MUST be called before destroy.
   * Returns null when unavailable; never throws.
   */
  async usage(
    sandboxId: string
  ): Promise<{ tokens: number; costUsd: number } | null> {
    try {
      const base = this.client.endpoint.replace(/\/+$/, "");
      const res = await fetch(
        `${base}/sandboxes/${encodeURIComponent(sandboxId)}/metrics?live=0`,
        { headers: this.client.authHeaders() }
      );
      if (!res.ok) return null;
      const m = (await res.json()) as Partial<SandboxMetrics> | null;
      const tokensIn = m?.usage?.providerTokensIn;
      const tokensOut = m?.usage?.providerTokensOut;
      const total = m?.cost?.total;
      if (
        typeof tokensIn !== "number" ||
        typeof tokensOut !== "number" ||
        typeof total !== "number"
      ) {
        return null;
      }
      return { tokens: tokensIn + tokensOut, costUsd: total };
    } catch {
      return null;
    }
  }
}

/** Adapt an SDK Sandbox to the app-facing SandboxHandle. */
function wrapSandbox(sandbox: Sandbox): SandboxHandle {
  return {
    id: sandbox.id,

    async exec(cmd: string): Promise<ExecResult> {
      const r = await sandbox.exec(cmd);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },

    async execStreaming(
      cmd: string,
      onLine?: (line: string) => void
    ): Promise<ExecResult> {
      let stdout = "";
      let stderr = "";
      // If the stream ends without an exit event something went wrong —
      // report a non-zero code rather than a phantom success.
      let exitCode = -1;
      let pending = "";
      for await (const ev of sandbox.execStream(cmd)) {
        if (ev.type === "stdout") {
          stdout += ev.data;
          if (onLine) {
            pending += ev.data;
            let nl: number;
            while ((nl = pending.indexOf("\n")) !== -1) {
              onLine(pending.slice(0, nl));
              pending = pending.slice(nl + 1);
            }
          }
        } else if (ev.type === "stderr") {
          stderr += ev.data;
        } else {
          exitCode = ev.exitCode;
        }
      }
      if (onLine && pending.length > 0) onLine(pending);
      return { exitCode, stdout, stderr };
    },

    writeFile(path: string, content: string): Promise<void> {
      return sandbox.writeFile(path, content);
    },

    readFile(path: string): Promise<string> {
      return sandbox.readFile(path);
    },

    async readFileBinary(path: string): Promise<Buffer> {
      const r = await sandbox.exec(`base64 < ${shellQuote(path)}`);
      if (r.exitCode !== 0) {
        throw new Error(
          `readFileBinary(${path}) failed (exit ${r.exitCode}): ` +
            r.stderr.trim().slice(0, 400)
        );
      }
      return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
    },

    destroy(): Promise<void> {
      return sandbox.destroy();
    },
  };
}

/** POSIX single-quote escaping: ' → '\'' , wrapped in single quotes. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Sandbox setup command: install OpenCode and point its openrouter provider at
 * the egress gateway env (OPENROUTER_BASE_URL/OPENROUTER_API_KEY are set by
 * hotcell inside the sandbox when egress is wired). Mirrors hotcell's own
 * examples/agent.mjs.
 */
export const OPENCODE_SETUP: string =
  `npm i -g opencode-ai >/dev/null 2>&1 && mkdir -p ~/.config/opencode && ` +
  `printf '{"provider":{"openrouter":{"options":{"baseURL":"%s/v1","apiKey":"%s"}}}}' ` +
  `"$OPENROUTER_BASE_URL" "$OPENROUTER_API_KEY" > ~/.config/opencode/opencode.json`;

/**
 * Headless OpenCode invocation. The task prompt is NEVER interpolated here —
 * it must already sit in `taskFile` inside the sandbox (written via
 * writeFile); the command reads it with $(cat …).
 */
export function opencodeRunCommand(opts: {
  dir: string;
  model: string; // openrouter model id WITHOUT the "openrouter/" prefix
  taskFile: string;
}): string {
  return (
    `opencode run --dir ${shellQuote(opts.dir)} ` +
    `-m ${shellQuote(`openrouter/${opts.model}`)} ` +
    `--dangerously-skip-permissions ` +
    `"$(cat ${shellQuote(opts.taskFile)})"`
  );
}
