#!/usr/bin/env node
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { log, logError } from "./log.js";
import { MissionStore } from "./missions/store.js";
import { MissionQueue } from "./missions/queue.js";
import { MissionEngine } from "./missions/runner.js";
import { ThreadCells } from "./missions/cells.js";
import { Hotcell } from "./hotcell.js";
import { startBots } from "./discord/manager.js";
import { startFileServer } from "./files/server.js";
import { registerCommands } from "./discord/register.js";
import { runJanitor } from "./janitor.js";

const cmd = process.argv[2] ?? "start";

async function main(): Promise<void> {
  switch (cmd) {
    case "start":
      return start();
    case "janitor":
      return janitor();
    case "register-commands":
      return registerCommands(loadConfig());
    default:
      console.error("usage: groundcontrol <start|janitor|register-commands>");
      process.exit(2);
  }
}

async function start(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.artifactsRoot, { recursive: true });

  const store = new MissionStore(cfg.artifactsRoot);
  const queue = new MissionQueue(cfg.maxConcurrentMissions);
  const hotcell = new Hotcell(cfg);
  const cells = new ThreadCells(cfg.artifactsRoot);
  const engine = new MissionEngine(cfg, store, queue, hotcell, cells);

  // Sweep BEFORE the bots come online: anything still queued/running in the
  // store predates this process, so a fresh boot-time submission can never be
  // falsely marked as orphaned.
  const orphans = await store.markOrphans();

  const server = await startFileServer(cfg.artifactsRoot, cfg.filesPort);
  log(
    "main",
    `file server on 127.0.0.1:${cfg.filesPort} → ${cfg.artifactsRoot}` +
      (cfg.publicBaseUrl ? ` (public: ${cfg.publicBaseUrl})` : " (no PUBLIC_BASE_URL — links disabled)")
  );

  // The poster is attached before any client logs in, so the very first
  // mission request already has a working thread/report path.
  const fleet = await startBots(cfg, engine, (f) => engine.attachPoster(f));
  log("main", `bots online: ${cfg.agents.map((a) => a.name).join(", ")}`);

  if (orphans.length > 0) {
    log("main", `marked ${orphans.length} orphaned mission(s) as failed`);
    await engine.handleOrphans(orphans);
  }

  const shutdown = async (sig: string) => {
    log("main", `${sig} — shutting down`);
    await fleet.stop().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function janitor(): Promise<void> {
  const cfg = loadConfig();
  const report = await runJanitor(cfg);
  log(
    "janitor",
    `pruned ${report.prunedFiles.length} file(s), freed ${(report.freedBytes / 1e6).toFixed(1)} MB`
  );
  if (report.dockerPruneOutput) {
    log("janitor", `docker: ${report.dockerPruneOutput.split("\n").at(-1)}`);
  }
  if (report.reapedCells && report.reapedCells.length > 0) {
    log(
      "janitor",
      `reaped ${report.reapedCells.length} idle cell(s): ${report.reapedCells.join(", ")}`
    );
  }
  for (const e of report.errors) logError("janitor", e);
}

main().catch((err) => {
  logError("main", "fatal", err);
  process.exit(1);
});
