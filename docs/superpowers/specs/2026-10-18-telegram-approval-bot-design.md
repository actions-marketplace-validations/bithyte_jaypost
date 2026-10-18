# Telegram Approval Bot: Design

Source: `docs/initial-spec.md` plus the brainstorming conversation on 2026-10-18.

## Intent

A general-purpose approval bot. A process on this machine asks a question over a local HTTP API,
the question shows up in the owner's Telegram chat with buttons, and the owner answers from their
phone with one tap. The HTTP call waits for the answer and returns it.

The long-term use is as an approval hook for Claude Code and other AI agents that need explicit
human approval before acting. The point is ease: approving from the phone, from anywhere, without
going back to the terminal.

## Goals (MVP)

- Telegram bot that connects to Telegram and only talks to the owner's account.
- Local-only HTTP API with one endpoint, `POST /request`, that blocks until answered or timed out.
- Multiple pending requests at the same time.
- Onboarding script that sets up the bot token and the owner's Telegram account.
- Installable as a systemd service on this Linux machine.
- Containerizable (a working Dockerfile).
- Test script that sends a sample request and prints the response.

## Non-goals (MVP)

- The Claude Code hook itself. It comes later; the API should be usable by it but no hook script
  is written now.
- Multiple approvers or multiple Telegram users.
- Persistence of pending requests across restarts.
- Authentication on the local API.
- Free-text answers. Answers are always one of the given options.

## Anti-goals

- Anyone other than the owner being able to answer a request. Messages and button taps from any
  other Telegram user or chat must be ignored.
- The API being reachable from outside the machine.

## Stack (owner's decision)

- Node 24 (installed: v24.21.0).
- TypeScript.
- Vite+ (the VoidZero unified toolchain, `vp` CLI) for build, test, lint and format. Not
  installed yet on this machine.

The Telegram library is left to the builder.

## Behavior

### Onboarding

An interactive onboarding script run once before first start. It:

1. Asks for the bot token (from BotFather) and checks it against Telegram.
2. Identifies the owner's Telegram account, e.g. by asking the owner to send `/start` to the bot
   and capturing the chat/user id from that message. (Mechanism is the builder's call, the
   outcome is that the bot is locked to the owner's account.)
3. Asks for the local API port (with a default).
4. Writes the config to a file the service reads.

Re-running onboarding overwrites the config.

### API

Bound to `127.0.0.1` only.

`POST /request`, JSON body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | The question shown in Telegram. Non-empty. |
| `options` | string[] | yes | Button labels. Non-empty. |
| `timeoutOption` | string | yes | Answer returned on timeout. Must be one of `options`. |
| `timeout` | number | no | Seconds. Defaults to and is capped at 300 (5 minutes). |

Validation failures (missing fields, wrong types, empty options, `timeoutOption` not in
`options`) return `400` immediately with an error message; no Telegram message is sent.

On success the request stays open until the owner taps a button or the timeout fires, then
returns `200`:

```json
{ "answer": "Approve", "timedOut": false }
```

On timeout, `answer` is the `timeoutOption` and `timedOut` is `true`.

Multiple requests can be pending at once; each has its own Telegram message and its own timer.

### Telegram message lifecycle

- Each request sends one message to the owner's chat: the `text`, with one inline button per
  option. Options are per message, so no bot reload is needed for different options (this
  answers the open question in the initial spec).
- When the owner taps a button: the request resolves with that option, and the message is edited
  in place to remove the buttons and append a line with the result and time, e.g.
  `✅ Approve, 14:02`.
- On timeout: same edit, e.g. `⏱ Timed out, Decline, 14:05`.
- Tapping a button on a request that's already finished shows a small "expired" popup and changes
  nothing.

The chat thereby becomes a log of past decisions.

### Restarts

Pending requests are held in memory. If the service stops, pending callers get a connection
error. No recovery.

### Test script

Calls `POST /request` with `text: "This is a test"`, `options: ["Approve", "Decline"]`, and prints
the response.

### Deployment

- systemd unit for this machine, with an install step (script or documented commands).
- Dockerfile that runs the bot. Config comes from the same config file (mounted) or environment
  variables; builder's call. The container needs the API reachable from the host only, not
  externally.

## Calls I made (not discussed with the owner)

- `timeoutOption` is required; there's no implicit "Decline" default.
- No auth on the local API, since it's bound to localhost.
- Pending requests are dropped on restart.
- The port is fixed, set during onboarding.
- `timeout` above 300 is clamped to 300; `timeout` that's not a positive number returns 400.
- If the caller disconnects before an answer, the request is dropped and its message is edited to
  a "cancelled" line with buttons removed, so the owner can't approve into the void.
- If sending the Telegram message fails, the API returns a 5xx right away instead of waiting for
  the timeout.
- Docker: inside the container the app binds `0.0.0.0` and is published as
  `-p 127.0.0.1:PORT:PORT`, so it stays host-only. A localhost bind inside the container wouldn't
  be reachable from the host.
- Only one instance (systemd or Docker) runs per bot token, since a second long poller gets a
  409 from Telegram. Docs say so.
- Vite+ is pre-1.0 (0.x releases as of 2026); pin the version current at build time.

## Left to the builder

- Telegram library and whether to use long polling or webhooks (long polling is the obvious fit
  for a local machine with no public endpoint).
- HTTP framework.
- Config file location and format.
- Exact message formatting and timestamp format.
- Project layout.
