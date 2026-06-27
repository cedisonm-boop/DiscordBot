#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/discord-openai-channel-monitor"
REPO_URL="${REPO_URL:-https://github.com/cedisonm-boop/DiscordBot.git}"
SERVICE_FILE="/etc/systemd/system/discord-openai-bot.service"

echo "Updating packages..."
sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [ ! -f /swapfile ]; then
  echo "Adding 1 GB swap file for the small Lightsail instance..."
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing app checkout..."
  git -C "$APP_DIR" pull --ff-only
else
  echo "Cloning app..."
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

echo "Installing app dependencies..."
npm install --omit=dev

mkdir -p data
if [ ! -f data/monitoring.json ]; then
  cp config/monitoring.json data/monitoring.json
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

sudo cp deploy/discord-openai-bot.service "$SERVICE_FILE"
sudo systemctl daemon-reload
sudo systemctl enable discord-openai-bot

cat <<EOF

Server setup is installed.

Next:
1. Edit secrets and IDs:
   nano $APP_DIR/.env

2. Start or restart the bot:
   sudo systemctl restart discord-openai-bot

3. Watch logs:
   sudo journalctl -u discord-openai-bot -f

EOF
