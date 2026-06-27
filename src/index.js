import "dotenv/config";

import { Client, EmbedBuilder, Events, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const env = {
  discordToken: process.env.DISCORD_TOKEN,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  monitoredChannelIds: parseList(process.env.MONITORED_CHANNEL_IDS),
  watchTerms: parseList(process.env.WATCH_TERMS),
  alertActions: new Set(parseList(process.env.ALERT_ACTIONS || "mention,forward")),
  mentionUserId: process.env.MENTION_USER_ID,
  forwardChannelId: process.env.FORWARD_CHANNEL_ID,
  mentionInForward: parseBoolean(process.env.MENTION_IN_FORWARD, false)
};

validateConfig(env);

const openai = new OpenAI({ apiKey: env.openAiApiKey });

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

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!shouldMonitorChannel(message.channelId)) return;

    const matchedTerms = getMatchedTerms(message.content);
    if (env.watchTerms.length > 0 && matchedTerms.length === 0) return;

    const analysis = await analyzeMessage(message, matchedTerms);
    if (!analysis.shouldAlert) return;

    await runAlertActions(message, analysis, matchedTerms);
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

function validateConfig(config) {
  const missing = [];

  if (!config.discordToken) missing.push("DISCORD_TOKEN");
  if (!config.openAiApiKey) missing.push("OPENAI_API_KEY");
  if (config.alertActions.has("mention") && !config.mentionUserId) {
    missing.push("MENTION_USER_ID");
  }
  if (config.alertActions.has("forward") && !config.forwardChannelId) {
    missing.push("FORWARD_CHANNEL_ID");
  }
  if (config.mentionInForward && !config.mentionUserId) {
    missing.push("MENTION_USER_ID");
  }

  for (const action of config.alertActions) {
    if (!["mention", "forward"].includes(action)) {
      throw new Error(`Unsupported ALERT_ACTIONS value: ${action}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment values: ${missing.join(", ")}`);
  }
}

function shouldMonitorChannel(channelId) {
  return env.monitoredChannelIds.length === 0 || env.monitoredChannelIds.includes(channelId);
}

function getMatchedTerms(content) {
  const lowerContent = content.toLowerCase();
  return env.watchTerms.filter((term) => lowerContent.includes(term.toLowerCase()));
}

async function analyzeMessage(message, matchedTerms) {
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
          watchedTerms: env.watchTerms,
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

async function runAlertActions(message, analysis, matchedTerms) {
  if (env.alertActions.has("mention")) {
    await mentionUserInSourceChannel(message, analysis);
  }

  if (env.alertActions.has("forward")) {
    await forwardAlert(message, analysis, matchedTerms);
  }
}

async function mentionUserInSourceChannel(message, analysis) {
  await message.channel.send({
    content: [
      `<@${env.mentionUserId}>`,
      `Flagged ${analysis.priority} priority ${analysis.category}: ${analysis.summary}`,
      message.url
    ].join("\n"),
    allowedMentions: {
      users: [env.mentionUserId]
    }
  });
}

async function forwardAlert(message, analysis, matchedTerms) {
  const channel = await client.channels.fetch(env.forwardChannelId);

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

  const mentionContent = env.mentionInForward ? `<@${env.mentionUserId}>` : undefined;

  await channel.send({
    content: mentionContent,
    embeds: [embed],
    allowedMentions: {
      users: env.mentionInForward && env.mentionUserId ? [env.mentionUserId] : []
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
