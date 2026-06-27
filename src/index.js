import "dotenv/config";

import { readFile } from "node:fs/promises";

import { Client, EmbedBuilder, Events, GatewayIntentBits } from "discord.js";
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
    if (message.author.bot) return;

    const channelRule = getChannelRule(message.channelId);
    if (!channelRule) return;

    const matchedTerms = getMatchedTerms(message.content, channelRule.terms);
    if (channelRule.terms.length > 0 && matchedTerms.length === 0) return;

    const analysis = await analyzeMessage(message, matchedTerms, channelRule.terms);
    if (!analysis.shouldAlert) return;

    await runAlertActions(message, analysis, matchedTerms, channelRule);
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
      forwardChannelId: rule.forwardChannelId
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
    forwardChannelId: monitoringConfig.forwardChannelId
  };
}

function getMatchedTerms(content, terms) {
  const lowerContent = content.toLowerCase();
  return terms.filter((term) => lowerContent.includes(term.toLowerCase()));
}

async function analyzeMessage(message, matchedTerms, watchedTerms) {
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
          matchedTerms,
          watchedTerms,
          message: message.content
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

async function runAlertActions(message, analysis, matchedTerms, channelRule) {
  const mentionUserIds = getMentionUserIds(channelRule);

  if (monitoringConfig.actions.has("mention")) {
    await mentionUserInSourceChannel(message, analysis, mentionUserIds);
  }

  if (monitoringConfig.actions.has("forward")) {
    await forwardAlert(message, analysis, matchedTerms, mentionUserIds, channelRule.forwardChannelId);
  }
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

async function forwardAlert(message, analysis, matchedTerms, mentionUserIds, forwardChannelId) {
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
        value: truncate(message.content || "[no text content]", 1024),
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
        forwardChannelId: env.forwardChannelId || ""
      }
    ])
  );

  return normalizeMonitoringConfig({
    actions: [...env.alertActions],
    defaultTerms: env.watchTerms,
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
    normalizedChannels[channelId] = {
      terms: parseStringList(channelConfig.terms || channelConfig.watchTerms),
      mentionUserIds: parseStringList(channelConfig.mentionUserIds || channelConfig.mentionUserId),
      forwardChannelId: String(channelConfig.forwardChannelId || config.forwardChannelId || "")
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
    channels: normalizedChannels,
    defaultTerms: parseStringList(config.defaultTerms || config.watchTerms || env.watchTerms),
    forwardChannelId: String(config.forwardChannelId || env.forwardChannelId || ""),
    mentionInForward: Boolean(config.mentionInForward ?? env.mentionInForward),
    mentionUserIds: parseStringList(config.mentionUserIds || config.mentionUserId || env.mentionUserIds),
    monitoredChannelIds: parseStringList(config.monitoredChannelIds || env.monitoredChannelIds)
  };
}
