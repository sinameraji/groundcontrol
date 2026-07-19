import fs from "node:fs";
import path from "node:path";
import type { AgentDef, Config } from "./types.js";

/**
 * Load configuration from process env (plus .env via Node's loadEnvFile) and
 * the agents file. Throws with a clear message when something required is
 * missing so `groundcontrol start` fails loudly instead of half-working.
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  // Node >= 20.12: hydrate process.env from .env if present (no dotenv dep).
  const envFile = path.join(cwd, ".env");
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      /* already loaded or unreadable — env vars may still be set directly */
    }
  }
  const env = process.env;

  const ownerId = (env.OWNER_DISCORD_USER_ID ?? "").trim();
  if (!ownerId) {
    throw new Error(
      "OWNER_DISCORD_USER_ID is required (your Discord user id — only you may command the agents)"
    );
  }

  const agents = loadAgents(cwd, env);

  const artifactsRoot = path.resolve(
    cwd,
    (env.ARTIFACTS_ROOT ?? "./data/missions").trim()
  );

  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");

  // Model overrides set at runtime via the /model command survive restarts.
  applyModelOverrides(agents, artifactsRoot);

  return {
    ownerId,
    guildId: emptyToUndef(env.DISCORD_GUILD_ID),
    agents,
    hotcellEndpoint:
      emptyToUndef(env.HOTCELL_ENDPOINT) ?? "http://127.0.0.1:4750",
    hotcellApiKey: emptyToUndef(env.HOTCELL_API_KEY),
    artifactsRoot,
    publicBaseUrl: publicBaseUrl || undefined,
    filesPort: intFrom(env.FILES_PORT, 4760),
    maxConcurrentMissions: intFrom(env.MAX_CONCURRENT_MISSIONS, 2),
    defaultModel:
      emptyToUndef(env.OPENROUTER_MODEL) ?? "moonshotai/kimi-k2.5",
    spendCapUsd: floatFrom(env.MISSION_SPEND_CAP_USD, 5),
    missionTimeoutMinutes: intFrom(env.MISSION_TIMEOUT_MINUTES, 45),
    defaultRepo: emptyToUndef(env.DEFAULT_REPO),
    ghPath: emptyToUndef(env.GH_PATH) ?? "gh",
    sandboxImage: emptyToUndef(env.SANDBOX_IMAGE),
    sandboxSleepAfterMs:
      intFrom(env.SANDBOX_SLEEP_AFTER_MINUTES, 2) * 60_000,
    janitor: {
      maxArtifactMb: intFrom(env.JANITOR_MAX_ARTIFACT_MB, 100),
      artifactMaxAgeDays: intFrom(env.JANITOR_ARTIFACT_MAX_AGE_DAYS, 30),
      cellMaxIdleDays: intFrom(env.CELL_MAX_IDLE_DAYS, 30),
    },
  };
}

function loadAgents(cwd: string, env: NodeJS.ProcessEnv): AgentDef[] {
  const explicit = emptyToUndef(env.AGENTS_FILE);
  const candidates = explicit
    ? [path.resolve(cwd, explicit)]
    : [
        path.join(cwd, "config", "agents.json"),
        path.join(cwd, "config", "agents.example.json"),
      ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    throw new Error(
      `no agents file found (looked for ${candidates.join(", ")})`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    agents?: AgentDef[];
  };
  const agents = parsed.agents ?? [];
  if (agents.length === 0) throw new Error(`${file} defines no agents`);
  for (const a of agents) {
    if (!a.name || !/^[a-z0-9-]+$/i.test(a.name)) {
      throw new Error(`agent name "${a.name}" must be [a-z0-9-]`);
    }
    if (a.role !== "coding" && a.role !== "research") {
      throw new Error(`agent "${a.name}": role must be "coding" | "research"`);
    }
    if (!a.tokenEnv || !env[a.tokenEnv]) {
      throw new Error(
        `agent "${a.name}": env var ${a.tokenEnv || "(unset tokenEnv)"} has no Discord token`
      );
    }
  }
  return agents;
}

/** Apply <artifactsRoot>/models.json ({agentName: model}) over agents.json. */
function applyModelOverrides(agents: AgentDef[], artifactsRoot: string): void {
  try {
    const file = path.join(artifactsRoot, "models.json");
    const overrides = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    for (const a of agents) {
      const m = overrides[a.name];
      if (typeof m === "string" && m.trim() !== "") a.model = m.trim();
    }
  } catch {
    /* no overrides file — agents.json + OPENROUTER_MODEL apply */
  }
}

function emptyToUndef(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t === "" ? undefined : t;
}

function intFrom(v: string | undefined, dflt: number): number {
  const n = parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function floatFrom(v: string | undefined, dflt: number): number {
  const n = parseFloat((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
