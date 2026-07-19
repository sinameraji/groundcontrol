/**
 * Shared types for groundcontrol.
 *
 * Everything cross-module lives here so leaf modules never import each other's
 * internals — they import types from here and concrete seams from the module
 * that owns them.
 */

export type AgentRole = "coding" | "research";

/** One Discord bot identity = one agent. Declared in config/agents.json. */
export interface AgentDef {
  /** Display name, e.g. "codey". Used in logs, PR footers, git author. */
  name: string;
  role: AgentRole;
  /** Name of the env var holding this agent's Discord bot token. */
  tokenEnv: string;
  /** Optional per-agent OpenRouter model override (e.g. "moonshotai/kimi-k2.5"). */
  model?: string;
  /** Persona/system flavor prepended to every task prompt for this agent. */
  persona?: string;
}

export type MissionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** What a Discord handler hands to the engine when the owner asks for work. */
export interface MissionRequest {
  agent: AgentDef;
  type: AgentRole;
  /** The task text, exactly as the owner wrote it (mention stripped). */
  prompt: string;
  /** Git repo URL for coding missions. */
  repo?: string;
  /** Channel the request arrived in. */
  channelId: string;
  /** Message id of the request (threads are spawned from it when possible). */
  requestMessageId?: string;
  requesterId: string;
}

export interface MissionResult {
  /** Short human summary, posted inline in the thread (may be truncated). */
  summary?: string;
  /** Coding: URL of the opened pull request. */
  prUrl?: string;
  /** Coding: branch name that was pushed. */
  branch?: string;
  /** Artifact paths relative to the mission folder (e.g. "report.md"). */
  files?: string[];
  /** Public tailnet URLs for those artifacts (parallel to `files`). */
  links?: string[];
}

/** Persistent record; lives at <ARTIFACTS_ROOT>/<id>/state.json. */
export interface MissionRecord {
  /** e.g. "m-20260719-4fa1" — [a-z0-9-] only, safe in paths/branches/URLs. */
  id: string;
  status: MissionStatus;
  agentName: string;
  type: AgentRole;
  prompt: string;
  repo?: string;
  createdAt: string; // ISO 8601
  startedAt?: string;
  finishedAt?: string;
  channelId: string;
  threadId?: string;
  sandboxId?: string;
  costUsd?: number;
  tokens?: number;
  error?: string;
  result?: MissionResult;
}

/** Everything a runner needs to execute one mission. */
export interface RunnerContext {
  mission: MissionRecord;
  agent: AgentDef;
  config: Config;
  /** Absolute path to this mission's folder (exists before the runner starts). */
  missionDir: string;
  /** Post a short status line to the mission thread ("cloning repo…"). */
  setStatus(phase: string): Promise<void>;
  /** Cooperative cancellation — runners should check between long steps. */
  isCancelled(): boolean;
  /**
   * Runners MUST register every sandbox they create, immediately after
   * creation — this is how the engine force-destroys on timeout/cancel.
   */
  registerSandbox(handle: { id: string; destroy(): Promise<void> }): void;
}

export interface RunnerOutcome {
  result: MissionResult;
  costUsd?: number;
  tokens?: number;
}

/** The engine's surface, consumed by Discord handlers. */
export interface Dispatcher {
  /** Create + enqueue a mission. Returns its id and 0-based queue position. */
  submit(req: MissionRequest): Promise<{ missionId: string; position: number }>;
  /** Cancel a queued or running mission. True if something was cancelled. */
  cancel(missionId: string): Promise<boolean>;
  status(): Promise<{ active: MissionRecord[]; queued: MissionRecord[] }>;
}

/** The Discord side's surface, consumed by the engine to report progress. */
export interface DiscordPoster {
  /**
   * Create the per-mission thread (from the request message when possible).
   * Returns the thread id, or null if Discord is unavailable.
   */
  createMissionThread(
    req: MissionRequest,
    missionId: string
  ): Promise<string | null>;
  /** Post a message to a mission thread as the given agent. Never throws. */
  post(agentName: string, threadId: string, content: string): Promise<void>;
}

export interface JanitorReport {
  prunedFiles: string[];
  freedBytes: number;
  dockerPruneOutput?: string;
  errors: string[];
}

/** Full runtime configuration, loaded from env + config/agents.json. */
export interface Config {
  ownerId: string;
  guildId?: string;
  agents: AgentDef[];
  hotcellEndpoint: string;
  hotcellApiKey?: string;
  /** Absolute path where mission folders live. */
  artifactsRoot: string;
  /** e.g. "https://machine.tailnet.ts.net" — no trailing slash. */
  publicBaseUrl?: string;
  filesPort: number;
  maxConcurrentMissions: number;
  defaultModel: string;
  spendCapUsd: number;
  missionTimeoutMinutes: number;
  defaultRepo?: string;
  ghPath: string;
  sandboxImage?: string;
  janitor: {
    maxArtifactMb: number;
    artifactMaxAgeDays: number;
  };
}
