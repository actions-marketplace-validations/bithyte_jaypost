# telegram-ask

## 0.4.0

### Minor Changes

- 36d4db7: Bot commands: `/pending` lists open requests, `/cancel` rejects them all with their timeout answers, `/history [N]` shows the last settled ones.
- 282afee: Add `telegram-ask hook`, a Claude Code `PermissionRequest` and `Notification` hook that sends permission prompts to Telegram.
- 75e967d: Optional API token. `init` generates one for new setups (and asks when upgrading an install without one); the service then answers 401 without it. The CLI, `mcp` and the Node `Client` send it on their own; curl, n8n and container agents set `TELEGRAM_ASK_TOKEN` to the contents of `~/.config/telegram-ask/token`.
- ffa80a1: Notifications keep their 8-hour auto-delete across restarts, and requests left pending by a restart are edited to an expired line when the service comes back. State lives in `state.json` next to the config.

## 0.3.0

### Minor Changes

- `telegram-ask send request` and `telegram-ask send notify` call the HTTP API from a shell, so scripts don't need curl.
- Use telegram-ask as a Node library: `import { Client } from 'telegram-ask'` gives `request()` and `notify()` over the local service. Failures throw `TelegramAskError`, a timeout resolves with `timedOut: true`, and an `AbortSignal` cancels the question.
- OpenAPI spec for the HTTP API. The service serves it at `GET /openapi.yaml`, `telegram-ask openapi [FILE]` prints or writes it, and a copy lives in `docs/openapi.yaml`.

## 0.2.0

### Minor Changes

- Notifications: `POST /notify` sends a message with a dismiss button. Notifications expire after 8 hours.
- `/request` and `/notify` accept an optional project name, shown above the message.
- `telegram-ask mcp` runs an MCP server on stdio with `ask_for_permission` and `notify_user` tools, so agents like Claude Code can ask and notify you.
- `telegram-ask init --provider NAME` (or the `PROVIDER` env var) picks the chat app. `telegram` is the default and the only one for now.
