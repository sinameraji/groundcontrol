import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * Host-side publishing: a git bundle produced inside a sandbox becomes a
 * pushed branch + PR, using the HOST's git and authenticated `gh`. GitHub
 * credentials never enter sandboxes.
 *
 * All git/gh invocations use execFile (argv arrays) — never a shell string —
 * so repo URLs, titles, and bodies need no escaping.
 */

const execFileP = promisify(execFile);

export interface PublishOpts {
  /** Repo URL as given by the owner (https://github.com/owner/name[.git]). */
  repo: string;
  /** Absolute path to the bundle on the host. */
  bundlePath: string;
  /** Branch to push, e.g. "mission/m-20260719-4fa1". */
  branch: string;
  /** Default branch of the repo (detected inside the sandbox), PR base. */
  baseBranch: string;
  title: string;
  body: string;
  /** Path to the gh binary (config.ghPath). */
  ghPath: string;
  /** Scratch dir for the temporary clone; created/cleaned by this function. */
  workDir: string;
}

export interface PublishResult {
  pushed: boolean;
  branch: string;
  prUrl?: string;
  /** Human-readable failure (e.g. "no push access") — partial success is
   *  fine: pushed=true with error set means the PR step failed. */
  error?: string;
}

/** owner/name from https://github.com/owner/name[.git][/]; null otherwise. */
function parseGitHubRepo(repo: string): { owner: string; name: string } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  const owner = m?.[1];
  const name = m?.[2];
  if (owner === undefined || name === undefined) return null;
  return { owner, name };
}

/** Last `max` characters of a command's stderr/message, trimmed. */
function errTail(err: unknown, max = 500): string {
  let text = "";
  if (err !== null && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim() !== "") {
      text = e.stderr;
    } else if (typeof e.message === "string") {
      text = e.message;
    }
  }
  if (text === "") text = String(err);
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

/** First https URL printed by gh, if any. */
function extractUrl(stdout: string): string | undefined {
  return /https:\/\/\S+/.exec(stdout)?.[0];
}

/**
 * Push the sandbox-produced bundle's branch to `origin` and open a PR with
 * the host's `gh`. Never interpolates anything into a shell string, never
 * logs credentials, and always removes `workDir` when done.
 */
export async function publishBundle(opts: PublishOpts): Promise<PublishResult> {
  const { repo, bundlePath, branch, baseBranch, title, body, ghPath, workDir } =
    opts;

  const run = (cmd: string, args: string[]) =>
    execFileP(cmd, args, { cwd: workDir, maxBuffer: 16 * 1024 * 1024 });

  /** Full (unshallowing when needed) fetch of the base branch. */
  const fullFetch = async (): Promise<void> => {
    const { stdout } = await run("git", [
      "rev-parse",
      "--is-shallow-repository",
    ]);
    const args =
      stdout.trim() === "true"
        ? ["fetch", "--unshallow", "origin", baseBranch]
        : ["fetch", "origin", baseBranch];
    await run("git", args);
  };

  try {
    await mkdir(workDir, { recursive: true });
    await run("git", ["init", "-q"]);
    await run("git", ["remote", "add", "origin", repo]);

    // Base commits first — the bundle's prerequisites live on the base branch.
    try {
      await run("git", ["fetch", "--depth=200", "origin", baseBranch]);
    } catch {
      try {
        await fullFetch();
      } catch (err) {
        return {
          pushed: false,
          branch,
          error: `fetch of base branch "${baseBranch}" failed: ${errTail(err)}`,
        };
      }
    }

    // Import the branch from the bundle; a shallow base may miss the bundle's
    // prerequisites, so retry once after a full fetch.
    try {
      await run("git", ["fetch", bundlePath, `${branch}:${branch}`]);
    } catch {
      try {
        await fullFetch();
        await run("git", ["fetch", bundlePath, `${branch}:${branch}`]);
      } catch (err) {
        return {
          pushed: false,
          branch,
          error: `could not import bundle (missing prerequisites?): ${errTail(err)}`,
        };
      }
    }

    try {
      await run("git", ["push", "origin", branch]);
    } catch (err) {
      return { pushed: false, branch, error: `push failed: ${errTail(err)}` };
    }

    const gh = parseGitHubRepo(repo);
    if (gh === null) {
      return { pushed: true, branch, error: "PR skipped (not GitHub)" };
    }
    const repoSlug = `${gh.owner}/${gh.name}`;

    try {
      const { stdout } = await run(ghPath, [
        "pr",
        "create",
        "--repo",
        repoSlug,
        "--head",
        branch,
        "--base",
        baseBranch,
        "--title",
        title,
        "--body",
        body,
      ]);
      return { pushed: true, branch, prUrl: extractUrl(stdout) };
    } catch (err) {
      const tail = errTail(err);
      // "a pull request … already exists" — recover its URL so the thread
      // still gets a link.
      if (/already exists/i.test(tail)) {
        try {
          const { stdout } = await run(ghPath, [
            "pr",
            "view",
            branch,
            "--repo",
            repoSlug,
            "--json",
            "url",
          ]);
          const parsed: unknown = JSON.parse(stdout);
          const url =
            parsed !== null &&
            typeof parsed === "object" &&
            typeof (parsed as { url?: unknown }).url === "string"
              ? (parsed as { url: string }).url
              : undefined;
          if (url !== undefined) {
            return {
              pushed: true,
              branch,
              prUrl: url,
              error: `gh pr create failed: ${tail}`,
            };
          }
        } catch {
          // fall through to the plain error result
        }
      }
      return { pushed: true, branch, error: `gh pr create failed: ${tail}` };
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
