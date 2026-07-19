import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import type { ChatInputCommandInteraction, Interaction, Message } from "discord.js";
import type {
  AgentDef,
  AgentRole,
  Config,
  DiscordPoster,
  Dispatcher,
  MissionRequest,
} from "../types.js";
import { log, logError } from "../log.js";
import { fmtQueued, fmtStatus, truncate } from "./format.js";

/**
 * One discord.js Client per agent (each agent is its own Discord application/
 * bot token → its own name + avatar in the member list).
 *
 * Handling rules (see DESIGN.md "Security invariants"):
 *  - ignore every message whose author is a bot, and every message /
 *    interaction not from config.ownerId (silently)
 *  - a message that @mentions an agent's bot user = a mission request for
 *    that agent: strip the mention → prompt; for coding agents the first
 *    http(s) URL in the text is the repo (else config.defaultRepo, else
 *    reply asking for one, no mission created)
 *  - slash commands (per agent app): /code task [repo], /research question,
 *    /status, /cancel mission_id — /code only on coding agents, /research
 *    only on research agents; /status and /cancel on all
 *  - on submit: dispatcher.submit(...); reply via fmtQueued when position>0,
 *    else a brief ack; errors from submit reported in-channel, truncated
 *  - createMissionThread: public thread off the request message (fallback:
 *    channel.threads.create in the channel); name "<missionId> · <prompt…>"
 *    ≤ 100 chars
 *  - post(): 2000-char safe (truncate via format.js), never throws — log and
 *    swallow Discord errors so the engine never dies on a flaky post
 *
 * Required intents: Guilds, GuildMessages, MessageContent.
 */
export interface BotFleet extends DiscordPoster {
  stop(): Promise<void>;
}

export async function startBots(
  cfg: Config,
  dispatcher: Dispatcher,
  onFleet?: (fleet: BotFleet) => void
): Promise<BotFleet> {
  const fleet = new Fleet(cfg, dispatcher);
  // Give the caller the fleet BEFORE any client logs in, so the engine's
  // poster is attached before the first gateway event can possibly arrive.
  onFleet?.(fleet);
  await fleet.start();
  return fleet;
}

// ── internals ──────────────────────────────────────────────────────────────

/** <@id> and <@!id> user-mention tokens. */
const MENTION_RE = /<@!?\d+>/g;

/**
 * First http(s) URL in free text (used as the repo for coding agents).
 * Tolerates Discord's <url> embed-suppression wrapping — the capture group
 * excludes the closing '>' that \S+ would swallow.
 */
const URL_RE = /<?(https?:\/\/[^\s>]+)>?/;

/**
 * Greetings/chitchat that shouldn't cost a sandbox: Discord is a place to
 * TALK to the agents, so "hello" deserves a hello back, not a mission.
 */
const SMALLTALK_RE =
  /^(hi|hiya|hello|hey|yo|sup|howdy|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ty|ok(ay)?|nice|cool|great|lol|test(ing)?|ping|👋|🙏)[\s.!?👋🙏]*$/i;

/** Max chars of thread context fed into a task prompt (the tail is kept). */
const MAX_CONTEXT_CHARS = 3500;

/**
 * Cap `text` to ~MAX_CONTEXT_CHARS keeping the END — in a conversation the
 * recent messages matter most. Cuts at a line boundary when one exists inside
 * the kept window (a single over-long line is kept mid-cut instead).
 */
function tailCap(text: string): string {
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  const tail = text.slice(-MAX_CONTEXT_CHARS);
  const cut = tail.indexOf("\n");
  return cut === -1 ? tail : tail.slice(cut + 1);
}

function smalltalkReply(agent: AgentDef): string {
  return agent.role === "coding"
    ? `👋 hey! Give me a task and a repo and I'll get to work — e.g. \`@${agent.name} fix the flaky login test https://github.com/you/app\``
    : `👋 hey! Give me something to dig into — e.g. \`@${agent.name} compare SQLite vs DuckDB for local analytics\``;
}

class Fleet implements BotFleet {
  private readonly bots = new Map<string, { agent: AgentDef; client: Client }>();
  /**
   * requestMessageId → thread id, for requests made *inside* a thread: that
   * thread becomes the mission thread instead of nesting a new one.
   */
  private readonly pendingThreads = new Map<string, string>();
  /** missionId → id of its single self-editing status message. */
  private readonly statusMsgs = new Map<string, string>();

  constructor(
    private readonly cfg: Config,
    private readonly dispatcher: Dispatcher
  ) {}

  /** Build a client per agent, log in all, wait until every one is ready. */
  async start(): Promise<void> {
    const readies: Array<Promise<void>> = [];
    const logins: Array<Promise<unknown>> = [];
    for (const agent of this.cfg.agents) {
      const token = process.env[agent.tokenEnv];
      if (!token) {
        throw new Error(
          `agent "${agent.name}": env var ${agent.tokenEnv} has no Discord token`
        );
      }
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });
      client.on(Events.MessageCreate, (message) => {
        void this.onMessage(agent, client, message).catch((err) =>
          logError("discord", `${agent.name}: message handler failed`, err)
        );
      });
      client.on(Events.InteractionCreate, (interaction) => {
        void this.onInteraction(agent, interaction).catch((err) =>
          logError("discord", `${agent.name}: interaction handler failed`, err)
        );
      });
      readies.push(
        new Promise((resolve) =>
          client.once(Events.ClientReady, (ready) => {
            log("discord", `${agent.name} online as ${ready.user.tag}`);
            resolve();
          })
        )
      );
      this.bots.set(agent.name, { agent, client });
      logins.push(client.login(token));
    }

    const settled = await Promise.allSettled(logins);
    const failed = settled.find((s) => s.status === "rejected");
    if (failed && failed.status === "rejected") {
      await this.stop().catch(() => {});
      throw failed.reason instanceof Error
        ? failed.reason
        : new Error(String(failed.reason));
    }
    await Promise.all(readies);
  }

  async createMissionThread(
    req: MissionRequest,
    missionId: string
  ): Promise<string | null> {
    try {
      // Request arrived inside a thread → that thread IS the mission thread.
      if (req.requestMessageId) {
        const existing = this.pendingThreads.get(req.requestMessageId);
        if (existing) return existing;
      }
      const bot = this.bots.get(req.agent.name);
      if (!bot) return null;
      const channel = await bot.client.channels
        .fetch(req.channelId)
        .catch(() => null);
      if (!channel) return null;
      if (channel.isThread()) return channel.id;
      if (channel.type !== ChannelType.GuildText) return null;

      // Threads are named after the ASK — the mission id is bookkeeping and
      // lives in message subtext, not in the conversation's title.
      const name =
        (req.prompt.replace(/\s+/g, " ").trim() || "mission").slice(0, 90);
      if (req.requestMessageId) {
        try {
          const message = await channel.messages.fetch(req.requestMessageId);
          const thread = await message.startThread({ name });
          return thread.id;
        } catch {
          /* message gone or already has a thread — fall through */
        }
      }
      const thread = await channel.threads.create({ name });
      return thread.id;
    } catch (err) {
      logError("discord", `createMissionThread failed for ${missionId}`, err);
      return null;
    }
  }

  async post(
    agentName: string,
    threadId: string,
    content: string
  ): Promise<void> {
    try {
      const bot = this.bots.get(agentName);
      if (!bot) {
        logError("discord", `post: no client for agent "${agentName}"`);
        return;
      }
      const channel = await bot.client.channels.fetch(threadId);
      if (!channel) {
        logError("discord", `post: channel ${threadId} not found`);
        return;
      }
      if (channel.isThread() && channel.archived) {
        await channel.setArchived(false).catch(() => {});
      }
      if (!channel.isSendable()) {
        logError("discord", `post: channel ${threadId} is not sendable`);
        return;
      }
      await channel.send(truncate(content));
    } catch (err) {
      logError("discord", `post to ${threadId} as ${agentName} failed`, err);
    }
  }

  async setStatus(
    agentName: string,
    threadId: string,
    missionId: string,
    content: string
  ): Promise<void> {
    try {
      const bot = this.bots.get(agentName);
      if (!bot) return;
      const channel = await bot.client.channels.fetch(threadId);
      if (!channel?.isSendable()) return;
      void channel.sendTyping().catch(() => {});
      const text = `-# ⏳ ${content}`;
      const existingId = this.statusMsgs.get(missionId);
      if (existingId) {
        const msg = await channel.messages.fetch(existingId).catch(() => null);
        if (msg) {
          await msg.edit(text);
          return;
        }
      }
      const sent = await channel.send(text);
      this.statusMsgs.set(missionId, sent.id);
    } catch (err) {
      logError("discord", `setStatus in ${threadId} failed`, err);
    }
  }

  async clearStatus(
    agentName: string,
    threadId: string,
    missionId: string
  ): Promise<void> {
    try {
      const messageId = this.statusMsgs.get(missionId);
      this.statusMsgs.delete(missionId);
      if (!messageId) return;
      const bot = this.bots.get(agentName);
      if (!bot) return;
      const channel = await bot.client.channels.fetch(threadId);
      if (!channel?.isSendable()) return;
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    } catch (err) {
      logError("discord", `clearStatus in ${threadId} failed`, err);
    }
  }

  async fetchContext(
    agentName: string,
    threadId: string,
    excludeMessageId?: string
  ): Promise<string | null> {
    try {
      const bot = this.bots.get(agentName);
      if (!bot) return null;
      const channel = await bot.client.channels
        .fetch(threadId)
        .catch(() => null);
      if (!channel?.isTextBased()) return null;
      const fetched = await channel.messages.fetch({ limit: 25 });
      const lines: string[] = [];
      // fetch() returns newest-first — reverse into chronological order.
      for (const msg of [...fetched.values()].reverse()) {
        const content = msg.content.trim();
        // Skip system/thread-starter messages, empty bodies (attachment-only),
        // "-#" status/subtext lines — and the requesting message itself, whose
        // text already IS the task prompt.
        if (msg.system || !content || content.startsWith("-#")) continue;
        if (excludeMessageId && msg.id === excludeMessageId) continue;
        const name =
          msg.member?.displayName ??
          msg.author.displayName ??
          msg.author.username;
        lines.push(`${name}: ${content}`);
      }
      if (lines.length === 0) return null;
      return tailCap(lines.join("\n"));
    } catch (err) {
      logError("discord", `fetchContext for ${threadId} failed`, err);
      return null;
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.bots.values()].map((b) =>
        b.client
          .destroy()
          .catch((err) =>
            logError("discord", `${b.agent.name}: destroy failed`, err)
          )
      )
    );
  }

  // ── handlers ─────────────────────────────────────────────────────────────

  private async onMessage(
    agent: AgentDef,
    client: Client,
    message: Message
  ): Promise<void> {
    if (message.author.bot) return;
    if (message.author.id !== this.cfg.ownerId) return;
    const me = client.user;
    // Require an explicit @mention of THIS bot: a plain reply to one of its
    // messages also lands in mentions.users (the reply-ping), and @everyone /
    // role pings would otherwise summon every agent at once.
    if (
      !me ||
      !message.mentions.has(me, {
        ignoreRepliedUser: true,
        ignoreEveryone: true,
        ignoreRoles: true,
      })
    ) {
      return;
    }

    let prompt = message.content
      .replace(MENTION_RE, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (!prompt) {
      await message.reply(
        `👋 mention me with a task, e.g. \`@${agent.name} fix the flaky login test\``
      );
      return;
    }
    // Chitchat gets a chat back — no sandbox, no mission, no cost.
    if (SMALLTALK_RE.test(prompt)) {
      await message.reply(smalltalkReply(agent));
      return;
    }

    let repo: string | undefined;
    if (agent.role === "coding") {
      const match = URL_RE.exec(prompt);
      const url = match?.[1]?.replace(/[),.\]]+$/, "");
      if (match && url) {
        repo = url;
        prompt = prompt
          .replace(match[0], " ")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
      } else if (this.cfg.defaultRepo) {
        repo = this.cfg.defaultRepo;
      } else {
        await message.reply(
          "🤔 which repo? include a git URL in the message (or set DEFAULT_REPO)"
        );
        return;
      }
      if (!prompt) {
        await message.reply(
          `👋 got the repo but no task — try \`@${agent.name} <task> ${repo}\``
        );
        return;
      }
    }

    // Requests made inside a thread reuse that thread as the mission thread.
    if (message.channel.isThread()) {
      this.pendingThreads.set(message.id, message.channel.id);
    }

    try {
      const { missionId, position } = await this.dispatcher.submit({
        agent,
        type: agent.role,
        prompt,
        repo,
        channelId: message.channelId,
        requestMessageId: message.id,
        requesterId: message.author.id,
      });
      await message.reply(
        position > 0
          ? fmtQueued(missionId, position)
          : `🫡 on it — I'll report back in the thread.\n-# ${missionId}`
      );
    } catch (err) {
      await message.reply(
        truncate(
          `💥 could not submit: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    } finally {
      this.pendingThreads.delete(message.id);
    }
  }

  private async onInteraction(
    agent: AgentDef,
    interaction: Interaction
  ): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.user.bot) return;
    if (interaction.user.id !== this.cfg.ownerId) {
      await interaction.reply({
        content: "⛔ not yours",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    switch (interaction.commandName) {
      case "code":
        await this.handleTaskCommand(agent, interaction, "coding");
        return;
      case "research":
        await this.handleTaskCommand(agent, interaction, "research");
        return;
      case "status": {
        const { active, queued } = await this.dispatcher.status();
        await interaction.reply(fmtStatus(active, queued));
        return;
      }
      case "cancel": {
        const missionId = interaction.options.getString("mission_id", true);
        const cancelled = await this.dispatcher.cancel(missionId);
        await interaction.reply(
          cancelled
            ? `🛑 \`${missionId}\` cancelled`
            : `🤷 no queued or running mission \`${missionId}\``
        );
        return;
      }
      default:
        await interaction.reply({
          content: `unknown command /${interaction.commandName}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  /** Shared /code + /research flow: defer → validate → submit → editReply. */
  private async handleTaskCommand(
    agent: AgentDef,
    interaction: ChatInputCommandInteraction,
    wants: AgentRole
  ): Promise<void> {
    if (agent.role !== wants) {
      await interaction.reply({
        content: `⛔ ${agent.name} is a ${agent.role} agent — this command lives on the ${wants} agents`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();

    const prompt = interaction.options.getString(
      wants === "coding" ? "task" : "question",
      true
    );
    let repo: string | undefined;
    if (wants === "coding") {
      repo = interaction.options.getString("repo") ?? this.cfg.defaultRepo;
      if (!repo) {
        await interaction.editReply(
          "🤔 which repo? pass the `repo` option (or set DEFAULT_REPO)"
        );
        return;
      }
    }

    try {
      const { missionId, position } = await this.dispatcher.submit({
        agent,
        type: wants,
        prompt,
        repo,
        channelId: interaction.channelId,
        requesterId: interaction.user.id,
      });
      await interaction.editReply(
        position > 0
          ? fmtQueued(missionId, position)
          : `🫡 on it — results will land in the thread.\n-# ${missionId}`
      );
    } catch (err) {
      await interaction.editReply(
        truncate(
          `💥 could not submit: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  }
}
