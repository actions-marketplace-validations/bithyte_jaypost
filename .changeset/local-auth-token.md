---
'telegram-ask': minor
---

Optional API token. `init` generates one for new setups (and asks when upgrading an install without one); the service then answers 401 without it. The CLI, `mcp` and the Node `Client` send it on their own; curl, n8n and container agents set `TELEGRAM_ASK_TOKEN` to the contents of `~/.config/telegram-ask/token`.
