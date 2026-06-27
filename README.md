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

For easiest cloud use, keep secrets in Lightsail `.env` and let the Discord configuration panel edit the live routing file at `data/monitoring.json`.

Set this once in Lightsail `.env`:

```bash
MONITORING_CONFIG_FILE=data/monitoring.json
MONITORING_CONFIG_URL=
MONITORING_CONFIG_REFRESH_SECONDS=300
```

GitHub stays for code changes. Routine monitored-channel, keyword, tagged-user, and forwarding-channel changes should be made from Discord with `!monitor panel`.

Set `"analyzeWithOpenAI": false` for keyword-only testing. In that mode, matching terms trigger alerts without calling OpenAI.

The bot reads normal message text plus Discord embed text, including webhook/app posts with embed titles, descriptions, fields, footers, and authors.

Each channel can have its own trigger terms, tagged users, forwarding channel, and actions:

```json
{
  "channels": {
    "CHANNEL_ID_TO_WATCH": {
      "actions": ["mention", "forward"],
      "terms": ["looking for accommodation", "looking to rent"],
      "mentionUserIds": ["USER_ID_TO_TAG"],
      "forwardChannelId": "ALERT_CHANNEL_ID",
      "mentionInForward": true,
      "analyzeWithOpenAI": false
    },
    "ANOTHER_CHANNEL_ID_TO_WATCH": {
      "actions": ["forward"],
      "terms": ["refund", "chargeback"],
      "forwardChannelId": "DIFFERENT_ALERT_CHANNEL_ID",
      "analyzeWithOpenAI": true
    }
  }
}
```

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

`ALERT_ACTIONS` controls the default behavior after OpenAI decides a message needs attention. In `data/monitoring.json`, each channel can override this with its own `actions` list:

- `mention` posts a mention for the configured user ID(s) in the source channel.
- `forward` posts an alert in `FORWARD_CHANNEL_ID`.
- Use both as `mention,forward`.

## Discord Commands

The default command prefix is `!monitor`. Users listed in `commandUserIds` can run commands. If `commandUserIds` is empty, users with Discord **Manage Server** permission can run them.

```text
!monitor status
!monitor panel
!monitor reload
!monitor backfill 50
!monitor backfill 1515161469954818098 100
```

Post `!monitor panel` in your private `#BotConfiguration` channel to show the interactive configuration UI. The panel can add/select monitored channels, edit keywords, choose users to notify, choose a forwarding channel, choose actions, and toggle OpenAI analysis.

`backfill` manually scans recent message history. Discord allows up to 100 recent messages per fetch.

## Notes

Keep `.env` private. It contains both your Discord token and OpenAI API key.

The bot ignores its own messages to avoid loops, but it can process webhook/app messages from tools like OneStopSocial.

## Cloud Deployment

For AWS Lightsail deployment, see [docs/lightsail.md](docs/lightsail.md).
