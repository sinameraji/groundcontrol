/**
 * Shared types for groundcontrol.
 *
 * Everything cross-module lives here so leaf modules never import each other's
 * internals — they import types from here and concrete seams from the module
 * that owns them.
 */

import type { SandboxHandle } from "./hotcell.js";

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
  /** Discord message that requested this mission (excluded from context). */
  requestMessageId?: string;
  sandboxId?: string;
  costUsd?: number;
  tokens?: number;
  error?: string;
  result?: MissionResult;
}

/**
 * A thread cell: the long-lived sandbox behind one Discord thread. Created by
 * the first real mission in a thread, auto-paused by hotcell after
 * `sleepAfter` idle (≈zero RAM while paused), transparently resumed by the
 * next mission — the conversation's memory lives in its workspace.
 * Persisted in <ARTIFACTS_ROOT>/threads.json.
 */
export interface ThreadCell {
  threadId: string;
  sandboxId: string;
  /** Agent that created the cell (other agents may still join the thread). */
  agentName: string;
  /** Repo cloned into the cell, when the thread has done coding work. */
  repo?: string;
  createdAt: string;
  lastUsedAt: string;
  missionCount: number;
  /** Cumulative sandbox usage at the end of the last mission — the baseline
   *  for computing each new mission's per-mission cost delta. */
  totalCostUsd: number;
  totalTokens: number;
}

/** Everything a runner needs to execute one mission. */
export interface RunnerContext {
  mission: MissionRecord;
  agent: AgentDef;
  config: Config;
  /** Absolute path to this mission's folder (exists before the runner starts). */
  missionDir: string;
  /**
   * The thread's existing cell sandbox, already attached (a paused cell
   * auto-resumes on first use) — or null, in which case the runner creates a
   * fresh sandbox. Runners MUST registerSandbox() it either way and must
   * NEVER destroy it themselves: the engine owns cell lifecycle.
   */
  cellSandbox: SandboxHandle | null;
  /** True when cellSandbox carries state from earlier missions in the thread. */
  cellReused: boolean;
  /**
   * Recent thread conversation formatted for the prompt ("name: text" lines,
   * tail-capped), or null. Include it so follow-ups ("now compare that
   * against X") resolve their references.
   */
  threadContext: string | null;
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

/**
 * Runners return only the result. Usage/cost accounting and sandbox lifecycle
 * (pause-vs-destroy, cell bookkeeping) are the ENGINE's job — runners create
 * or reuse a sandbox, register it, do the work, and leave it running.
 */
export interface RunnerOutcome {
  result: MissionResult;
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
  /** Post a permanent message to a mission thread as the agent. Never throws. */
  post(agentName: string, threadId: string, content: string): Promise<void>;
  /**
   * Upsert the mission's single self-editing status line (and nudge the
   * typing indicator) — the human replacement for a scroll of log lines.
   * Never throws.
   */
  setStatus(
    agentName: string,
    threadId: string,
    missionId: string,
    content: string
  ): Promise<void>;
  /** Delete the status line once a final message is posted. Never throws. */
  clearStatus(
    agentName: string,
    threadId: string,
    missionId: string
  ): Promise<void>;
  /**
   * Recent thread messages formatted for prompt context ("name: text" lines,
   * chronological, status/subtext lines skipped, tail-capped ~3500 chars).
   * `excludeMessageId` drops the requesting message itself — its text is
   * already the task prompt. Null on any failure — never throws.
   */
  fetchContext(
    agentName: string,
    threadId: string,
    excludeMessageId?: string
  ): Promise<string | null>;
}

export interface JanitorReport {
  prunedFiles: string[];
  freedBytes: number;
  dockerPruneOutput?: string;
  /** Thread ids of idle cells reaped (on dryRun: would-be reaped). */
  reapedCells?: string[];
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
  /** Idle window before a cell auto-pauses (ms). */
  sandboxSleepAfterMs: number;
  janitor: {
    maxArtifactMb: number;
    artifactMaxAgeDays: number;
    /** Destroy thread cells idle longer than this (their workspace dies). */
    cellMaxIdleDays: number;
  };
}
