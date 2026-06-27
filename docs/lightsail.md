# AWS Lightsail Deployment

Use this for a small always-on AWS server that runs the Discord bot in the cloud.

## Create The Instance

1. In Lightsail, choose **Create instance**.
2. Region: **Singapore, ap-southeast-1**.
3. Platform: **Linux/Unix**.
4. Blueprint: **OS Only**.
5. OS: **Ubuntu 24.04 LTS** or the newest Ubuntu LTS shown.
6. Plan: choose the **$5 USD/month** plan with public IPv4.
7. Name: `discord-openai-bot`.
8. Choose **Create instance**.

The bot only needs outbound internet access, so you do not need to open HTTP or HTTPS ports.

## Install The Bot

When the instance is running, open the Lightsail browser SSH terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/cedisonm-boop/DiscordBot/main/deploy/lightsail-setup.sh | bash
```

Then edit the environment file:

```bash
nano /opt/discord-openai-channel-monitor/.env
```

Fill in:

```bash
DISCORD_TOKEN=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
MONITORING_CONFIG_URL=https://raw.githubusercontent.com/cedisonm-boop/DiscordBot/main/config/monitoring.json
MONITORING_CONFIG_REFRESH_SECONDS=300
CHANNEL_RULES=
CHANNEL_MENTION_USER_IDS=
MONITORED_CHANNEL_IDS=
WATCH_TERMS=urgent,refund,chargeback,security
ALERT_ACTIONS=mention,forward
MENTION_USER_ID=
MENTION_USER_IDS=
FORWARD_CHANNEL_ID=
MENTION_IN_FORWARD=false
```

For different terms in different Discord channels, use `CHANNEL_RULES`:

```bash
CHANNEL_RULES=111111111111111111:refund|chargeback|payment;222222222222222222:security|login|password
```

When `CHANNEL_RULES` is set, it overrides `MONITORED_CHANNEL_IDS` and `WATCH_TERMS`.

For different tagged users in different Discord channels, use `CHANNEL_MENTION_USER_IDS`:

```bash
CHANNEL_MENTION_USER_IDS=111111111111111111:333333333333333333|444444444444444444;222222222222222222:555555555555555555
```

When `CHANNEL_MENTION_USER_IDS` is set for a channel, it overrides `MENTION_USER_ID` and `MENTION_USER_IDS` for that channel.

Save with `Ctrl+O`, press `Enter`, then exit with `Ctrl+X`.

Start the bot:

```bash
sudo systemctl restart discord-openai-bot
```

Watch logs:

```bash
sudo journalctl -u discord-openai-bot -f
```

Check service status:

```bash
sudo systemctl status discord-openai-bot
```

## Updating Later

After pushing code changes to GitHub, SSH into the instance and run:

```bash
cd /opt/discord-openai-channel-monitor
git pull
npm install --omit=dev
sudo systemctl restart discord-openai-bot
```

Never commit `.env` to GitHub. It contains your Discord token and OpenAI API key.

## Editing Routing Without SSH

For normal channel/user/keyword changes, edit `config/monitoring.json` in GitHub. The bot reloads `MONITORING_CONFIG_URL` every 5 minutes by default.

Use this shape:

```json
{
  "actions": ["mention", "forward"],
  "analyzeWithOpenAI": false,
  "commandPrefix": "!monitor",
  "commandUserIds": [],
  "defaultTerms": ["urgent", "refund", "chargeback", "security"],
  "forwardChannelId": "ALERT_CHANNEL_ID",
  "mentionInForward": false,
  "mentionUserIds": [],
  "monitoredChannelIds": [],
  "channels": {
    "CHANNEL_ID_TO_WATCH": {
      "terms": ["refund", "chargeback", "payment"],
      "mentionUserIds": ["USER_ID_TO_TAG"],
      "forwardChannelId": "ALERT_CHANNEL_ID",
      "analyzeWithOpenAI": false
    }
  }
}
```

Set `"analyzeWithOpenAI": false` for keyword-only testing. Set it to `true` when you want OpenAI analysis to decide whether a matched message should alert.

The bot reads normal message text and Discord embed text, so webhook/app posts from tools like OneStopSocial can be matched too.

## Manual Backfill Commands

In Discord, use these commands to make the bot scan recent message history:

```text
!monitor status
!monitor reload
!monitor backfill 50
!monitor backfill 1515161469954818098 100
```

`!monitor backfill 50` scans the configured source channel(s), up to 50 recent messages per channel. `!monitor backfill 1515161469954818098 100` scans one specific channel, up to Discord's 100-message fetch limit.

Users listed in `commandUserIds` can run commands. If `commandUserIds` is empty, users with Discord **Manage Server** permission can run them.

Discord tokens and OpenAI API keys still belong only in Lightsail `.env`, never in GitHub.
