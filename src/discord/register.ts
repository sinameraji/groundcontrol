import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type {
  RESTGetCurrentApplicationResult,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AgentDef, Config } from "../types.js";

/**
 * Register slash commands for every agent application (guild-scoped when
 * config.guildId is set — instant; global otherwise — up to an hour).
 * Coding agents get /code, research agents get /research; all get /status
 * and /cancel. Uses discord.js REST + Routes with each agent's own token.
 * Prints a line per agent so `npm run register` is self-explaining.
 */
export async function registerCommands(cfg: Config): Promise<void> {
  for (const agent of cfg.agents) {
    const token = process.env[agent.tokenEnv];
    if (!token) {
      throw new Error(
        `agent "${agent.name}": env var ${agent.tokenEnv} has no Discord token`
      );
    }
    const rest = new REST().setToken(token);
    const app = (await rest.get(
      Routes.currentApplication()
    )) as RESTGetCurrentApplicationResult;

    const body = commandsFor(agent);
    const route = cfg.guildId
      ? Routes.applicationGuildCommands(app.id, cfg.guildId)
      : Routes.applicationCommands(app.id);
    await rest.put(route, { body });

    const scope = cfg.guildId
      ? `guild ${cfg.guildId}`
      : "global (may take up to an hour to appear)";
    console.log(
      `${agent.name} (${agent.role}): registered ${body
        .map((c) => `/${c.name}`)
        .join(" ")} — ${scope}`
    );
  }
}

// ── internals ──────────────────────────────────────────────────────────────

/** The command set for one agent: role-specific + /status + /cancel. */
function commandsFor(
  agent: AgentDef
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  if (agent.role === "coding") {
    commands.push(
      new SlashCommandBuilder()
        .setName("code")
        .setDescription(`Give ${agent.name} a coding mission`)
        .addStringOption((o) =>
          o
            .setName("task")
            .setDescription("What to build or fix")
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("repo")
            .setDescription("Git repo URL (defaults to DEFAULT_REPO)")
        )
        .toJSON()
    );
  }
  if (agent.role === "research") {
    commands.push(
      new SlashCommandBuilder()
        .setName("research")
        .setDescription(`Ask ${agent.name} to research something`)
        .addStringOption((o) =>
          o
            .setName("question")
            .setDescription("What to find out")
            .setRequired(true)
        )
        .toJSON()
    );
  }
  commands.push(
    new SlashCommandBuilder()
      .setName("model")
      .setDescription(`Show or change ${agent.name}'s model`)
      .addStringOption((o) =>
        o
          .setName("model")
          .setDescription(
            "OpenRouter model id (vendor/model), or 'reset' for the default"
          )
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show active and queued missions")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("cancel")
      .setDescription("Cancel a queued or running mission")
      .addStringOption((o) =>
        o
          .setName("mission_id")
          .setDescription("Mission id, e.g. m-20260719-4fa1")
          .setRequired(true)
      )
      .toJSON()
  );
  return commands;
}
