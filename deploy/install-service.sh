#!/usr/bin/env bash
# Installs the bot as a systemd user service. Needs a config from `npm run onboard`.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name=telegram-approval-bot

# Same precedence as src/config.ts: APPROVAL_BOT_CONFIG, XDG_CONFIG_HOME, ~/.config
if [ -n "${APPROVAL_BOT_CONFIG:-}" ]; then
  config="$APPROVAL_BOT_CONFIG"
else
  config="${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/telegram-approval-bot/config.json"
fi

if [ ! -f "$config" ]; then
  echo "No config file at $config" >&2
  echo "Run \`npm run onboard\` first." >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
  echo "node not found in PATH; need Node 24 or newer" >&2
  exit 1
fi
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "Need Node 24 or newer, found $("$node_bin" -v) at $node_bin" >&2
  exit 1
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

# Escape \, & and the | delimiter so paths can't break the sed replacement.
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
sed -e "s|@REPO@|$(esc "$repo")|g" -e "s|@NODE@|$(esc "$node_bin")|g" \
  "$repo/deploy/$name.service" > "$unit_dir/$name.service"

# A non-default config path has to reach the service too.
if [ -n "${APPROVAL_BOT_CONFIG:-}" ]; then
  sed -i "/^\[Service\]/a Environment=\"APPROVAL_BOT_CONFIG=$(esc "$config")\"" "$unit_dir/$name.service"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$name"

echo
echo "Installed $unit_dir/$name.service and started it."
echo "Status: systemctl --user status $name"
echo "Logs:   journalctl --user -u $name -f"
echo
echo "To keep the service running while you're logged out, run (not done for you):"
echo "  loginctl enable-linger $USER"
