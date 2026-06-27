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

`MONITORED_CHANNEL_IDS` controls which Discord channels are watched. Use comma-separated channel IDs, or leave it blank to watch every text channel the bot can access.

`WATCH_TERMS` controls the first filter. If any term appears in a message, the bot sends the message to OpenAI for analysis. Leave it blank to analyze every message in monitored channels.

`ALERT_ACTIONS` controls what happens after OpenAI decides a message needs attention:

- `mention` posts a mention for `MENTION_USER_ID` in the source channel.
- `forward` posts an alert in `FORWARD_CHANNEL_ID`.
- Use both as `mention,forward`.

## Notes

Keep `.env` private. It contains both your Discord token and OpenAI API key.

The bot ignores messages from other bots to avoid loops.
