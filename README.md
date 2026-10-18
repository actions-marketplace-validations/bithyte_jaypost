# telegram-ask

Small local service that asks you a question on Telegram and hands the answer back to the caller. A script POSTs a question with button options to a local HTTP API; the bot sends it to you with inline buttons, and the request returns when you tap one or the timeout fires.

Single owner, one Telegram user. Needs Node 24+ for `npx` and the systemd target; the container targets bring their own Node.

## Install

```
npx telegram-ask init
```

Create a bot with @BotFather first and have the token ready. `init`:

1. Detects which targets work here (Podman Quadlet, Docker Compose, systemd) and asks where the bot should run. The first usable one in that order is the default. Or pass it: `init quadlet`, `init compose`, `init systemd`. `--provider NAME` picks the chat app; only `telegram` exists for now, and it's the default.
2. Asks for the bot token (input hidden) and checks it with Telegram. Port is 8787; use `--port N` to change it. It refuses a port that's already in use.
3. Installs and starts the service, then waits for pairing.

If it finds an existing install it offers to replace it, reusing the saved token and owner (no re-pairing). If there's no install but a token was kept by `uninstall`, it reuses that (and the owner) too. If `init` fails partway, run it again; the old install record and saved token are kept until the new install succeeds.

## Pairing

The first time (and after `reset-owner`), the bot only answers whoever proves they own it. `init` prints a code like `ABCD-EFGH` and a link. Either send `/start ABCD-EFGH` to your bot, or open `https://t.me/<bot>?start=ABCDEFGH`. Case and the dash don't matter. After 5 wrong codes from one Telegram user that user is blocked until the service restarts.

If you lose the code: `telegram-ask status` prints it again while unpaired.

To move to another Telegram account:

```
telegram-ask reset-owner
```

It asks first, clears the owner, restarts the service and waits for a new pairing.

## Targets

All targets keep their files under `~/.config/telegram-ask/` (or `$XDG_CONFIG_HOME/telegram-ask/`). `install.json` there records which target is installed, its port and version. It's what `status`, `reset-owner` and `uninstall` read.

### Podman Quadlet

Needs Podman 4.4 or newer and a systemd user session. Written:

- `~/.config/telegram-ask/quadlet/` with a `Dockerfile`, `.env` (token, port, owner) and a `.dockerignore` that keeps `.env` out of the image build
- `~/.config/containers/systemd/telegram-ask.container`
- image `localhost/telegram-ask:<version>`, volume `telegram-ask-data` (holds the pairing state)

Runs as a user service named `telegram-ask`. `init` enables linger (`loginctl enable-linger`) if needed so it survives logout; it tells you if that needs a password. Logs:

```
journalctl --user -u telegram-ask -f
```

### Docker Compose

Needs Docker with the compose v2 plugin, and your user in the `docker` group (otherwise `init` reports it can't talk to docker and skips this target). Written:

- `~/.config/telegram-ask/compose/` with `Dockerfile`, `compose.yaml`, `.env` and `.dockerignore`
- a named volume `data` in the `telegram-ask` compose project

Logs:

```
docker compose -f ~/.config/telegram-ask/compose/compose.yaml logs -f
```

This target is untested on real Docker so far.

### systemd (npm)

No container. `init` installs the package globally with npm (`npm i -g`), or into `~/.local/share/telegram-ask/npm` if the global prefix isn't writable. If you ran `init` from an already-installed copy, it uses that. Written:

- `~/.config/telegram-ask/config.json` (token, port, owner)
- `~/.config/systemd/user/telegram-ask.service` with absolute paths to `node`, the CLI and the config file (`TELEGRAM_ASK_CONFIG` is always set in the unit, and `install.json` records the same path)

Logs: `journalctl --user -u telegram-ask -f`. Linger is handled as for Quadlet.

Config is read from `$TELEGRAM_ASK_CONFIG`, else `$XDG_CONFIG_HOME/telegram-ask/config.json`, else `~/.config/telegram-ask/config.json`. The env vars `PROVIDER`, `BOT_TOKEN`, `OWNER_ID`, `PORT` and `HOST` override the file. `PROVIDER` picks the chat app and defaults to `telegram`, which is the only one for now. `HOST` defaults to `127.0.0.1` (the container targets set `0.0.0.0` inside the container and publish only on `127.0.0.1`).

## Commands

```
telegram-ask init [systemd|compose|quadlet] [--port N] [--provider NAME]
telegram-ask status
telegram-ask test
telegram-ask reset-owner
telegram-ask uninstall
telegram-ask start
telegram-ask mcp [--port N]
```

- `status`: target, version, port, whether it's running, and pairing state (with the code and instructions if unpaired). The daemon's `/status` returns `provider` and `displayName` along with `paired` and `bot`, plus `code` and `instructions` while unpaired.
- `test`: sends "This is a test" with Approve/Decline buttons (Decline on timeout) and prints the response.
- `uninstall`: stops and removes the service, then asks whether to also delete the saved credentials and paired owner. Answer no to keep them: `config.json` (systemd) or the target's `.env` and volume stay on disk, and a later `init` finds them and reuses the token and owner without asking. Yes also removes the target's image, volume and files. For systemd the npm package stays; `uninstall` prints the command to remove it, `npm rm -g telegram-ask`, or `npm rm -g --prefix ~/.local/share/telegram-ask/npm telegram-ask` if `init` installed it into that prefix.
- `start`: runs the service in the foreground. The installed services use this.
- `mcp`: runs an MCP server on stdin/stdout so agents can ask and notify you. See [MCP server](#mcp-server).

## One instance per token

Only one instance can run per bot token; two would fight over Telegram's updates. `init` replaces an existing install rather than adding a second. Stop anything you started by hand, including a `docker run` container, before running `init`.

## Upgrading from the old setup

Earlier versions used `npm run onboard` and `deploy/install-service.sh`. `init` recognizes that systemd unit as a legacy install, offers to replace it, and reuses the token and owner from the existing config. Stop any hand-run Docker container using the same token first. The old config file is kept and reused if you pick the systemd target.

## API

`POST /request` on `127.0.0.1:<port>`, JSON body:

| Field           | Type     | Required | Notes                                                                                   |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------------- |
| `text`          | string   | yes      | Question shown in Telegram. Non-empty, max 3900 chars.                                  |
| `options`       | string[] | yes      | Button labels. Non-empty, unique, non-empty strings.                                    |
| `timeoutOption` | string   | yes      | Answer returned on timeout. Must be one of `options`.                                   |
| `timeout`       | number   | no       | Seconds. Default and max 300. Must be positive.                                         |
| `project`       | string   | no       | Shown as `[project]` on the first line. Trimmed, max 100 chars. Counts toward the 3900. |

The request stays open until you tap a button or the timeout fires, then returns `200`:

```json
{ "answer": "Approve", "timedOut": false }
```

On timeout, `answer` is `timeoutOption` and `timedOut` is `true`. Many requests can be pending at once.

```
curl -s -X POST http://127.0.0.1:8787/request \
  -H 'content-type: application/json' \
  -d '{"text":"Deploy?","options":["Approve","Decline"],"timeoutOption":"Decline","timeout":60}'
```

Errors are JSON `{ "error": "..." }`:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 400    | Body isn't valid JSON or fails validation. Nothing is sent to Telegram. |
| 413    | Body over 64 KiB.                                                       |
| 502    | Message couldn't be sent.                                               |
| 500    | Internal error, or the request was cancelled.                           |
| 404    | Path isn't `/request`, `/notify` or `/status`.                          |
| 405    | Method isn't POST.                                                      |

If the caller disconnects early, the request is dropped and the Telegram message is edited to a "cancelled" line. Pending requests live in memory, so a restart drops them (callers see a connection error).

### Notifications

`POST /notify` sends a message that doesn't need an answer, e.g. from n8n when someone joins a game server. JSON body:

| Field     | Type   | Required | Notes                                                                                   |
| --------- | ------ | -------- | --------------------------------------------------------------------------------------- |
| `text`    | string | yes      | Shown in Telegram. Non-empty, max 3900 chars. Plain text.                               |
| `project` | string | no       | Shown as `[project]` on the first line. Trimmed, max 100 chars. Counts toward the 3900. |

It returns `200 { "ok": true }` as soon as Telegram accepts the message. The message has a Dismiss button that deletes it, and it's deleted automatically after 8 hours.

```
curl -s -X POST http://127.0.0.1:8787/notify \
  -H 'content-type: application/json' \
  -d '{"text":"alice joined the Core Keeper server"}'
```

Errors are JSON `{ "error": "..." }`:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 400    | Body isn't valid JSON or fails validation. Nothing is sent to Telegram. |
| 413    | Body over 64 KiB.                                                       |
| 501    | Notifications aren't supported.                                         |
| 502    | Message couldn't be sent.                                               |
| 503    | Not paired yet.                                                         |
| 405    | Method isn't POST.                                                      |
| 500    | Internal error.                                                         |

Known issue: the 8-hour timers live in memory. If the service restarts before a notification's 8 hours are up, that message stays in the chat until you dismiss it (Dismiss still works after a restart).

## MCP server

`telegram-ask mcp [--port N]` is a stdio MCP server with two tools that forward to the API above. `project_name` shows as `[name]` on the first line of the message, so you can tell which agent is asking.

`ask_for_permission` asks a question with buttons and waits for the tap or the timeout:

| Param             | Type     | Required | Notes                                                 |
| ----------------- | -------- | -------- | ----------------------------------------------------- |
| `project_name`    | string   | yes      | Max 100 chars.                                        |
| `text`            | string   | yes      | The question.                                         |
| `options`         | string[] | yes      | Button labels, unique, max 64 chars each.             |
| `timeout_option`  | string   | yes      | Answer returned on timeout. Must be one of `options`. |
| `timeout_seconds` | number   | no       | Default and max 300; longer values are capped to 300. |

It returns the answer as text (with `(timed out, no answer from the user)` appended on timeout) and as structured content `{ "answer": "...", "timed_out": false }`.

`notify_user` sends a message that doesn't need an answer and returns `sent` once Telegram accepts it:

| Param          | Type   | Required | Notes          |
| -------------- | ------ | -------- | -------------- |
| `project_name` | string | yes      | Max 100 chars. |
| `text`         | string | yes      | The message.   |

Register it with Claude Code:

```
claude mcp add telegram-ask -- telegram-ask mcp
```

In a container or anywhere the package isn't installed, use `npx -y telegram-ask mcp` as the command. Other clients take the usual JSON:

```json
{ "mcpServers": { "telegram-ask": { "command": "telegram-ask", "args": ["mcp"] } } }
```

The port comes from `--port`, then `PORT`, then the install's `install.json`, then 8787. If you run `start` by hand on a custom port without an install, pass `--port` or set `PORT`.

The service has to be running. A call made while it's down returns an error to the agent; the MCP server stays up, so the next call works once the service is back.

`project` needs a service at least as new as this release. An older service sends the message without the project line, and `notify_user` reports that the service is too old. Re-run `init` to upgrade.

## Security

There's no auth. The API is meant for localhost only; don't expose it. The container targets publish the port on `127.0.0.1` only; keep it that way.
