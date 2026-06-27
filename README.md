# Discord OpenAI Channel Monitor

This starter bot watches Discord messages, checks for configured text, asks OpenAI whether the message needs attention, then can mention a specific user in the source channel and/or forward the alert to another channel.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the bot's **Message Content Intent**.
3. Invite the bot to your server with permission to read messages, send messages, and view the channels you configure.
4. Copy `.env.example` to `.env`, then fill in the values.
5. Install dependencies:

```bash
npm install
```

6. Start the bot:

```bash
npm start
```

## Configuration

For easiest cloud use, keep secrets in Lightsail `.env` and edit channel routing in [config/monitoring.json](config/monitoring.json) on GitHub.

Set this once in Lightsail `.env`:

```bash
MONITORING_CONFIG_URL=https://raw.githubusercontent.com/cedisonm-boop/DiscordBot/main/config/monitoring.json
MONITORING_CONFIG_REFRESH_SECONDS=300
```

Then edit `config/monitoring.json` in GitHub whenever you need to change watched channels, keywords, tagged users, or forwarding channels. The bot reloads it automatically every 5 minutes by default.

Set `"analyzeWithOpenAI": false` for keyword-only testing. In that mode, matching terms trigger alerts without calling OpenAI.

The bot reads normal message text plus Discord embed text, including webhook/app posts with embed titles, descriptions, fields, footers, and authors.

`MONITORED_CHANNEL_IDS` controls which Discord channels are watched. Use comma-separated channel IDs, or leave it blank to watch every text channel the bot can access.

`WATCH_TERMS` controls the first filter. If any term appears in a message, the bot sends the message to OpenAI for analysis. Leave it blank to analyze every message in monitored channels.

`CHANNEL_RULES` lets different channels use different watched terms. Use this format:

```bash
CHANNEL_RULES=111111111111111111:refund|chargeback|payment;222222222222222222:security|login|password
```

When `CHANNEL_RULES` is set, it overrides `MONITORED_CHANNEL_IDS` and `WATCH_TERMS`.

`MENTION_USER_ID` sets one global user to tag. `MENTION_USER_IDS` sets multiple global users, separated by commas.

`CHANNEL_MENTION_USER_IDS` lets different channels tag different users. Use this format:

```bash
CHANNEL_MENTION_USER_IDS=111111111111111111:333333333333333333|444444444444444444;222222222222222222:555555555555555555
```

When `CHANNEL_MENTION_USER_IDS` is set for a channel, it overrides `MENTION_USER_ID` and `MENTION_USER_IDS` for that channel.

`ALERT_ACTIONS` controls what happens after OpenAI decides a message needs attention:

- `mention` posts a mention for the configured user ID(s) in the source channel.
- `forward` posts an alert in `FORWARD_CHANNEL_ID`.
- Use both as `mention,forward`.

## Discord Commands

The default command prefix is `!monitor`. Users listed in `commandUserIds` can run commands. If `commandUserIds` is empty, users with Discord **Manage Server** permission can run them.

```text
!monitor status
!monitor reload
!monitor backfill 50
!monitor backfill 1515161469954818098 100
```

`backfill` manually scans recent message history. Discord allows up to 100 recent messages per fetch.

## Notes

Keep `.env` private. It contains both your Discord token and OpenAI API key.

The bot ignores its own messages to avoid loops, but it can process webhook/app messages from tools like OneStopSocial.

## Cloud Deployment

For AWS Lightsail deployment, see [docs/lightsail.md](docs/lightsail.md).
