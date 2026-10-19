# Long timeouts: design

Source: a brainstorming request on 2026-10-19, run without the owner in the loop. The request
was: "Timeouts beyond 300s for telegram-ask. Today `/request` and `ask_for_permission` cap the
timeout at 300s. Design a way for things like overnight jobs to wait hours: for example
long-poll, or an async `requestId` you poll with `GET /request/:id`, plus how the MCP tool
exposes it." Everything else here comes from the code at `99ae1b9` (0.3.0) and the git history.
Every choice the owner didn't make is marked "Decision (made without user input)" and collected
again at the end.

## Intent

An overnight job, or an agent running one, wants to ask the owner something and get the answer
hours later, after they wake up. Today the most it can wait is 5 minutes, then it gets
`timeoutOption` back. So either the job asks at the end and nobody's there, or it gives up.

Two kinds of caller need this, and they want different shapes:

1. Callers that just want to block until the answer: a shell script doing
   `answer=$(telegram-ask send request ...)`, a Node script using `Client.request`, an agent that
   has nothing to do until the owner decides. For them the fix is a bigger timeout on the call
   they already make.
2. Callers that can't or shouldn't hold one call open for hours: n8n flows and other HTTP tools
   with their own request timeouts, MCP clients that cap a tool call at 60 s, a job that wants to
   ask early ("deploy when the build finishes?") and keep working, a script that restarts. For
   them the fix is an id they get back right away and check later.

## Why the cap is 300 s today

- It was a product rule, not a technical one. `docs/initial-spec.md` (removed in `119ed49`) said
  "Request has a global max timeout (5 minutes)", and the MCP design listed waiting longer as a
  non-goal: "The owner said 5 minutes is enough 'for now'."
- `6058548` fixed a technical limit that sat on top of it: global `fetch` (undici) has a fixed
  300 s headers timeout, so an ask that used the full 300 s was cut off before the service
  answered, and the service then cancelled the question. `postApi` (now `src/client/http.ts`)
  uses `node:http` instead, where the caller's `AbortSignal` timeout is the only cap. That fix is
  what makes longer blocking calls possible from our own clients. Third-party callers that use
  `fetch` still hit undici's 300 s limit, which is one reason the polling path below keeps every
  single HTTP call well under 300 s.
- `996fcb4` checked Claude Code's limits for 330 s. They matter more now (see "MCP clients"
  below).

## Goals

- A question can wait up to 24 hours for an answer.
- `POST /request` keeps working exactly as today for callers that don't send `timeout` or send
  300 or less. Callers that send more get what they asked for, up to the new cap.
- A non-blocking way to ask: create the question, get an id back at once, check it with
  `GET /request/:id` (optionally long-polling), cancel it with `DELETE /request/:id`.
- MCP agents can wait hours in one tool call without burning a tool call per minute, and agents
  whose client can't hold a call that long can ask in the background and come back for the
  answer.
- A question nobody will read any more doesn't sit in Telegram with live buttons for hours.

## Non-goals

- Pending questions surviving a service restart. They live in memory today and still will. With
  hours-long waits a restart is more likely to land mid-question, so the failure has to be
  visible (see anti-goals), but persisting them is a separate project.
- `telegram-ask send` subcommands for the background flow (`--background`, `send wait ID`,
  `send cancel ID`) and matching `Client` methods. The CLI and `Client` only get the higher cap.
  Decision (made without user input): shell scripts are served by a blocking
  `send request --timeout 28800`, and the background flow can follow once the HTTP side exists.
- Calling a webhook when the owner answers. Long-poll covers n8n well enough for now.
- Reminding or re-pinging the owner about an old question, or showing the deadline in the
  message.
- MCP Tasks (the experimental task-augmented `tools/call` in the 2025-11-25 MCP spec, which the
  SDK at 1.32.1 has code for). It's the protocol-level version of the background flow, but it's
  experimental and I don't know which clients support it. Decision (made without user input):
  plain tools now; revisit Tasks when Claude Code supports them.
- Changes to `/notify`.

## Anti-goals

- A caller getting `timeoutOption` back when the owner never had the chance to answer because
  the service restarted. A lost question must be an error the caller can see, never a fake
  timeout.
- A blocking call cut off by a transport timeout before the question's own timeout fires, which
  is the bug `6058548` fixed. Nothing between the caller and the service may impose a limit
  shorter than the question's timeout plus the grace period.
- An agent spending hundreds of tool calls polling through an 8 hour wait.
- Live buttons in Telegram for a question whose asker is gone. For blocking calls the connection
  already acts as the lease (close it and the question is cancelled); the background flow needs
  its own answer to this.
- Breaking existing `/request` callers that omit `timeout` or send 300 or less, or changing the
  shape of its `200` response. (Callers sending more than 300 change behavior on purpose; see
  "The cap".)

## The cap

- `MAX_TIMEOUT_SECONDS` goes from 300 to 86 400 (24 hours). Decision (made without user input):
  24 h covers overnight with room to spare and keeps one forgotten question from living for
  days. It's far below `setTimeout`'s limit of about 24.8 days, so a single timer still works.
- The default stays 300 s. It moves to a new `DEFAULT_TIMEOUT_SECONDS = 300` next to the cap in
  `src/approval/constants.ts`; today one constant is both.
- Values above the cap are still clamped, not rejected, as today. Decision (made without user
  input): keeps the current contract, and `400` for 25 hours would break callers for no gain.
- The same cap and default apply to `POST /request`, `POST /request/async`, the `ask_for_permission`
  tool, `Client.request` and `telegram-ask send request --timeout`.
- `toFetchTimeoutMs` becomes `Math.min(timeout ?? DEFAULT, MAX) * 1000 + FETCH_GRACE_MS`.
- Behavior change to call out in the README and changelog: a caller sending `timeout: 900`
  today silently gets 300 s, and after this gets 900 s.
- That change breaks one kind of existing caller: one using Node's global `fetch` (or anything
  else on undici's defaults) with `timeout` over 300. Today it's clamped and works; after this,
  undici's 300 s headers timeout cuts the call, the closed connection cancels the question, and
  the caller gets a connection error instead of `timeoutOption`. Decision (made without user
  input): accept it and document it rather than gate the higher cap behind an opt-in. Those
  callers asked for more than 300 s and were silently not getting it; an opt-in flag would be
  permanent API surface for a migration problem. The README says: with `fetch`, keep `timeout`
  at 290 or less, raise undici's `headersTimeout` with a custom dispatcher, or use
  `POST /request/async`. curl, `node:http`, and our own CLI, `Client` and MCP server aren't
  affected.

## Blocking `POST /request`

Unchanged apart from the cap. The HTTP call stays open until the tap or the timeout, and closing
it cancels the question.

Holding one HTTP connection for hours needs checking end to end:

- Fastify's `connectionTimeout` and `requestTimeout` default to 0 and Node's `requestTimeout`
  only covers receiving the request, so I believe nothing on the server cuts a held response
  today. The builder should set `requestTimeout: 0` and `connectionTimeout: 0` explicitly in
  `createApiServer` with a comment, so a Fastify default change can't reintroduce a cap, and
  should confirm Node's `server.timeout` is 0 in the version we run.
- The container targets publish the port through Podman's or Docker's port forwarding. I don't
  know if any of them drop a TCP connection that's idle for hours. Decision (made without user
  input): `postApi` turns on TCP keepalive on its socket (`setKeepAlive(true, 60_000)`), which is
  cheap insurance. Someone should hold a real 1 hour request through the Quadlet target once
  before release; I haven't.

## Background questions (HTTP)

### Create: `POST /request/async`

Same body and validation as `POST /request` (`text`, `options`, `timeoutOption`, `timeout`,
`project`), same cap and default. It sends the Telegram message, then answers right away:

```
202 Accepted
Location: /request/3f0c...
{ "id": "3f0c...", "state": "pending", "expiresAt": "2026-10-20T06:00:00.000Z" }
```

- It answers only after the message is sent, so `502` (send failed) still reaches the caller.
  Other errors match `/request`: `400`, `413`, `500`, `503`.
- `expiresAt` is when the timeout fires, in UTC ISO 8601, computed from the service's clock after
  clamping. It's how a caller finds out the cap clamped its timeout.
- The question doesn't depend on this HTTP connection. Closing it does nothing.
- `id` is the id the service already generates (`crypto.randomUUID()`) and puts in the button
  callback data. Decision (made without user input): reuse it rather than mint a second id. It
  can't be used to answer, since taps are checked against the owner's Telegram id, and the API
  is loopback-only with no auth anyway.

Decision (made without user input): a separate path instead of a flag on `POST /request` like
`"wait": false`. An older service strips unknown fields (zod objects aren't strict), so a flag
would make an old service quietly block for up to 300 s on a call the client expected to return
at once. A new path gets a `404` from an old service, and the client can say "too old" the way it
already does for `/notify`. A separate path also keeps one response shape per operation in the
OpenAPI document. Fastify matches the static `/request/async` before the parametric
`/request/:id`, and ids are UUIDs, so they can't collide.

### Read: `GET /request/:id`

Returns the question's state at once:

```
{ "id": "3f0c...", "state": "pending", "expiresAt": "2026-10-20T06:00:00.000Z" }
{ "id": "3f0c...", "state": "done", "answer": "Approve", "timedOut": false }
{ "id": "3f0c...", "state": "cancelled" }
```

- `done` carries the same `answer` and `timedOut` as the blocking `200`, so `isOutcome` reads it
  as is.
- Decision (made without user input): the field is `state`, not `status`, so it can't be
  mistaken for the HTTP status, and `done` covers both a tap and a timeout because the caller
  handles them the same way, with `timedOut` telling them apart, as `/request` already does.

Long-poll: `GET /request/:id?wait=<seconds>` holds the response until the question settles or
`wait` seconds pass, then answers as above (`pending` if time ran out).

- `wait` defaults to 0 (answer at once). Above 120 it's clamped to 120. Negative, non-numeric or
  empty values get `400` with `wait must be a non-negative number`. Decision (made without user
  input): 120 s keeps every HTTP call well under undici's 300 s headers timeout and the 60 s to
  5 min limits common in HTTP tools, while an 8 hour wait still only takes about 240 calls.
- Closing a long-poll early drops the poll. It never cancels the question.
- Any number of pollers can wait on one id at once.

`404 { "error": "unknown request" }` when the service doesn't know the id: it never existed, its
result expired (below), or the service restarted. Clients report this as an error, never as a
timeout (anti-goals).

### Cancel: `DELETE /request/:id`

- Pending: cancels it (the Telegram message is edited to the "cancelled" line, as when a blocking
  caller disconnects) and returns `200 { "id": "...", "state": "cancelled" }`.
- Already settled: returns `200` with its current state and changes nothing. Decision (made
  without user input): idempotent so a client can cancel on shutdown without first checking.
- Unknown: `404 { "error": "unknown request" }`.

### How long results are kept

A settled background question's state stays readable for 24 hours after it settles, then the id
answers `404`. Decision (made without user input): long enough that an agent can ask, spend
hours on a build, and still collect an answer the owner gave early. Results are tiny, so memory
isn't a concern at this scale. Blocking requests don't keep a result; their id is never returned
to the caller anyway.

There's no limit on how many questions can be pending, same as today.

### Service shutdown

Today a blocking question is cancelled when `server.close()` drops its socket, so its message
gets the "Cancelled" edit (racing the bot stopping). A background question has no socket, so on
a restart its buttons would stay live and a tap would just say "Expired", which is the anti-goal
about live buttons. Decision (made without user input): on `stop()` the service first cancels
every pending question, background and blocking, and waits for the final edits (bounded, about
3 s, inside the existing 5 s exit window), and only then closes the server and stops the
runtime. The edit reuses the existing "🚫 Cancelled, HH:MM" line rather than a new settlement
kind; the owner learns the question is dead, which is what matters, and a new kind would ripple
through `Settlement`, the formatter and the provider. A poller asking the restarted service
gets `404`, as above. This adds something like `ApprovalService.cancelAll()` and a daemon test.

### Errors and 405s

- `/request/async` allows `POST`; `/request/:id` allows `GET` and `DELETE`. Other methods get
  `405` with the right `Allow` header, like the existing routes. The not-found handler's path
  checks need extending for these.
- `503 not paired` applies to `POST /request/async`. Decision (made without user input): `GET` and
  `DELETE` on an id don't check pairing; an id can only exist if pairing happened, and
  `reset-owner` restarts the service, which drops everything.

## MCP clients

What the MCP side has to survive, from Claude Code's env-vars docs
(https://code.claude.com/docs/en/env-vars, read 2026-10-19):

- `MCP_TOOL_TIMEOUT` defaults to 100 000 000 ms, about 28 hours. Above 24 h plus grace, fine.
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: "When a stdio ... MCP server sends no response and no
  progress notification for this long, the tool call aborts". The stdio default is 30 minutes
  (since v2.1.203; stdio was exempt before). So a blocking ask that stays silent for 30 minutes
  gets aborted, which cancels the question. `996fcb4` saw the 30 minutes but it didn't matter at
  300 s. It matters now.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (default 2 minutes) moves a long-running MCP tool call to
  a background task in Claude Code. That's the client's business; it doesn't change what the
  server does.
- Other clients built on the TypeScript SDK default to a 60 s request timeout, which they only
  extend on progress if they opt into `resetTimeoutOnProgress`.

## MCP tools

Three tools change or appear. `notify_user` doesn't change.

### `ask_for_permission` (changed)

- `timeout_seconds`: default 300, max 86 400, longer values capped. The description and README
  say so.
- Still a blocking `POST /request`, so cancelling the tool call or the MCP server exiting still
  cancels the question through the closed connection. Decision (made without user input): keep
  the connection as the lease rather than switch to the background flow internally, because a
  killed MCP process then can't leave a live question behind.
- While waiting it sends `notifications/progress` every 60 s when the call carried
  `_meta.progressToken`: `progress` is elapsed seconds, `total` is the timeout in seconds,
  `message` something like `waiting for the user`. This keeps Claude Code's idle timer and SDK
  clients with `resetTimeoutOnProgress` from aborting. Decision (made without user input):
  60 s is far inside the 30 minute idle window and still cheap.
- If the call has no progress token, nothing is sent; the MCP spec only allows progress against
  a token the client provided. Open point for the builder: check whether Claude Code sends a
  progress token on `tools/call`. If it doesn't, blocking asks over 30 minutes will be aborted by
  its idle timer, and the README has to say so and point to the per-server `timeout` field in
  `.mcp.json` (which raises the idle window) or to `ask_for_permission_in_background`.

### Old services and fake timeouts

The README has agents run `npx -y telegram-ask mcp` (latest) while the service is a pinned
install, so a new client talking to an old service will be common. An old service clamps
`timeout_seconds: 28800` to 300 and answers `timedOut: true` after 5 minutes, which is the fake
timeout the anti-goals forbid. `/status` has no version field, so the client can't tell up
front.

Decision (made without user input): detect it after the fact in the shared client code, so the
MCP server, the CLI and `Client` all get it. When the caller asked for more than 300 s and the
answer comes back `timedOut: true` more than `FETCH_GRACE_MS` before the requested timeout
clamped to the new cap, so a request for 30 hours that times out at 24 isn't flagged
(measured with `performance.now()`, injectable for tests), the call fails with
`telegram-ask service is too old for timeouts over 300 s (run telegram-ask init to upgrade)`
instead of returning `timeoutOption`. The question is already settled as timed out in Telegram
by then; the point is that the caller doesn't mistake it for the owner's silence. No
`/status` version field and no extra round trip per call. I don't love that it only fires after
the 5 minutes are gone, but it's the cheapest check that's never wrong for a new service, which
only times out at the requested time.

### `ask_for_permission_in_background` (new)

Same inputs as `ask_for_permission`. Calls `POST /request/async` and returns at once.

- Text result: something like
  `Asked. Call wait_for_answer with request_id 3f0c... when you need the answer (expires 2026-10-20T06:00:00.000Z).`
- Structured content and output schema: `{ request_id, expires_at }`.
- Description, intent only (wording left to the builder): use it when you have other work to do
  before you need the answer, or when a long blocking call isn't possible; otherwise use
  `ask_for_permission`. On timeout the answer is `timeout_option`, so make it the safe choice.
- An older service answers `404`, and the tool returns the error
  `telegram-ask service is too old for background questions (run telegram-ask init to upgrade)`.

### `wait_for_answer` (new)

Inputs: `request_id` (string, required), `wait_seconds` (number, optional, at least 0, max
86 400, capped like `timeout_seconds`). Without `wait_seconds` it waits until the question
settles; `0` checks once.

- It loops `GET /request/:id?wait=<min(remaining, 120)>` until the question settles or
  `wait_seconds` runs out, sending progress the same way as `ask_for_permission`.
- Results, as text plus structured content `{ state, answer?, timed_out? }`:
  - `done`: the same text as `ask_for_permission` (`Approve`, or
    `Decline (timed out, no answer from the user)`), structured
    `{ state: "done", answer, timed_out }`.
  - `pending` (only when `wait_seconds` ran out first): text `still waiting for the user`,
    structured `{ state: "pending" }`.
  - `cancelled`: text `the question was cancelled`, structured `{ state: "cancelled" }`. Not a
    tool error.
- `404`: tool error,
  `telegram-ask doesn't know request <id> (the service restarted, or the answer expired after 24 h)`.
- Cancelling a `wait_for_answer` call only stops the polling. The question stays open. Decision
  (made without user input): the point of a background question is that it outlives the call
  that waits for it.
- Decision (made without user input): waiting until settled is the default, not checking once,
  because the common case is an agent that has reached the point where it needs the answer. One
  call then covers the whole wait, which is the anti-goal about polling agents.

### The lease for background questions

The MCP server remembers the ids it created. When stdin ends it sends `DELETE /request/:id` for
each one it hasn't seen settle, in parallel, with a short overall timeout (about 2 s), before it
closes. Best effort: if the process is killed outright, the questions stay until their timeout.
Decision (made without user input): a background question belongs to the agent session that
asked it, and nobody reads its answer once that session is gone. No separate cancel tool;
agents rarely need one, and `notify_user` can tell the owner to ignore a question.

## Code shape

Follow the repo's existing conventions where they differ from the global TypeScript rules
(exported functions next to classes, `#private` fields, positional constructors with defaults,
single quotes, vite-plus tests with `expect`). Names below are suggestions.

- `src/approval/`
  - `constants.ts`: `DEFAULT_TIMEOUT_SECONDS = 300`, `MAX_TIMEOUT_SECONDS = 86_400`,
    `MAX_WAIT_SECONDS = 120`, `RESULT_TTL_MS = 24 * 60 * 60 * 1000`.
  - `parser.ts`: default and clamp use the two constants. A small parser for the `wait` query
    value that returns data, never throws.
  - `types.ts`: a `RequestState` union on `kind` internally (`pending` with `expiresAt`, `done`
    with the `Outcome`, `cancelled`), mapped to the HTTP `state` field in the server.
  - `service.ts`: `ApprovalService` gains `start(request)` (send, register, return id and
    `expiresAt` without waiting), `get(id)`, `waitFor(id, waitMs, signal)` (resolves with the
    state when it settles or `waitMs` passes; an aborted signal only stops the wait) and
    `cancel(id)`. `request()` keeps its contract and can share the sending and registering with
    `start`. Settled background results go in a map that forgets each one after
    `RESULT_TTL_MS`; the TTL is injectable so tests don't wait 24 h, and timers stay fakeable
    with `vi.useFakeTimers()` like the existing service tests.
- `src/server/server.ts`: the three routes, the 202 and `Location` header, explicit
  `requestTimeout: 0` and `connectionTimeout: 0`, the 405 handling. `GET` with `wait` aborts its
  wait when the client disconnects.
- `src/daemon/service.ts`: `stop()` cancels and finalizes pending questions before closing the
  server and stopping the runtime (see "Service shutdown").
- `src/server/openapi.ts`: the new paths, the `id` path parameter, the `wait` query parameter,
  `PendingRequest` and `RequestState` schemas, and the cap in the `timeout` description (it reads
  `MAX_TIMEOUT_SECONDS` already; it needs `DEFAULT_TIMEOUT_SECONDS` too). Regenerate
  `docs/openapi.yaml` with `npm run openapi`.
- `src/client/http.ts`: `postApi` grows into a call that takes the method (`GET`, `POST`,
  `DELETE`), with keepalive on the socket. `ApiPath` widens to the new paths.
  `describeStatus` maps `404` on `/request/async` to the too-old message and `404` on
  `/request/:id` to the unknown-request message. A type guard for the state bodies.
- `src/mcp/server.ts`: the two new tools, progress notifications, the id set and the shutdown
  cancel in `runMcp`.
- `src/cli.ts`: the `--timeout` help text.
- `README.md`: the new cap and default everywhere 300 appears, the three endpoints, the two MCP
  tools, the idle-timeout note, a version-skew note (an old service clamps to 300 s and answers
  `404` to the new paths), and that a restart loses background questions (`404`) just as it
  drops blocking ones.

## Tests

- Parser: default 300, 900 kept, 86 400 kept, 100 000 clamped to 86 400, `wait` parsing.
- Service, with fake timers: `start` sends and returns id and `expiresAt` without waiting; a tap
  settles it and `get` sees `done`; timeout gives `done` with `timedOut`; `waitFor` resolves on
  settle and on `waitMs`; an aborted wait leaves the question pending; `cancel` on pending,
  settled and unknown ids; results forgotten after the TTL; `request()` behavior unchanged.
- Server, real Fastify with a fake messenger (as in `test/mcp/server.test.ts`): `202` body and
  `Location`; `GET` immediate and long-polled; closing a long-poll doesn't cancel; `DELETE`
  cases; `404 unknown request`; `400` for bad `wait`; `405` with `Allow`; `502` on send failure
  for `/request/async`.
- Client transport: `404` mapping for both paths; keepalive set; a stub service that answers
  `timedOut: true` early for a requested timeout over 300 gives the too-old error, and one that
  answers at the requested time doesn't (injected clock).
- Daemon: `stop()` with a pending background question finalizes it as cancelled before the
  runtime stops.
- MCP, spawning the CLI as today: `tools/list` has four tools; `ask_for_permission` with a
  progress token receives progress notifications (shorten the interval through a seam so the
  test doesn't wait 60 s); the background tool returns an id; `wait_for_answer` returns `done`,
  `pending` with `wait_seconds: 0`, `cancelled`, and the unknown-id error; closing stdin cancels
  unsettled background questions; a cancelled `wait_for_answer` leaves the question open.
- OpenAPI: committed `docs/openapi.yaml` matches; the new paths exist.
- Not automated: a real multi-hour hold through each install target, and whether Claude Code
  sends a progress token. Both are manual checks before release.

## Left to the builder

- Names of types, constants and helpers; module split inside `approval/`.
- How settled results are expired (a timer per result or a sweep), as long as it's testable
  with fake timers.
- Whether `DELETE` waits for the Telegram edit before answering.
- Exact tool description wording, within the intent above.
- The progress `message` text.

## Decisions made without user input

1. Cap raised to 24 h (86 400 s); default stays 300 s; values above the cap still clamped.
2. One cap for blocking and background questions, MCP tools, `Client` and the CLI.
3. Background create is a separate path, `POST /request/async`, not a body flag, for version
   skew and one response shape per operation.
4. The public id is the existing internal request id.
5. State field named `state` with `pending`, `done` and `cancelled`; `done` reuses
   `answer`/`timedOut`.
6. Long-poll via `?wait=`, default 0, clamped to 120 s; bad values `400`.
7. Settled background results kept 24 h, then `404`.
8. `DELETE` is idempotent: `200` with the current state when already settled.
9. `GET` and `DELETE` on an id skip the pairing check.
10. `ask_for_permission` stays a blocking `POST /request` (connection as lease), with progress
    notifications every 60 s when the client gives a progress token.
11. Two new MCP tools, `ask_for_permission_in_background` and `wait_for_answer`; no cancel tool.
12. `wait_for_answer` waits until settled by default; cancelling it doesn't cancel the question;
    `cancelled` is a normal result, not a tool error.
13. The MCP server cancels its unsettled background questions when stdin ends.
14. TCP keepalive on client sockets; explicit zero timeouts on the Fastify server.
15. No CLI background subcommands or `Client` background methods in this round.
16. No persistence across restarts; a lost question is a `404` error, never a fake timeout.
17. Plain MCP tools instead of experimental MCP Tasks.
18. Accept that `fetch` callers sending `timeout` over 300 now hit undici's 300 s limit;
    document workarounds instead of an opt-in flag. (From the builder check.)
19. On shutdown the service cancels and finalizes all pending questions before stopping,
    reusing the "Cancelled" line. (From the builder check.)
20. Clients treat an early `timedOut` on a request over 300 s as a "service too old" error;
    no `/status` version field. (From the builder check.)
