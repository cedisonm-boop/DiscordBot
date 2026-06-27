import "dotenv/config";

import { readFile } from "node:fs/promises";

import { Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const env = {
  discordToken: process.env.DISCORD_TOKEN,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  channelRules: parseChannelRules(process.env.CHANNEL_RULES),
  channelMentionUserIds: parseChannelMentionUserIds(process.env.CHANNEL_MENTION_USER_IDS),
  configFile: process.env.MONITORING_CONFIG_FILE || "config/monitoring.json",
  configUrl: process.env.MONITORING_CONFIG_URL,
  configRefreshSeconds: Number(process.env.MONITORING_CONFIG_REFRESH_SECONDS || "300"),
  monitoredChannelIds: parseList(process.env.MONITORED_CHANNEL_IDS),
  watchTerms: parseList(process.env.WATCH_TERMS),
  alertActions: new Set(parseList(process.env.ALERT_ACTIONS || "mention,forward")),
  mentionUserIds: uniqueList([
    ...parseList(process.env.MENTION_USER_IDS),
    ...parseList(process.env.MENTION_USER_ID)
  ]),
  forwardChannelId: process.env.FORWARD_CHANNEL_ID,
  mentionInForward: parseBoolean(process.env.MENTION_IN_FORWARD, false)
};

validateConfig(env);

const openai = new OpenAI({ apiKey: env.openAiApiKey });
let monitoringConfig = buildEnvMonitoringConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const processedMessageIds = new Set();
const maxRememberedMessageIds = 2000;

const AnalysisResult = z.object({
  shouldAlert: z.boolean().describe("True only when the message should be acted on."),
  priority: z.enum(["low", "medium", "high"]).describe("The urgency of the message."),
  category: z.string().describe("Short category label, for example billing, safety, support, or spam."),
  summary: z.string().describe("One concise sentence suitable for a Discord alert."),
  reason: z.string().describe("Brief reason why this message should or should not be acted on.")
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

await loadMonitoringConfig();
startConfigRefresh();

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.id === client.user?.id) return;
    if (await handleMonitorCommand(message)) return;

    await processCandidateMessage(message, { source: "live" });
  } catch (error) {
    console.error("Failed to process message:", error);
  }
});

client.login(env.discordToken);

function parseList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseChannelRules(value) {
  return parseChannelMap(value, "CHANNEL_RULES", "terms");
}

function parseChannelMentionUserIds(value) {
  return parseChannelMap(value, "CHANNEL_MENTION_USER_IDS", "userIds");
}

function parseChannelMap(value, envName, valueKey) {
  if (!value) return [];

  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(":");

      if (separatorIndex === -1) {
        throw new Error(`Invalid ${envName} entry: ${entry}`);
      }

      const channelId = entry.slice(0, separatorIndex).trim();
      const values = entry
        .slice(separatorIndex + 1)
        .split("|")
        .map((valuePart) => valuePart.trim())
        .filter(Boolean);

      if (!channelId) {
        throw new Error(`Invalid ${envName} entry with empty channel ID: ${entry}`);
      }

      return { channelId, [valueKey]: uniqueList(values) };
    });
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return parseList(value);
}

function validateConfig(config) {
  const missing = [];

  if (!config.discordToken) missing.push("DISCORD_TOKEN");
  if (!config.openAiApiKey) missing.push("OPENAI_API_KEY");

  for (const action of config.alertActions) {
    if (!["mention", "forward"].includes(action)) {
      throw new Error(`Unsupported ALERT_ACTIONS value: ${action}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }
}

function getChannelRule(channelId) {
  const rule = monitoringConfig.channels[channelId];

  if (rule) {
    return {
      channelId,
      terms: rule.terms,
      mentionUserIds: rule.mentionUserIds,
      forwardChannelId: rule.forwardChannelId,
      analyzeWithOpenAI: rule.analyzeWithOpenAI
    };
  }

  if (Object.keys(monitoringConfig.channels).length > 0) {
    return null;
  }

  if (
    monitoringConfig.monitoredChannelIds.length > 0 &&
    !monitoringConfig.monitoredChannelIds.includes(channelId)
  ) {
    return null;
  }

  return {
    channelId,
    terms: monitoringConfig.defaultTerms,
    mentionUserIds: monitoringConfig.mentionUserIds,
    forwardChannelId: monitoringConfig.forwardChannelId,
    analyzeWithOpenAI: monitoringConfig.analyzeWithOpenAI
  };
}

async function processCandidateMessage(message, { source = "live" } = {}) {
  if (message.author.id === client.user?.id) {
    return { matched: false, alerted: false };
  }

  if (isMonitorCommandMessage(message)) {
    return { matched: false, alerted: false };
  }

  const channelRule = getChannelRule(message.channelId);
  if (!channelRule) {
    return { matched: false, alerted: false };
  }

  const searchableText = getSearchableMessageText(message);
  if (!searchableText) {
    return { matched: false, alerted: false };
  }

  const matchedTerms = getMatchedTerms(searchableText, channelRule.terms);
  if (channelRule.terms.length > 0 && matchedTerms.length === 0) {
    return { matched: false, alerted: false };
  }

  if (processedMessageIds.has(message.id)) {
    return { matched: true, alerted: false };
  }

  const analysis = channelRule.analyzeWithOpenAI
    ? await analyzeMessage(message, matchedTerms, channelRule.terms, searchableText, source)
    : buildKeywordOnlyAnalysis(matchedTerms);

  rememberProcessedMessage(message.id);

  if (!analysis.shouldAlert) {
    return { matched: true, alerted: false };
  }

  await runAlertActions(message, analysis, matchedTerms, channelRule, searchableText);
  return { matched: true, alerted: true };
}

function rememberProcessedMessage(messageId) {
  processedMessageIds.add(messageId);

  if (processedMessageIds.size <= maxRememberedMessageIds) {
    return;
  }

  const oldestMessageId = processedMessageIds.values().next().value;
  processedMessageIds.delete(oldestMessageId);
}

function getSearchableMessageText(message) {
  const parts = [];

  appendTextPart(parts, message.content);

  for (const embed of message.embeds || []) {
    appendTextPart(parts, embed.author?.name);
    appendTextPart(parts, embed.title);
    appendTextPart(parts, embed.description);

    for (const field of embed.fields || []) {
      appendTextPart(parts, field.name);
      appendTextPart(parts, field.value);
    }

    appendTextPart(parts, embed.footer?.text);
  }

  for (const attachment of message.attachments?.values?.() || []) {
    appendTextPart(parts, attachment.name);
    appendTextPart(parts, attachment.description);
  }

  return parts.join("\n").trim();
}

function appendTextPart(parts, value) {
  if (typeof value !== "string") return;

  const trimmed = value.trim();
  if (trimmed) parts.push(trimmed);
}

function isMonitorCommandMessage(message) {
  const prefix = monitoringConfig.commandPrefix;

  return Boolean(prefix && message.content?.trim().startsWith(prefix));
}

function getMatchedTerms(content, terms) {
  const lowerContent = String(content || "").toLowerCase();
  return terms.filter((term) => lowerContent.includes(term.toLowerCase()));
}

async function analyzeMessage(message, matchedTerms, watchedTerms, searchableText, source) {
  const response = await openai.responses.parse({
    model: env.openAiModel,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: [
          "You are a Discord moderation and operations triage assistant.",
          "Decide whether the message needs human attention.",
          "Be conservative: alert only when the message is relevant to the watched terms, safety, abuse, billing risk, legal risk, security, outages, or urgent support.",
          "Do not invent facts that are not in the message."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          author: message.author.tag,
          channelId: message.channelId,
          source,
          matchedTerms,
          watchedTerms,
          message: searchableText
        })
      }
    ],
    text: {
      format: zodTextFormat(AnalysisResult, "discord_alert_analysis")
    }
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI did not return parsed analysis.");
  }

  return response.output_parsed;
}

function buildKeywordOnlyAnalysis(matchedTerms) {
  return {
    shouldAlert: true,
    priority: "medium",
    category: "keyword-match",
    summary: matchedTerms.length > 0
      ? `Matched watched term(s): ${matchedTerms.join(", ")}`
      : "No keyword filter configured.",
    reason: "OpenAI analysis is disabled for this rule, so this alert was triggered by keyword matching only."
  };
}

async function runAlertActions(message, analysis, matchedTerms, channelRule, searchableText) {
  const mentionUserIds = getMentionUserIds(channelRule);

  if (monitoringConfig.actions.has("mention")) {
    await mentionUserInSourceChannel(message, analysis, mentionUserIds);
  }

  if (monitoringConfig.actions.has("forward")) {
    await forwardAlert(
      message,
      analysis,
      matchedTerms,
      mentionUserIds,
      channelRule.forwardChannelId,
      searchableText
    );
  }
}

async function handleMonitorCommand(message) {
  const prefix = monitoringConfig.commandPrefix;
  const content = message.content?.trim();

  if (!prefix || !content?.startsWith(prefix)) {
    return false;
  }

  if (!isCommandAuthorized(message)) {
    await message.reply(
      "You are not allowed to run monitor commands. Add your Discord user ID to `commandUserIds`, or use an account with Manage Server permission."
    );
    return true;
  }

  const rest = content.slice(prefix.length).trim();
  const [command = "help", ...args] = rest.split(/\s+/).filter(Boolean);
  const normalizedCommand = command.toLowerCase();

  if (["help", "commands"].includes(normalizedCommand)) {
    await message.reply(buildCommandHelp(prefix));
    return true;
  }

  if (normalizedCommand === "status") {
    await message.reply(buildCommandStatus());
    return true;
  }

  if (normalizedCommand === "reload") {
    await loadMonitoringConfig();
    await message.reply("Monitoring config reload requested.");
    return true;
  }

  if (["backfill", "scan"].includes(normalizedCommand)) {
    await runBackfillCommand(message, args);
    return true;
  }

  await message.reply(`Unknown monitor command. Try \`${prefix} help\`.`);
  return true;
}

function isCommandAuthorized(message) {
  const commandUserIds = monitoringConfig.commandUserIds || [];

  if (commandUserIds.includes(message.author.id)) {
    return true;
  }

  if (commandUserIds.length > 0) {
    return false;
  }

  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function buildCommandHelp(prefix) {
  return [
    "Monitor commands:",
    `\`${prefix} status\` - show active routing.`,
    `\`${prefix} reload\` - reload GitHub monitoring config now.`,
    `\`${prefix} backfill [limit]\` - scan recent messages in configured channels.`,
    `\`${prefix} backfill <channelId> [limit]\` - scan one channel.`,
    "Limit can be 1 to 100 because Discord only returns up to 100 messages per request."
  ].join("\n");
}

function buildCommandStatus() {
  const configuredChannelIds = getConfiguredBackfillChannelIds();
  const commandUsers = monitoringConfig.commandUserIds.length > 0
    ? monitoringConfig.commandUserIds.map((userId) => `<@${userId}>`).join(", ")
    : "users with Manage Server permission";

  return [
    "Monitor is running.",
    `Command prefix: \`${monitoringConfig.commandPrefix}\``,
    `Configured source channels: ${configuredChannelIds.length > 0 ? configuredChannelIds.map((channelId) => `<#${channelId}>`).join(", ") : "default/global channels"}`,
    `Actions: ${[...monitoringConfig.actions].join(", ") || "none"}`,
    `Default OpenAI analysis: ${monitoringConfig.analyzeWithOpenAI ? "on" : "off"}`,
    `Command access: ${commandUsers}`
  ].join("\n");
}

async function runBackfillCommand(message, args) {
  const { channelIds, limit } = parseBackfillRequest(args, message.channelId);

  if (channelIds.length === 0) {
    await message.reply("No channels are configured for backfill.");
    return;
  }

  await message.reply(
    `Backfill started for ${channelIds.length} channel(s), up to ${limit} recent message(s) each.`
  );

  const report = {
    scanned: 0,
    matched: 0,
    alerted: 0,
    errors: []
  };

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel?.isTextBased() || !channel.messages?.fetch) {
        throw new Error("Channel is not a readable text channel.");
      }

      const fetchedMessages = await channel.messages.fetch({ limit });
      const messages = [...fetchedMessages.values()].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
      );

      for (const oldMessage of messages) {
        if (isMonitorCommandMessage(oldMessage)) continue;

        report.scanned += 1;
        const result = await processCandidateMessage(oldMessage, { source: "backfill" });

        if (result.matched) report.matched += 1;
        if (result.alerted) report.alerted += 1;
      }
    } catch (error) {
      report.errors.push(`<#${channelId}>: ${error.message}`);
      console.error(`Backfill failed for channel ${channelId}:`, error);
    }
  }

  const lines = [
    `Backfill complete. Scanned ${report.scanned} message(s), matched ${report.matched}, sent ${report.alerted} alert(s).`
  ];

  if (report.errors.length > 0) {
    lines.push(`Errors: ${truncate(report.errors.join("; "), 1500)}`);
  }

  await message.reply(lines.join("\n"));
}

function parseBackfillRequest(args, fallbackChannelId) {
  const configuredChannelIds = getConfiguredBackfillChannelIds();
  let channelIds = configuredChannelIds.length > 0 ? configuredChannelIds : [fallbackChannelId];
  let limit = 50;
  const possibleChannelId = extractDiscordId(args[0]);

  if (possibleChannelId) {
    channelIds = [possibleChannelId];
    limit = Number(args[1] || limit);
  } else if (args[0]) {
    limit = Number(args[0]);
  }

  return {
    channelIds: uniqueList(channelIds),
    limit: clampFetchLimit(limit)
  };
}

function getConfiguredBackfillChannelIds() {
  const channelIds = Object.keys(monitoringConfig.channels);
  return channelIds.length > 0 ? channelIds : monitoringConfig.monitoredChannelIds;
}

function extractDiscordId(value) {
  return String(value || "").match(/\d{17,20}/)?.[0] || "";
}

function clampFetchLimit(value) {
  const limit = Number.isFinite(value) ? Math.trunc(value) : 50;
  return Math.max(1, Math.min(limit, 100));
}

function getMentionUserIds(channelRule) {
  return channelRule.mentionUserIds.length > 0
    ? channelRule.mentionUserIds
    : monitoringConfig.mentionUserIds;
}

function formatMentions(userIds) {
  return userIds.map((userId) => `<@${userId}>`).join(" ");
}

async function mentionUserInSourceChannel(message, analysis, mentionUserIds) {
  if (mentionUserIds.length === 0) return;

  await message.channel.send({
    content: [
      formatMentions(mentionUserIds),
      `Flagged ${analysis.priority} priority ${analysis.category}: ${analysis.summary}`,
      message.url
    ].join("\n"),
    allowedMentions: {
      users: mentionUserIds
    }
  });
}

async function forwardAlert(
  message,
  analysis,
  matchedTerms,
  mentionUserIds,
  forwardChannelId,
  searchableText
) {
  if (!forwardChannelId) return;

  const channel = await client.channels.fetch(forwardChannelId);

  if (!channel?.isTextBased()) {
    throw new Error("FORWARD_CHANNEL_ID must be a text-based channel.");
  }

  const embed = new EmbedBuilder()
    .setColor(colorForPriority(analysis.priority))
    .setTitle(`Flagged ${analysis.category}`)
    .setURL(message.url)
    .setDescription(truncate(analysis.summary, 4000))
    .addFields(
      {
        name: "Priority",
        value: analysis.priority,
        inline: true
      },
      {
        name: "Matched terms",
        value: matchedTerms.length > 0 ? truncate(matchedTerms.join(", "), 1024) : "No keyword filter configured",
        inline: true
      },
      {
        name: "Source",
        value: `<#${message.channelId}> by ${message.author.tag}`,
        inline: false
      },
      {
        name: "Reason",
        value: truncate(analysis.reason, 1024),
        inline: false
      },
      {
        name: "Original message",
        value: truncate(searchableText || message.content || "[no text content]", 1024),
        inline: false
      }
    )
    .setTimestamp(message.createdAt);

  const mentionContent = monitoringConfig.mentionInForward && mentionUserIds.length > 0
    ? formatMentions(mentionUserIds)
    : undefined;

  await channel.send({
    content: mentionContent,
    embeds: [embed],
    allowedMentions: {
      users: monitoringConfig.mentionInForward ? mentionUserIds : []
    }
  });
}

function colorForPriority(priority) {
  if (priority === "high") return 0xdb2f2f;
  if (priority === "medium") return 0xf5a524;
  return 0x2f80ed;
}

function truncate(value, maxLength) {
  if (!value) return "[empty]";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

async function loadMonitoringConfig() {
  try {
    const nextConfig = env.configUrl
      ? normalizeMonitoringConfig(await fetchMonitoringConfig(env.configUrl))
      : normalizeMonitoringConfig(JSON.parse(await readFile(env.configFile, "utf8")));

    monitoringConfig = nextConfig;
    console.log("Monitoring config loaded.");
  } catch (error) {
    if (error.code === "ENOENT" && !env.configUrl) {
      console.log("No monitoring config file found; using .env monitoring settings.");
      return;
    }

    console.error("Failed to load monitoring config; keeping previous settings:", error);
  }
}

async function fetchMonitoringConfig(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Config request failed with status ${response.status}`);
  }

  return response.json();
}

function startConfigRefresh() {
  if (env.configRefreshSeconds <= 0) return;

  setInterval(() => {
    loadMonitoringConfig();
  }, env.configRefreshSeconds * 1000);
}

function buildEnvMonitoringConfig() {
  const channelMentionsById = new Map(
    env.channelMentionUserIds.map((rule) => [rule.channelId, rule.userIds])
  );
  const channels = Object.fromEntries(
    env.channelRules.map((rule) => [
      rule.channelId,
      {
        terms: rule.terms,
        mentionUserIds: channelMentionsById.get(rule.channelId) || [],
        forwardChannelId: env.forwardChannelId || "",
        analyzeWithOpenAI: true
      }
    ])
  );

  return normalizeMonitoringConfig({
    actions: [...env.alertActions],
    defaultTerms: env.watchTerms,
    analyzeWithOpenAI: true,
    forwardChannelId: env.forwardChannelId || "",
    mentionInForward: env.mentionInForward,
    mentionUserIds: env.mentionUserIds,
    monitoredChannelIds: env.monitoredChannelIds,
    channels
  });
}

function normalizeMonitoringConfig(config) {
  const normalizedChannels = {};

  for (const [channelId, channelConfig] of Object.entries(config.channels || {})) {
    const defaultAnalyzeWithOpenAI = parseConfigBoolean(config.analyzeWithOpenAI, true);

    normalizedChannels[channelId] = {
      terms: parseStringList(channelConfig.terms || channelConfig.watchTerms),
      mentionUserIds: parseStringList(channelConfig.mentionUserIds || channelConfig.mentionUserId),
      forwardChannelId: String(channelConfig.forwardChannelId || config.forwardChannelId || ""),
      analyzeWithOpenAI: parseConfigBoolean(channelConfig.analyzeWithOpenAI, defaultAnalyzeWithOpenAI)
    };
  }

  const actions = parseStringList(config.actions || config.alertActions || [...env.alertActions]);

  for (const action of actions) {
    if (!["mention", "forward"].includes(action)) {
      throw new Error(`Unsupported monitoring config action: ${action}`);
    }
  }

  return {
    actions: new Set(actions),
    analyzeWithOpenAI: parseConfigBoolean(config.analyzeWithOpenAI, true),
    channels: normalizedChannels,
    commandPrefix: String(config.commandPrefix || "!monitor"),
    commandUserIds: parseStringList(config.commandUserIds || config.commandUserId || []),
    defaultTerms: parseStringList(config.defaultTerms || config.watchTerms || env.watchTerms),
    forwardChannelId: String(config.forwardChannelId || env.forwardChannelId || ""),
    mentionInForward: Boolean(config.mentionInForward ?? env.mentionInForward),
    mentionUserIds: parseStringList(config.mentionUserIds || config.mentionUserId || env.mentionUserIds),
    monitoredChannelIds: parseStringList(config.monitoredChannelIds || env.monitoredChannelIds)
  };
}

function parseConfigBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
