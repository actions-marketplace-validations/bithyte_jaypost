# Bot commands: design

Source: an autonomous brainstorming run on 2026-10-19. No human answered questions during it, so
every call that would normally go to the owner is marked "Decision (made without user input)".
Builds on the code as it is at `99ae1b9` (0.3.0): provider seam, `/notify`, `project`, MCP server,
`send`, `Client`. What exists stays as it is unless this doc says otherwise.

## Intent

The owner gets questions from several agents and scripts at once. Today the only way to see what's
still waiting is to scroll the chat, and the only way to clear a pile of questions is to tap each
one. The request, in the owner's words: "`/pending` lists open requests, `/cancel` rejects all of
them (answering each with its timeout option, or something better you decide on), and `/history`
shows the last N answers."

So the bot learns three commands the owner sends in the chat:

1. `/pending`: what's open right now, with what each one will answer on timeout and how long is
   left.
2. `/cancel`: settle every open request at once with its safe answer.
3. `/history [N]`: the last N settled requests and how each ended.

## Goals

- The three commands work in the owner's private chat with the bot, and show up in Telegram's
  command menu there.
- The command logic and all reply text live in the core (`src/approval/`), not in the Telegram
  module, so a future provider gets them by routing names to one handler. Same split as
  `formatFinalText` today.
- `/cancel` never leaves a caller hanging and never surfaces as an error to a caller.
- No change to the HTTP API, the OpenAPI spec, the `Client`, the CLI or the MCP tools.

## Non-goals

- Persisting history across restarts. Pending requests are in memory and drop on restart; history
  does the same.
- Cancelling or answering a single request by command. Each message already has its own buttons.
- Touching notifications. `/cancel` doesn't dismiss them, `/history` doesn't list them.
- HTTP endpoints for pending or history (`GET /pending` and the like).
- `/help`, `/start` replies after pairing, or any other command.
- Telling the API caller that its answer came from `/cancel` rather than a tap (see below; possible
  later as an additive field).
- Group chats. Private chat with the owner only.

## Anti-goals

- A caller that gets a 500, a connection error or a hang because the owner ran `/cancel`.
- Anyone but the paired owner seeing request text, answers or counts. Commands from anyone else are
  ignored silently, the way taps from strangers are (`routeTap` returns `'ignored'`).
- A bot token in a log line. Logging around the new Telegram calls follows `runtime.ts`: never the
  raw error text of a failed API call.
- Overwriting command lists the owner set themselves in BotFather.
- A reply Telegram refuses because it's too long.

## `/cancel` semantics

Decision (made without user input): `/cancel` settles each open request with a new settlement kind,
`rejected`, whose `answer` is the request's `timeoutOption`. The caller gets
`{ "answer": <timeoutOption>, "timedOut": false }`.

Why this over the alternatives:

- Settling as `timedOut` (the literal suggestion) lies to the caller. `timedOut: true` means "no
  answer from the user", and the MCP tool's text says exactly that. An agent told nobody answered
  may reasonably ask again. The owner did answer: they rejected everything.
- Settling as the existing `cancelled` kind returns HTTP 500 `request was cancelled` and makes the
  `Client` throw. That's an error path for something the owner did on purpose.
- `timeoutOption` is already documented as the safe choice ("on timeout you get `timeout_option`,
  so make that the safe choice"), so it's the right answer to give when the owner says no to all.
- `timedOut: false` is honest: the owner acted. What the caller can't tell is that it was a bulk
  reject and not a tap on that button. I think that's fine for now and left it out of the API on
  purpose.

Decision (made without user input): no confirmation step. Tapping `/cancel` in the menu sends it
immediately; a mistap rejects everything with safe answers. A confirm button would need either
state or a cutoff timestamp in callback data, and the cost of a mistap is low because every answer
is the caller's own safe option. The reply lists what was rejected, so a mistap is at least
visible.

Requests whose message is still being sent when `/cancel` runs (inside `sendRequest`, not yet
registered) aren't rejected; they show up as normal. Document this in the README in one line.

Each rejected request's Telegram message is finalized like any other settlement: text replaced,
buttons removed, with a new result line (below). The existing settle-once guarantee in
`PendingRequests` covers a tap, timeout or abort racing the reject.

## Command behavior and text

All replies are plain text (no `parse_mode`), like every other message the bot sends. Wording below
is the intended shape; the builder may adjust words but not structure or content.

### Request summary

Lists show a one-line summary of each request's text: whitespace runs (including the newlines after
the `[project]` line) collapsed to one space, trimmed, cut to 80 characters with `…` as the 80th
when longer. So `[deploy]\n\nDeploy to prod?` shows as `[deploy] Deploy to prod?`. Decision (made
without user input): 80 characters; reuse the stored text rather than storing `project`
separately, since the text already carries the project line.

### `/pending`

Open requests, oldest first, each as two lines with a blank line between entries:

```
2 pending

[deploy] Deploy to prod?
Approve, Decline. 4 min left, then Decline

Force-push main?
Yes, No. 40 s left, then No
```

- Time left is `openedAt + timeoutSeconds - now`. Under 60 s: whole seconds, rounded up, `N s`.
  Otherwise whole minutes rounded up, `N min`. Never below `1 s` for a request still listed.
- Header is `1 pending` / `N pending`.
- Nothing open: `Nothing pending.`

### `/cancel`

Rejects everything open (as above), then replies with what it did, in the same entry style:

```
Rejected 2

[deploy] Deploy to prod?
→ Decline

Force-push main?
→ No
```

Nothing open: `Nothing pending.`

### `/history [N]`

The last N settled requests, newest first. Each entry is the summary line, then the same result
line the settled message shows (`formatResultLine`, so the two can't drift apart):

```
Last 3

[deploy] Deploy to prod?
✅ Approve, 14:05

Force-push main?
⛔ Rejected, No, 14:01

[ci] Retry flaky job?
⏱ Timed out, Skip, 13:50
```

- All settlement kinds are recorded: `answered`, `timedOut`, `rejected` and `cancelled` (caller gave
  up). Decision (made without user input): include `cancelled`, since "what happened to that
  question" is the point of the command, even though the request said "answers".
- Header is `Last N` where N is the number actually shown.
- Argument: optional, trimmed. Missing means 10. A positive integer is clamped to the buffer size
  (20), the way `timeout` is clamped to 300. Anything else (`0`, `-3`, `abc`, `2.5`, extra words)
  replies `Usage: /history [1-20]` and does nothing else.
- Nothing recorded yet: `No answers since the service started.`
- Decision (made without user input): keep the last 20 settled requests in memory, default N of
  10. 20 entries of at most 80 + ~40 characters fit well inside Telegram's 4096 limit.

### Result line for `rejected`

`formatResultLine` gains a case: `⛔ Rejected, <answer>, HH:MM`. Distinct from `🚫 Cancelled, HH:MM`,
which means the caller went away. Decision (made without user input): the word "Rejected" and the
`⛔` sign.

### Length cap

Every reply must fit the provider's `maxTextLength` (3900 for Telegram). Two rules, so one entry is
always bounded and every reply lists at least something:

- Each line of an entry is bounded. The summary is cut at 80 characters as above. The `/pending`
  options list (`Approve, Decline`) is cut the same way at 80 characters with `…`, since the parser
  puts no limit on how many options a request has. Answers in `/cancel` and result lines in
  `/history` are already at most 64 characters plus a fixed prefix. So one entry is at most about
  250 characters. Decision (made without user input): cut the options line rather than drop
  whole entries that are too long.
- The formatters keep back room for the trailer `…and N more` (sized for the largest possible N),
  add whole entries while they fit, then append the trailer if anything was left out. The header
  counts stay the true totals.

With Telegram's 3900 this only triggers for a long `/pending` or `/cancel` list. The fake
provider's limit of 100 is smaller than one full entry, so the length-cap tests pass
`maxTextLength` straight to the formatters with short request texts, rather than going through the
fake provider.

## Code shape

Matches the repo, which differs from the global style guide in places: functions rather than
everything-in-a-class, `#private` fields, single quotes, no semicolons, vite-plus tests. Within
that, follow the guide: `readonly` types, discriminated unions on `kind`, exhaustive `switch`
without `default`, payload-free variants as `as const satisfies` constants, explicit return types,
JSDoc stating the contract.

### `src/approval/`

- `types.ts`
  - `Settlement` gains `{ readonly kind: 'rejected'; readonly answer: string }`.
  - `PendingEntry` gains `readonly openedAt: Date`.
  - New `PendingSummary = { readonly id: string; readonly text: string; readonly options: readonly
    string[]; readonly timeoutOption: string; readonly openedAt: Date; readonly timeoutSeconds:
    number }` (or `request: ApprovalRequest` plus `id` and `openedAt`; builder's call).
  - New `HistoryEntry = { readonly text: string; readonly settlement: Settlement; readonly
    settledAt: Date }`.
  - New `OwnerCommand = { readonly name: 'pending' | 'cancel' | 'history'; readonly description:
    string }`.
- `constants.ts`: `HISTORY_LIMIT = 20`, `DEFAULT_HISTORY_COUNT = 10`, `SUMMARY_MAX_LENGTH = 80`,
  and `OWNER_COMMANDS: readonly OwnerCommand[]` with the menu descriptions (`List open requests`,
  `Reject all open requests with their timeout answers`, `Show recent answers`).
- `pending.ts` (`PendingRequests`)
  - `open(id, request, openedAt: Date)`: the caller passes the time; `PendingRequests` still owns
    only the timeout timer, not a clock.
  - `list(): readonly PendingSummary[]`, oldest first (the `Map` keeps insertion order).
  - `rejectAll(): readonly PendingSummary[]`: settles every entry with `{ kind: 'rejected', answer:
    timeoutOption }` through the same private settle path (timer cleared, resolved once) and returns
    what it rejected, in order. Synchronous.
- `service.ts` (`ApprovalService`)
  - Passes `this.#now()` to `open`.
  - After a request settles, reads the clock once and uses that one `Date` for both the history
    entry and the final text (today `#finalize` reads it itself).
  - Keeps a bounded history array, newest last internally, dropping the oldest past
    `HISTORY_LIMIT`. Recorded before the final edit, so `/history` right after `/cancel` already
    shows the rejected ones.
  - Maps `rejected` to `{ kind: 'completed', outcome: { answer, timedOut: false } }`.
  - New public methods: `listPending()`, `rejectAll()`, `history(count: number)` (newest first). Pure
    data, never throw.
- `formatter.ts`: the `rejected` case in `formatResultLine`, plus `formatSummary`,
  `formatPendingReply`, `formatRejectedReply`, `formatHistoryReply`. Each takes the data, `now` where
  it needs it, and `maxTextLength`, and returns the full reply text.
- `commands.ts` (new): `runOwnerCommand(service, name, argument, options): string | undefined`.
  `options` carries `now` and `maxTextLength`. Switches on the name; returns `undefined` for a name
  it doesn't know so the provider stays silent. Parses the `/history` argument here. Never throws.
- `index.ts`: export the new types, `OWNER_COMMANDS` and `runOwnerCommand`.

Decision (made without user input): the commands live in `src/approval/` rather than a new module,
because all three are about approval requests and need `ApprovalService` state. `src/commands/` is
already the CLI.

### Provider contract (`src/provider/types.ts`)

`RuntimeHandlers` gains:

```ts
/** Commands the owner can send; the provider shows them in its menu if it has one. */
readonly commands: readonly OwnerCommand[]
/** Reply text for an owner command, or undefined to stay silent. Never throws. */
readonly command: (name: string, argument: string) => string | undefined
```

Required on the handlers object, optional to act on: a provider that has no commands just ignores
both. The fake provider in `test/provider/fake.ts` already captures `handlers`, so daemon tests can
call `handlers.command('pending', '')` directly.

Decision (made without user input): the provider passes the raw name and argument string and the
core does all parsing and formatting, rather than one handler per command returning data for the
provider to format. Keeps reply text identical across providers and the provider side tiny.

### Daemon (`src/daemon/service.ts`)

Wires `commands: OWNER_COMMANDS` and `command: (name, argument) => runOwnerCommand(service, name,
argument, { now: () => new Date(), maxTextLength: provider.maxTextLength })`. Nothing else changes.

### Telegram (`src/telegram/`)

- `adapter.ts`: `registerCommandHandler(bot, owner, commands, command)` registers the command names
  with grammY's `bot.command(...)` (which also matches `/pending@botname`). It replies only when the
  message is in a private chat and `from.id === owner.id`; otherwise it does nothing and doesn't
  pass the update on. The argument is `context.match`. An `undefined` result sends nothing.
- `adapter.ts`: a pure helper deciding whether a command message is the owner's (like `routeTap`),
  so the owner check is unit-testable without grammY.
- `runtime.ts` `start()`: registers the command handler before the pairing handler, so a command
  typed while pairing is ignored instead of counting as a wrong code. Then sets the menu.
- Menu: `bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: owner.id } })`, called at
  start when an owner is known and again from the pairing callback right after pairing. Not awaited
  by `start()`; a failure logs `failed to set bot commands` plus the `error_code` when it's a
  `GrammyError`, never the error message. Decision (made without user input): chat scope for the
  owner only, so strangers don't see a menu and any default-scope commands the owner set in
  BotFather survive. Known gap: after `reset-owner` the old owner's chat keeps a stale menu; its
  commands are ignored. Not worth a cleanup call.

## Other specs dated 2026-10-19

Several other autonomous specs were written the same day against the same code and touch the same
places. Decision (made without user input): plan and build this one against `99ae1b9` alone. Don't
wait for the others and don't build on their guessed interfaces. Whichever lands second rebases
onto what's on `main` and resolves the touchpoints below as described. If one of them has already
merged when this plan starts, plan against `main` and apply the matching rule up front.

- `2026-10-19-quiet-hours-design.md` adds `/mute`, `/unmute` and `/quiet`, with its own
  `setMyCommands` call at the default scope. This is the one that really collides:
  `setMyCommands` replaces the whole list for a scope, and Telegram shows the chat-scope list in
  the owner's chat over the default one, so two separate registrations hide each other's commands.
  Rule: there is one command registry, `OWNER_COMMANDS` plus `RuntimeHandlers.command` from this
  doc, and one `setMyCommands` call with the chat scope. Quiet hours' commands join that list and
  its dispatcher (its handlers can live in its own module; `runOwnerCommand` just routes the names).
  Decision (made without user input): chat scope wins over quiet hours' default scope, for the
  reasons under Telegram above.
- `2026-10-19-free-text-replies-design.md` adds a `replied` settlement kind, allows a question with
  no options, and adds an owner `message:text` handler that passes `/commands` through. Rules:
  `replied` maps to `timedOut: false` and gets a history entry like `answered` (its result line is
  that spec's call); `/pending` shows `Text reply` in place of an empty options list, and how to say
  "buttons, or type a reply" when both are allowed is the builder's call. Its text handler must keep
  passing commands through so `bot.command` here still sees them.
- `2026-10-19-restart-safe-state-design.md` persists pending requests and adds an `expired` end
  state for messages orphaned by a restart. Rules: `openedAt` becomes part of the persisted record
  (so it survives in the file; recovery doesn't need it today, but the shape should hold what
  `PendingRequests` holds). Orphans finalized as expired on startup aren't added to `/history`,
  which starts empty each run. `rejected` is a normal `Settlement`, so it needs no special case
  there.
- `2026-10-19-audit-log-design.md` logs one `settled` line per `Settlement` kind. Rule: `rejected`
  is logged as outcome `rejected` with its `answer`, and the log reader shows it. `/history` stays
  in memory either way; reading it from the audit log is a possible later change, not part of this.

## README

- New "Bot commands" section after "Pairing": the three commands, one line each, plus: owner only,
  history is in memory and resets on restart, a request still being sent when `/cancel` runs isn't
  rejected.
- Under "Ask a question", one sentence: if the owner sends `/cancel`, every open request returns its
  `timeoutOption` with `timedOut: false`.
- No change to `docs/openapi.yaml` (the API shape doesn't change). The builder should confirm `npm
  run openapi` produces no diff.

## Tests

Repo conventions: vite-plus (`vi`, `expect`), flat `test(...)`, fake timers as in
`test/approval/pending.test.ts`, fake provider and fake bot as today.

- `test/approval/pending.test.ts`: `list` order and fields; `rejectAll` settles each with its
  timeout option, clears timers (advancing past the timeout changes nothing), returns them in order,
  empties the map; `rejectAll` on empty returns `[]`; answer after reject returns false.
- `test/approval/service.test.ts`: rejected request resolves `completed` with `timedOut: false`;
  final text has the `⛔ Rejected` line; history records every kind, newest first, drops past 20;
  history entry and final text share one clock read (inject a `now` that counts calls or returns
  increasing times).
- `test/approval/formatter.test.ts`: summary collapsing and the 80-char cut; time-left rounding
  (1 s, 59 s, 60 s, 61 s, 300 s); options line cut at 80; each reply's empty state; length cap with
  `…and N more` against a small `maxTextLength`, including the trailer fitting and at least one
  entry listed.
- `test/approval/commands.test.ts` (new): dispatch of each name; unknown name returns `undefined`;
  `/history` argument cases (missing, `5`, `50` clamps to 20, `0`, `abc`, `2.5`, `3 4`).
- `test/telegram/adapter.test.ts`: owner check (owner private chat yes; stranger, group, unpaired
  no).
- `test/telegram/runtime.test.ts`: the fake bot needs `command` and `api.setMyCommands`; the
  existing `on` order assertion changes. `setMyCommands` called with chat scope when the owner is
  known, not called when unpaired, called after pairing; a rejected `setMyCommands` logs without the
  error text.
- `test/daemon/service.test.ts`: through the fake provider, `handlers.command('cancel', '')` makes a
  pending `POST /request` return `200 { answer: <timeoutOption>, timedOut: false }`.

## Left to the builder

- Exact reply wording within the shapes above, and the menu descriptions.
- Whether `PendingSummary` flattens the request or nests it.
- Whether to split the new formatters into their own file if `formatter.ts` gets long.
- Plan order. A sensible one: settlement kind and `PendingRequests` changes, then service history,
  then formatters and `runOwnerCommand`, then the provider contract and daemon wiring, then Telegram,
  then README.

## Decisions made without user input

For the owner to check while reading. Each is marked where it's made above.

1. `/cancel` settles as a new `rejected` kind answering `timeoutOption` with `timedOut: false`, not
   as a timeout and not as `cancelled`.
2. No confirmation step for `/cancel`.
3. No API field telling the caller an answer came from `/cancel`.
4. `/history` includes all settlement kinds, `cancelled` too.
5. History holds the last 20, default N is 10, larger N is clamped, bad N gets a usage reply.
6. History is in memory only.
7. Summaries are the stored text collapsed to one line and cut at 80 characters; the `/pending`
   options line is cut the same way.
8. `⛔ Rejected, <answer>, HH:MM` as the result line.
9. Commands live in `src/approval/`; the provider passes raw name and argument, the core formats.
10. Command menu set with the owner's chat scope, not the default scope.
11. Commands from anyone but the owner, or outside a private chat, are ignored silently.
12. Build against `99ae1b9` alone; the rules under "Other specs dated 2026-10-19" settle conflicts,
    with one shared command registry and chat scope winning over quiet hours' default scope.
