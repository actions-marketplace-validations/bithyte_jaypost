# telegram-approval-bot

Small local service that asks you a question on Telegram and hands the answer back to the caller. A script POSTs a question with button options to a local HTTP API; the bot sends it to you with inline buttons, and the request returns when you tap one or the timeout fires.

Needs Node 24+. Single owner, one Telegram user.

## Setup

```
npm install
npm run onboard
```

Onboarding asks for a bot token (from @BotFather), checks it, waits for you to message the bot so it can learn your user id, asks for a port (default 8787), and writes the config. Re-running it overwrites the config.

Config is a JSON file at `$APPROVAL_BOT_CONFIG`, else `$XDG_CONFIG_HOME/telegram-approval-bot/config.json`, else `~/.config/telegram-approval-bot/config.json`. The env vars `BOT_TOKEN`, `OWNER_ID`, `PORT` and `HOST` override the file. `HOST` defaults to `127.0.0.1`.

## Run

```
npm start
npm run test-request
```

`test-request` sends "This is a test" with Approve/Decline buttons (Decline on timeout) and prints the response.

## API

`POST /request` on `127.0.0.1:<port>`, JSON body:

| Field           | Type     | Required | Notes                                                  |
| --------------- | -------- | -------- | ------------------------------------------------------ |
| `text`          | string   | yes      | Question shown in Telegram. Non-empty, max 3900 chars. |
| `options`       | string[] | yes      | Button labels. Non-empty, unique, non-empty strings.   |
| `timeoutOption` | string   | yes      | Answer returned on timeout. Must be one of `options`.  |
| `timeout`       | number   | no       | Seconds. Default and max 300. Must be positive.        |

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
| 502    | Telegram message couldn't be sent.                                      |
| 500    | Internal error, or the request was cancelled.                           |
| 404    | Path isn't `/request`.                                                  |
| 405    | Method isn't POST.                                                      |

If the caller disconnects early, the request is dropped and the Telegram message is edited to a "cancelled" line. Pending requests live in memory, so a restart drops them (callers see a connection error).

There's no auth. The API is meant for localhost only; don't expose it.

## systemd (user service)

```
npm run onboard
deploy/install-service.sh
```

The script refuses to run without a config file. It fills in the repo path and the `node` from your PATH (must be 24+), writes `~/.config/systemd/user/telegram-approval-bot.service`, then runs `daemon-reload` and `enable --now`. If `APPROVAL_BOT_CONFIG` is set when you run it, that path is baked into the unit.

Check it with `systemctl --user status telegram-approval-bot` or `journalctl --user -u telegram-approval-bot -f`.

To keep it running when you're logged out, run this yourself (the script only prints it):

```
loginctl enable-linger $USER
```

## Docker

```
docker build -t telegram-approval-bot .
docker run -d --env-file .env -p 127.0.0.1:8787:8787 telegram-approval-bot
```

`.env` needs `BOT_TOKEN` and `OWNER_ID` (and `PORT` if not 8787; then change `EXPOSE`/`-p` to match). Instead of env vars you can mount a config file and point at it:

```
docker run -d -v /path/to/config.json:/config.json:ro -e APPROVAL_BOT_CONFIG=/config.json \
  -p 127.0.0.1:8787:8787 telegram-approval-bot
```

The container binds `0.0.0.0`, so keep the `127.0.0.1:` in `-p`, otherwise the unauthenticated API is reachable from the network. The config file must be readable by the `node` user (uid 1000).

## One instance per token

Only one instance (systemd or Docker) can run per bot token; two would fight over Telegram's updates. Stop one before starting the other.
