# Restart-safe pending state: design

Source: a brainstorming request on 2026-10-19, run without the owner in the loop. Every call
that would normally have been put to the owner is marked "Decision (made without user input)".
Builds on `2026-10-18-notifications-design.md`, which accepted in-memory timers as a known issue
and said to revisit it later. Anything not mentioned here stays as it is.

## Intent

Two things go wrong today when the service restarts (an upgrade via `init`, a reboot, a crash,
`reset-owner`):

1. A notification whose 8-hour timer hadn't fired yet is never auto-deleted. The README lists
   this as a known issue.
2. A request that was waiting for a tap keeps its buttons in the chat. The caller already got a
   connection error, so the question is dead, but it still looks live. Tapping a button gives an
   "Expired" toast and nothing else.

The fix: write the pending requests and the notification expiries to a small file next to the
config (so it lands in the data volume for the container targets), and on startup clean up what
the previous run left behind. Orphaned request messages get edited to an "expired" line with
their buttons removed; notifications get their remaining time back, or are deleted right away if
they're overdue.

## Goals

- Notification auto-delete survives restarts. A notification sent at 10:00 is deleted at about
  18:00 even if the service was restarted at 12:00, and deleted on startup if the service was down
  at 18:00.
- On startup, every request message left pending by the previous run is edited to its original
  text plus an expired line, with the buttons removed.
- Works the same for all three targets (Quadlet, Compose, systemd) with no install changes.
- A missing, unreadable or corrupt state file never stops the service from starting.

## Non-goals

- Resuming a pending request after a restart. The HTTP caller's connection is gone, so there's
  nobody to answer. Callers still see a connection error, as today.
- New cleanup work on graceful shutdown. Startup recovery covers clean stops and crashes alike
  (see "Shutdown" below for how the existing cancel-on-disconnect path interacts with it).
  Decision (made without user input): skip it. The cost is that a service that's stopped and never
  started again (`uninstall`) may leave its last pending messages as they are.
- sqlite or any other database. The notifications spec said "revisit when the project gets
  sqlite". Decision (made without user input): a JSON file is enough for a handful of records at
  human request rates, and `node:sqlite` still prints an experimental warning on some Node 24
  releases. Revisit if state grows past this.
- A fallback for messages Telegram refuses to delete (its 48-hour bot delete limit, after a long
  outage). Logged and dropped, same as a failed delete today.
- Configuring where the state file lives. No new env var or flag.

## Anti-goals

- A state file problem (disk full, bad JSON, permissions) failing a `/request` or `/notify`, or
  stopping startup.
- Recovery delaying the HTTP server or the bot. New requests work while old ones are being cleaned
  up.
- Taps getting misrouted because restored ids collide with new ones. Ids stay random UUIDs.
- Secrets in the state file or in its error messages.

## Where the state lives

`state.json` in the same directory as the resolved config file: `join(dirname(configPath),
'state.json')`, where `configPath` is the `resolveConfigPath(env)` value the daemon already has.

- Quadlet and Compose: `TELEGRAM_ASK_CONFIG=/data/config.json`, so it's `/data/state.json` in the
  data volume. Survives container recreation and image upgrades.
- systemd: next to `config.json` (`~/.config/telegram-ask/state.json` by default, or next to
  whatever `TELEGRAM_ASK_CONFIG` the unit pins).

Decision (made without user input): derive the path from the config path rather than add a
setting. `startService` derives it; `ServiceOptions` doesn't grow a field. Tests already pass a
temp `configPath`, so they get an isolated state file for free.

Written with `writeFileAtomic` (temp file, fsync, rename) and mode `0o600`, since it holds message
text. Decision (made without user input): reuse `SECRET_FILE_MODE`.

## File format

```json
{
  "version": 1,
  "provider": "telegram",
  "requests": [
    { "id": "8c0f...", "reference": { "chatId": 123, "messageId": 456 }, "text": "[deploy]\n\nDeploy?" }
  ],
  "notifications": [
    { "id": "1b2e...", "reference": { "chatId": 123, "messageId": 457 }, "expiresAtMs": 1792400000000 }
  ]
}
```

- `requests[].text` is the message text as sent (project line included), so recovery can rebuild
  the final text the same way `formatFinalText` does now.
- `reference` is the provider's opaque `MessageReference`, stored as is. That makes it a
  requirement that references are JSON-serializable; say so in the `MessageReference` and
  `Messenger`/`ProviderRuntime` JSDoc. Telegram's `{ chatId, messageId }` and the fake provider's
  `{ n }` already are.
- `expiresAtMs` is wall-clock epoch milliseconds (`Date.now()` at send plus `NOTIFICATION_TTL_MS`).
  Decision (made without user input): store the absolute expiry rather than the send time, so a
  later change to the TTL doesn't shorten or stretch notifications already out. Wall clock, not
  `performance.now()`, because it has to mean the same thing across processes.
- `provider` is the provider name the records were made with. If it doesn't match the running
  provider, the records are discarded with one log line. Decision (made without user input): a
  reference from one provider means nothing to another.
- Validate with zod, like the config file. `reference` is `z.unknown()` but must be present.

Loading rules (Decision, made without user input, for all of them):

- Missing file: empty state, nothing logged. Nothing is written until the first change.
- Invalid JSON, wrong shape or unknown `version`: log one line (`ignoring state file "<path>":
  <reason>`, without quoting file contents), start empty. The bad file is overwritten by the next
  write. The service doesn't crash: losing cleanup for a few messages is better than not starting.
- Other read errors (permissions, EISDIR): same as invalid, logged and ignored. This is a
  deliberate exception to "rethrow other I/O errors", for the same reason.

Writing rules:

- The whole state is rewritten on every change. At a few changes per minute at most, that's fine,
  and `writeFileAtomic` is synchronous so writes can't interleave.
- A failed write is logged (`failed to save state to "<path>": <message>`) and otherwise ignored.
  The in-memory state carries on, and the next change tries again. Decision (made without user
  input): persistence is best effort; a full disk shouldn't turn into failed approvals.

## Behavior

### Requests

1. `ApprovalService.request` sends the message as today. Once `sendRequest` returns a reference,
   the request is added to the state (`id`, `reference`, `text`) and written.
2. When it settles (answer, timeout, cancel), `#finalize` runs as today. The record is removed
   after the finalize attempt, whether it succeeded or not. If the process dies between settling
   and finalizing, the caller never got its response either (the response goes out after
   finalize), so the next start calling it "expired" is accurate.
3. If the messenger has no `finalize`, requests aren't recorded at all; recovery would have
   nothing to do.

There's a small window between Telegram accepting the message and the record being written. A
crash inside it leaves one untracked message. Accepted.

### Notifications

1. `NotificationService.notify` sends as today. If the notifier can delete, it records `id`,
   `reference` and `expiresAtMs`, writes, and starts the timer.
2. Timer fires: delete the message, then remove the record (after the delete attempt, either
   outcome).
3. `dismiss(id)`: clears the timer and removes the record. Restored notifications are known to the
   service, so `dismiss` returns true for them after a restart. The tap handler keeps deleting the
   tapped message itself, as today.

### Startup recovery

In `startService`, after `checkCredentials` succeeds (so the provider can make API calls) and
before `runtime.start`:

1. Load the state file.
2. Build the services with the store. Restored notifications go straight into
   `NotificationService`: any with `expiresAtMs` still in the future get a timer for the remaining
   time; overdue ones are queued for deletion.
3. Kick off recovery without awaiting it: edit each orphaned request, delete each overdue
   notification, one at a time, removing each record after its attempt. Failures are logged and
   the record is dropped either way, so a message that can't be edited (deleted by hand, bot token
   changed) doesn't get retried forever.
4. `runtime.start` and the HTTP server go ahead as now.

Decision (made without user input): sequential, not parallel, so a backlog doesn't hit Telegram's
rate limit, and not awaited, so startup isn't held up. If Telegram is unreachable, `checkCredentials`
has already failed and the service has exited, so there's no retry logic.

Recovery runs whether or not someone is paired. After `reset-owner` the old messages are still in
the old owner's chat, and the reference carries the chat id, so they get cleaned up there.

A tap on an orphaned request before recovery reaches it gets the "Expired" toast, as today.

### Shutdown

Today a SIGTERM already touches pending requests: `server.close()` with
`forceCloseConnections: true` destroys the open sockets, the `close` listener aborts each request,
and `ApprovalService` cancels it and starts a "Cancelled" edit. `runService` then calls
`process.exit(0)` as soon as `stop()` resolves, so that edit races the exit. Without care, the
record would be removed if the edit wins and kept if it loses, and a restart would sometimes show
"Cancelled" and sometimes "Expired (service restarted)".

Decision (made without user input): make it deterministic. `stop()` freezes the store first, before
closing the server and the runtime. A frozen store ignores further adds and removes and never writes
again, so every request pending at shutdown is still in the file. The existing "Cancelled" edit is
left alone; if it lands, the next start overwrites it with the expired line (recovery rebuilds the
text from the stored original, so the edit is never "message is not modified"). Notification
records aren't removed on shutdown anyway. `stop()` also clears the notification timers
(a `stop()` or similar on `NotificationService`) so a stopped instance in the same process, as in
the daemon restart tests, can't fire a delete after a second instance has taken over the state.

### The expired line

Orphaned requests are edited to `formatFinalText`-style text: the original text, a blank line, then
the result line:

```
⌛ Expired (service restarted), 14:05
```

The time is the local time of the edit, like the other result lines. Decision (made without user
input): wording and emoji. It sits next to `✅ <answer>`, `⏱ Timed out, <answer>` and
`🚫 Cancelled`, and says why, since "expired" alone could be confused with a timeout.

This needs a fourth way for a message to end that `PendingRequests` never produces. Decision (made
without user input): don't add it to `Settlement`, which describes how a pending request settled
and feeds `RequestResult`. Instead add a wider type for what `finalize` and `formatResultLine`
take, `Settlement | { readonly kind: 'expired' }` (name is the builder's call), and widen
`Messenger.finalize` and `ProviderRuntime.finalize` to it. Telegram's `finalize` ignores the
settlement, so it doesn't change. None of these types are in the package's public exports
(`src/index.ts` only exports the `Client`), so this isn't a library API change.

## Code shape

Match the repo's conventions (free functions for pure logic, classes with `#private` fields for
stateful parts, zod schemas in `schema.ts`, single quotes, no semicolons) where they differ from
the general TypeScript style rules.

- New module `src/state/` with `index.ts`, `types.ts`, `schema.ts`, `constants.ts` (file name,
  version) and `store.ts`.
  - Types: the request record, the notification record, and the file shape.
  - `parseState(raw: unknown, providerName: string)`: pure, never throws, returns the records or a
    reason they were discarded.
  - A `StateStore` class: constructed with the path, provider name and a log function; `load()`
    reads the file once and returns what the previous run left; methods to add and remove request
    and notification records, each writing the full snapshot; and a `freeze()` the daemon's
    `stop()` calls first (see "Shutdown"). All I/O and write-failure logging lives here.
  - `resolveStatePath(configPath)` next to it.
- `ApprovalService` and `NotificationService` take the store as an optional dependency, typed as a
  narrow interface each (just the add/remove calls they use), not the whole class. Absent means
  in-memory only, which is today's behavior, so existing tests and the `mcp`/`send` tests that
  build services directly keep working unchanged. How it's passed (extra positional parameter or an
  options object) is the builder's call; keep the existing positional parameters working.
- `NotificationService` needs a wall clock for `expiresAtMs`: add an injectable `now: () => number`
  defaulting to `Date.now`. Restoring takes the loaded records and `now` once.
- Request recovery lives in `ApprovalService` (it owns the messenger and the formatter), as a method
  that takes the orphaned records and finalizes them as expired. Notification recovery lives in
  `NotificationService`. The daemon only loads, wires and kicks off.
- Startup recovery should resolve when it's done (even though the daemon doesn't await it), so
  tests can await it instead of sleeping.

## Uninstall and other commands

- systemd `remove(record, purge)`: on purge, also remove `state.json` next to the config file it
  removes. Quadlet and Compose already remove the volume on purge, which takes the state with it.
- Without purge, the state file stays, like the config. A later `init` reuses the config, so the
  next start cleans up the old messages.
- `init` replacing an install leaves the volume or config directory alone, so state carries over an
  upgrade. That's the main point of the feature.
- `reset-owner` doesn't touch the state.

## README

- Drop the "Known issue: the 8-hour timers live in memory" paragraph under Send a notification.
- Change "Pending requests live in memory, so a restart drops them (callers see a connection
  error)" to say a restart still drops the request (the caller sees a connection error) and the
  message is edited to an expired line when the service comes back.
- Mention `state.json` where each target's files are listed: in the data volume for Quadlet and
  Compose, next to `config.json` for systemd. Note that `uninstall` with purge removes it.

`docs/openapi.yaml` doesn't mention restarts, so it doesn't change.

## Tests

Use the repo's tools: `vite-plus/test`, `vi.useFakeTimers()`, real temp directories via `mkdtemp`,
the fake provider in `test/provider/fake.ts`.

- `parseState`: valid file, wrong version, wrong shape, provider mismatch, missing `reference`,
  extra fields.
- `StateStore`: missing file loads empty and writes nothing; corrupt JSON is logged and ignored;
  a write failure (unwritable directory) is logged, not thrown; writes produce valid JSON with mode
  `0o600`; each add/remove is reflected in the file; after `freeze()` nothing changes on disk.
- `ApprovalService` with a store: record written after send, removed after answer, timeout and
  cancel; not written when `sendRequest` throws; not written without `finalize`; recovery calls
  `finalize` with the expired text and kind for each orphan and removes them, including when
  `finalize` throws.
- `NotificationService` with a store and injected `now`: record written with the right
  `expiresAtMs`; removed on expiry and on dismiss; restored future notification is deleted at the
  remaining time, not the full 8 hours; overdue one is deleted during recovery; `dismiss` on a
  restored id returns true and stops the delete.
- Formatter: the expired result line.
- Daemon: start, open a request, stop, start again with the same `configPath`, and see the second
  fake runtime's `finalize` called with the expired text (the first one may also get a "Cancelled"
  finalize from the disconnect; the record must survive it because the store was frozen). A crash
  case: write `state.json` by hand with a request record and start once. Same for a notification restored across a
  restart. A provider name mismatch discards the state. A corrupt `state.json` doesn't stop
  startup.
- systemd install: purge removes `state.json`.

## Left to the builder

- Names of the new types, the store's methods and the wider finalize type.
- How the store is passed to the two services, as long as existing call sites keep compiling.
- Whether restored notifications and orphaned requests are handed over by the daemon or read from
  the store by the services.
- Exact log wording, beyond keeping file contents and secrets out of it.
