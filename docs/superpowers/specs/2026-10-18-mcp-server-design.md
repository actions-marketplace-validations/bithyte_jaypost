# MCP server: design

Source: brainstorming conversation on 2026-10-18. Builds on
`2026-10-18-telegram-approval-bot-design.md`, `2026-10-18-provider-seam-design.md` and
`2026-10-18-notifications-design.md`; what those describe stays as it is unless this doc says
otherwise.

## Intent

The owner runs coding agents and wants them to reach their phone without writing curl calls. Their
words: "if I want my agent to notify me when done or when it needs help, just to call the
notify_user tool available". So the CLI gets a stdio MCP server, started with `telegram-ask mcp`,
that exposes two tools:

1. `ask_for_permission`: ask the owner a question with buttons and wait for the answer.
2. `notify_user`: tell the owner something and return right away.

The MCP server is a thin client. It sends each call over the existing local HTTP API to the
running service ("it sends the request via API to the service, ofc"). Nothing about Telegram
lives in it.

## Order

Built after the provider seam refactor (owner's decision) and after `/notify` from the
notifications doc, which `notify_user` depends on. Both are prerequisites, not part of this plan:
plan against the code as it is once they've landed (provider module, per-provider text limit, fake
providers in tests). If they haven't landed when this starts, stop and say so rather than building
on guessed interfaces. At the time of writing `/notify` is in progress and the seam isn't started.

## Goals

- `telegram-ask mcp` runs an MCP server over stdin/stdout with exactly the two tools above.
- Each tool call becomes one HTTP call to the service on `127.0.0.1`: `ask_for_permission` →
  `POST /request`, `notify_user` → `POST /notify`.
- Both tools take a required `project_name` so the owner can tell which agent a message came from
  when several run at once (owner's decision).
- The agent picks the button labels, and on timeout gets the timeout option back (owner's
  decision).
- Errors come back to the agent as tool errors it can read, never as a crashed MCP server.

## Non-goals

- Waiting longer than today's 300 s cap. The owner said 5 minutes is enough "for now".
- Free-text answers from the owner. Buttons only, as today.
- An HTTP/SSE MCP transport, MCP resources or prompts. stdio and two tools only.
- Auth. The API stays localhost-only and unauthenticated, as today.
- Talking to Telegram directly from the MCP process.
- Telling the agent whether a notification was dismissed.

## Anti-goals

- Anything other than JSON-RPC on stdout. One stray `console.log` breaks the client; logs and
  diagnostics go to stderr.
- An agent left hanging past the request's own timeout because the MCP side waits on something
  else.
- A cancelled tool call leaving a live question with buttons in Telegram. Cancel must reach the
  service so the message flips to "cancelled" as it does for a dropped HTTP client.
- Secrets in the MCP process. It doesn't need and must not read the bot token.

## The tools

Parameter names are snake_case to match `project_name` (my call).

### `ask_for_permission`

| Param            | Type     | Required | Notes                                                   |
| ---------------- | -------- | -------- | ------------------------------------------------------- |
| `project_name`   | string   | yes      | Shown with the question.                                |
| `text`           | string   | yes      | The question.                                           |
| `options`        | string[] | yes      | Button labels, chosen by the agent.                     |
| `timeout_option` | string   | yes      | Returned on timeout. Must be one of `options`.          |
| `timeout_seconds`| number   | no       | Default and max 300, as `/request`.                     |

Maps to `POST /request` with `text`, `options`, `timeoutOption`, `timeout` and the new `project`
field (below). The tool's input schema mirrors the API limits so the client rejects obvious misuse
early, but the service stays the authority: whatever it returns as 400 goes back to the agent as
the error text.

Result: text content with the answer, plus structured content `{ answer, timed_out }` (my call).
Text form: `Approve`, or `Decline (timed out, no answer from the user)` on timeout, so an agent
that only reads text still knows nobody actually chose it.

### `notify_user`

| Param          | Type   | Required | Notes                    |
| -------------- | ------ | -------- | ------------------------ |
| `project_name` | string | yes      | Shown with the message.  |
| `text`         | string | yes      | The message.             |

Maps to `POST /notify` with `text` and `project`. Returns once the service answers `200`; the
result text is a short confirmation like `sent`. Dismiss button and 8-hour auto-delete come from
`/notify` as specified in the notifications doc; the MCP side does nothing extra.

### Tool descriptions

The descriptions are what tells an agent when to call each tool, so they matter. Rough intent
(wording left to the builder):

- `notify_user`: tell the user something they should know but don't need to answer, e.g. a task
  finished, or the agent is stuck and needs help. Doesn't wait for a reply.
- `ask_for_permission`: ask the user to choose before doing something, with short button labels.
  Blocks until they answer or the timeout passes; on timeout you get `timeout_option`, so make that
  the safe choice.

## API change: `project`

Both `/request` and `/notify` gain an optional `project` string. Optional on the API so curl and
n8n callers don't break; required only on the MCP tools.

- Trimmed. Non-empty after trim if present. Max 100 characters (my call).
- The core formats it, not the provider and not the MCP client, so every provider gets it. My call
  on the format: the project name on its own first line in square brackets, then a blank line, then
  the text:

  ```
  [telegram-ask]

  Tests pass. Merge to main?
  ```

- The provider's text limit (3900 for Telegram) applies to the combined message. Error when over:
  `text must be at most <limit> characters` stays the message, with the limit reduced by the
  prefix length (my call; simpler than a new error). Builder may pick clearer wording if the
  numbers would confuse.
- For `/request`, the final edited message (answered, timed out, cancelled) keeps the project line.
- Missing `project` means today's output exactly.
- README API tables get the new field.

## The command

`telegram-ask mcp [--port N]`

- Port: `--port`, else the `PORT` env var, else the port in `install.json`, else 8787. Unlike
  `test`/`resolvePort()`, it never reads `config.json`, since that file holds the bot token (my
  call). A hand-run `start` on a custom port with no install needs `--port` or `PORT`; say so in
  the README. Host is always `127.0.0.1`.
- Doesn't check the service at startup. A service that's down or restarting should only fail the
  calls made while it's down, not stop the agent's MCP server from loading (my call).
- Exits when stdin closes, as stdio MCP servers do.
- Registering it, documented in the README:

  ```
  claude mcp add telegram-ask -- telegram-ask mcp
  ```

  and the `npx -y telegram-ask mcp` form for people who installed with a container target and
  don't have the package globally. Other MCP clients get a generic JSON snippet.

## Errors

Every failure is a tool result with `isError: true` and one line of text the agent can act on (my
call on wording, builder may polish):

| Situation                     | Text                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| Can't connect                 | `telegram-ask service not reachable on 127.0.0.1:<port> (run telegram-ask status)` |
| 400                           | the service's `error` string                                               |
| 501 (`/notify`)               | `notifications not supported by this provider`                             |
| 503                           | `telegram-ask isn't paired yet (run telegram-ask status)`                  |
| 502                           | `couldn't send the message to the user`                                    |
| 404 (`/notify`)               | `telegram-ask service is too old for notifications (run telegram-ask init to upgrade)` |
| other non-200                 | `telegram-ask service error <status>: <error>`                             |

No retries (my call): a retried `/request` would send a second question.

Version skew: with `npx -y telegram-ask mcp` the MCP side is the latest release, while a container
install is pinned to the version `init` installed. An older service ignores the unknown `project`
field, so the message goes out without the project line and no error. My call: no version check,
just the 404 row above and a README note that `project` needs a service at least as new as this
release (re-run `init` to upgrade).

## Cancellation and timeouts

- When the MCP client cancels an `ask_for_permission` call, the MCP server aborts its `fetch`. The
  service sees the connection close and cancels the request, which edits the Telegram message to
  the "cancelled" line (existing behavior).
- Same when the MCP process is killed or stdin closes mid-call: in-flight fetches are aborted
  before exit.
- The fetch itself gets a safety timeout a bit over `timeout_seconds` (my call: +30 s), so a wedged
  service can't hold the agent forever.
- Some MCP clients cap tool-call duration. The builder should check Claude Code's default and, if
  it's under 300 s, say so in the README with the setting that raises it. Not sending progress
  notifications as a workaround unless the check shows it's needed (my call).

## How it gets made

- Official TypeScript MCP SDK (`@modelcontextprotocol/sdk`), stdio transport (my call; the repo
  already takes runtime deps like fastify and zod, so hand-rolling JSON-RPC buys nothing). Pick a
  version that works with the repo's zod 4.
- Subcommand added in `src/cli.ts` with commander like the others; logic in its own module (e.g.
  `src/mcp/`). Follow the repo's existing style and layout.
- The MCP module doesn't import provider, Telegram, or config-secret code. It reads `install.json`
  for the port and talks HTTP.

## Tests

- Spawn the real CLI (`telegram-ask mcp --port <p>`) with the SDK's stdio client against a local
  HTTP server on port 0. Either the real API server with a fake provider (from the seam work) or a
  small stub server; builder's choice, the real one is preferred.
- `tools/list` returns exactly the two tools with required `project_name`.
- `ask_for_permission`: body sent to `/request` has the mapped fields and `project`; answered and
  timed-out results; 400 text passed through.
- `notify_user`: body sent to `/notify`; 200, 501, 503 results.
- Service down: tool error with the not-reachable text, MCP server keeps running and answers the
  next call.
- Cancel: client cancels an ask, the service sees the request cancelled.
- Nothing but JSON-RPC on stdout during a run.
- API: `project` validation (empty, whitespace, too long, combined length over the limit), format
  of the first line, absent `project` leaves output unchanged, final edited message keeps it.

## Left to the builder

- Module layout, type and constant names.
- Exact tool description wording, within the intent above.
- Whether input-schema limits are duplicated from the service's constants or imported.
- Stub vs real server in tests (real preferred).

## My calls (not discussed with the owner)

- `notify_user` uses the `/notify` endpoint from the notifications doc (Dismiss button, 8-hour
  auto-delete) instead of a new plain endpoint.
- snake_case params: `timeout_option`, `timeout_seconds`.
- `project` optional on the API, required on the tools; trimmed, max 100 chars.
- Format: `[project]`, blank line, text; the limit covers the combined message.
- Ask result: text plus structured `{ answer, timed_out }`; timeout spelled out in the text.
- No service check at startup; no retries; fetch safety timeout of `timeout_seconds + 30 s`.
- Port: `--port`, `PORT`, `install.json`, 8787; never reads `config.json`.
- No version check against the service; 404 on `/notify` reads as "too old", missing project
  line on an old service is documented, not detected.
- Seam and `/notify` are prerequisites; don't build on guessed interfaces.
- Official MCP SDK over a hand-rolled server.
