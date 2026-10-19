# telegram-ask

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
