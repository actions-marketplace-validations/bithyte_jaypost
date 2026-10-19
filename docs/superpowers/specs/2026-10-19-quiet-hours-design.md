# Quiet hours and mute: design

Source: the owner's one-paragraph request on 2026-10-19, run without a follow-up conversation. Builds
on the notifications and provider seam work that's already shipped (`src/notify/`,
`src/provider/`); what exists stays as it is unless this doc says otherwise.

Every call marked "Decision (made without user input)" was made by me from the codebase and
sensible defaults, because nobody was around to ask. They're collected at the end too, so the owner
can check them in one pass.

## Intent

The owner gets notifications from scripts and n8n at any hour (the README's example is someone
joining a game server). At night, or in a meeting, those pings are noise. Approvals are different:
an agent is blocked waiting on a tap, so those should still buzz the phone.

The request, in the owner's words: configurable quiet hours plus a `/mute 2h` bot command. While
quiet, notifications go out silently (Telegram `disable_notification`) or get batched, and approvals
still ping.

## Goals

- A daily quiet-hours window (e.g. 23:00 to 08:00) during which notifications are sent silently.
- A `/mute <duration>` bot command that makes notifications silent for a while, starting now, and
  `/unmute` to end it early.
- Approvals (`POST /request`, `ask_for_permission`, `send request`) ping as they do today, whether
  quiet hours or a mute is active.
- Callers see no difference: `/notify` still returns `200 { "ok": true }` once Telegram accepts the
  message.
- A notification sent while quiet isn't auto-deleted before the owner had a chance to see it.

## Non-goals

- Batching or digests. Decision (made without user input): silent sends only. The request offered
  "silently or batched"; I picked silent because batching would break `/notify`'s contract (200
  means Telegram accepted it), needs an in-memory queue that a restart loses, and needs a digest
  format that fits 3900 chars with per-item Dismiss. Telegram already shows silent messages as
  unread in the chat, which covers most of what a digest would. Can be revisited as its own spec.
- A per-call override (`urgent: true` on `/notify`, or `silent: true` to force silence outside
  quiet hours). Decision (made without user input): not now.
- Exposing quiet state on `GET /status`, the OpenAPI spec, the `Client`, or the MCP tools, so agents
  could avoid asking at night. Decision (made without user input): no HTTP API change in this round.
- Different windows per weekday, or more than one window. Decision (made without user input): one
  daily window.
- Making approvals silent, or holding them back, during quiet.
- A CLI command for quiet hours (`telegram-ask quiet ...`). The bot command and the config file
  cover it.

## Anti-goals

- An approval that doesn't ping because quiet hours or a mute is on. That's the one thing this
  feature must never do.
- A notification that silently disappears: sent quietly at 23:30, auto-deleted at 07:30, never seen.
- `/notify` getting slower or able to fail in new ways because of quiet logic.
- A stranger messaging the bot and changing quiet hours or muting it.
- A broken or unwritable config file crashing the service when the owner sends `/mute`.

## How it behaves

### What "quiet" means

The service is quiet at instant `t` when either:

- quiet hours are set and the wall-clock time at `t`, in the service's time zone, is inside the
  window, or
- a mute is set and `t` is before `mutedUntil`.

While quiet, notifications are sent with Telegram's `disable_notification: true`. Nothing else
changes: same text, same Dismiss button, same reply to the caller. Outside quiet, everything is as
today.

Approval requests never look at quiet state. `sendRequest` doesn't get a silent flag at all, so
there's no code path that could make one silent by mistake. `finalize` edits don't notify anyway.

### Quiet hours window

- Format `HH:MM-HH:MM`, 24-hour, e.g. `23:00-08:00`. Start is inclusive, end exclusive, minute
  resolution.
- A window whose start is later than its end wraps midnight (`23:00-08:00` is quiet from 23:00 until
  07:59). A start earlier than the end is a same-day window (`13:00-14:00`).
- Start equal to end is rejected. Decision (made without user input): "always quiet" isn't
  expressible as a window; use a long mute instead.
- Input also accepts bare hours and single digits (`23-8`, `7:30-9`). Stored and shown normalized
  (`23:00-08:00`). Decision (made without user input).
- DST: the check compares wall-clock minutes in the zone, so the window follows local time across DST
  changes with no special handling.

### Time zone

Decision (made without user input): quiet hours use the service process's time zone, i.e.
`Intl.DateTimeFormat().resolvedOptions().timeZone`, which Node resolves from `TZ` or the host. No new
`timeZone` config key.

- systemd target: the host's zone, nothing to do.
- Compose and Quadlet targets: containers default to UTC, so `init` writes `TZ=<host zone>` into the
  container's `.env` (the host's `Intl` resolved zone, skipped when it can't be resolved). That's the
  only change outside the daemon and Telegram code. I checked that Node resolves `TZ` through its
  bundled ICU on this machine; I haven't checked it inside `node:24-slim`, which has no system
  tzdata. I'm fairly sure Node's full ICU covers it, but the builder should confirm with a quick
  `podman run -e TZ=Europe/Bucharest node:24-slim node -e ...` and fall back to an explicit
  `timeZone` setting if it doesn't.
- Existing container installs stay on UTC until the owner re-runs `init`. README says so.
- Every bot reply that shows a time also names the zone (`23:00-08:00 (Europe/Bucharest)`), so a
  wrong zone is obvious the first time the owner sets quiet hours.
- `TZ` joins `RESERVED_ENV_VARS` so no provider setting can claim it.

### Mute

- `/mute 2h` mutes from now until now + 2h. Durations are `<n>m`, `<n>h`, `<n>d` or combinations
  in that order (`1h30m`, `1d12h`), case-insensitive, positive, at most 7 days. Decision (made
  without user input): 7-day cap, which covers a long weekend or a holiday week.
- `/mute` with no argument mutes for 1 hour. Decision (made without user input).
- `/mute` while already muted replaces the end time (it doesn't add to it). Decision (made without
  user input): replace is easier to predict; `/mute 2h` always means "two hours from now".
- A bare number (`/mute 2`) or anything else unparseable gets a usage reply and changes nothing.
  Decision (made without user input): no guessing whether `2` means minutes or hours.
- `/unmute` clears the mute. Quiet hours still apply; the reply says so if the window is active now.
- When `mutedUntil` passes, the mute just stops applying. No message is sent, nothing is rewritten.

### Bot commands

Only the paired owner's commands do anything. Anyone else, and anyone while the bot is unpaired,
gets no reply (same as non-owner taps today). Decision (made without user input): commands are
silent for strangers rather than replying "not allowed", so the bot doesn't confirm it's alive to
randoms.

| Command                 | Effect                                       | Reply (wording left to the builder, but say this much) |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------ |
| `/mute [duration]`      | Mute until now + duration (default 1h).      | `Muted until 14:30 (Europe/Bucharest). Approvals still ping. /unmute to undo.` |
| `/unmute`               | Clear the mute.                              | `Unmuted.`, plus `Quiet hours 23:00-08:00 are on right now.` when that's true. |
| `/quiet`                | Show settings, change nothing.               | Quiet hours (or `off`), zone, mute state, and whether notifications are silent right now. |
| `/quiet 23:00-08:00`    | Set the quiet-hours window and save it.      | `Quiet hours set to 23:00-08:00 (Europe/Bucharest).` plus `Quiet now.` if inside it. |
| `/quiet off`            | Clear quiet hours and save that.             | `Quiet hours off.` |

- Times in replies are `HH:MM` when the end is today in the service's zone, and `Tue 14:30` when
  it's on another day.
- Bad input gets a one-line usage reply naming the accepted format, e.g.
  `Use /quiet 23:00-08:00 or /quiet off.` and `Use /mute 30m, /mute 2h or /mute 1d (up to 7d).`
- `/mute@botname` and `/quiet@botname` forms work (as `/start@botname` does today).
- These show in Telegram's command menu through one `setMyCommands` call with the owner's chat scope
  (`{ type: 'chat', chat_id: owner.id }`), made at start when an owner is known and again right
  after pairing, not awaited, a failure logged without the error text. Decision (made without user
  input): chat scope, matching `2026-10-19-bot-commands-design.md`, because `setMyCommands`
  replaces the whole list per scope and two features calling it separately would hide each other's
  commands. See "Other specs dated 2026-10-19".
- Command handling must not get in the way of pairing. The command handler is registered before
  the pairing handler; it acts only for the owner and lets everything else fall through, so
  `/start CODE` keeps working exactly as now, and a `/mute` typed while pairing is ignored rather
  than counted as a wrong code.

Decision (made without user input): the bot command `/quiet` is a way to set quiet hours, alongside
the config file. The owner asked for "configurable quiet hours"; for container installs the config
file lives inside a volume and the `.env` is rewritten by `init`, so editing either by hand is
awkward. A bot command works the same on every target.

### Configuration and persistence

Two new optional keys in `config.json` (the file `loadConfig` reads and `updateConfigFile`
writes, which for containers is `/data/config.json` in the volume):

| Key          | Type   | Written by                 | Notes |
| ------------ | ------ | -------------------------- | ----- |
| `quietHours` | string | hand edit, `/quiet`        | Normalized `HH:MM-HH:MM`. Absent means no quiet hours. |
| `mutedUntil` | string | `/mute`, `/unmute`         | ISO 8601 instant. Absent, or in the past, means not muted. |

- Both join `RESERVED_CONFIG_KEYS`.
- `fileConfigSchema` gets both as `z.string().optional()`; the loose object keeps working.
- `loadConfig` validates `quietHours` with the same parser `/quiet` uses. An invalid value is a
  startup error in the style of the port check: `invalid quiet hours "25:00-08:00": expected
  HH:MM-HH:MM`. Quoting it is fine; it's not a secret. Decision (made without user input): fail
  loudly at startup, like a bad port, rather than silently running without quiet hours.
- An unparseable `mutedUntil` is treated as not muted and logged once at startup, not fatal.
  Decision (made without user input): it's machine-written, and failing the whole service over a
  stale mute would be worse than ignoring it.
- No env var for either. Decision (made without user input): the repo lets env override the file
  for port, host and provider settings, but `init` rewrites the container `.env` from scratch, so a
  hand-added `QUIET_HOURS` would vanish on the next upgrade. The bot command is the supported way.
- `/mute` and `/unmute` persist `mutedUntil` (or delete it via `null`), so a restart or auto-update
  during the night doesn't unmute. Decision (made without user input): persist the mute; it's one
  small write per command.
- `/quiet ...` persists `quietHours` (or deletes it).
- In-memory state changes first, then the write. If the write fails, the command still takes effect
  for this run, the error is logged as one line (no file contents), and the reply adds `Couldn't
  save this; it resets on restart.` Same pattern as an owner that can't be saved after pairing.
- An expired `mutedUntil` is left in the file until the next `/mute` or `/unmute` overwrites it.

### Expiry of notifications sent while quiet

Today every notification is deleted 8 hours after it's sent. With quiet hours `23:00-08:00`, a
notification at 23:30 would be deleted at 07:30, before the owner wakes up. That's the "silently
disappears" anti-goal.

Decision (made without user input): a notification sent while quiet expires 8 hours after the
quiet period ends instead of 8 hours after it was sent.

- "Quiet period ends" is the first instant, looking forward from the send, when neither the mute
  nor the quiet-hours window applies. If a mute ends inside the window, it's the window's end; if
  the window ends while still muted, it's `mutedUntil`. Two or three steps at most.
- It's computed once, at send time. Changing quiet hours or unmuting later doesn't move already
  scheduled expiries. Decision (made without user input): not worth tracking.
- For the window end, a wall-clock minute difference is close enough. On a DST night the expiry can
  be off by an hour, which doesn't matter for cleanup.
- Telegram won't let a bot delete a message older than 48 hours (the existing notifications design
  already mentions this limit). When the extended expiry would land more than 47 hours after the
  send (only a long mute can do that; quiet hours alone top out around 32h), no expiry timer is
  started and the message stays until the owner taps Dismiss. Decision (made without user input):
  leave it in the chat rather than cap the delay at 47h, because a cap would delete it mid-mute,
  before the owner had a chance to see it, which is exactly the anti-goal. The 47h limit is a
  constant in `src/notify/constants.ts` (e.g. `MAX_NOTIFICATION_TTL_MS`) with a comment saying why.
- A notification sent while not quiet keeps its plain 8h expiry, even if that lands inside quiet
  hours (sent with a ping at 22:30, deleted at 06:30). Decision (made without user input): it
  pinged, so the owner had their chance; projecting future quiet periods and mutes at send time
  isn't worth it.
- Dismiss behaves as today. The restart known issue (timers in memory) is unchanged and applies to
  the longer timers too, unless `2026-10-19-restart-safe-state-design.md` lands, in which case the
  extended expiry is just the `expiresAtMs` it persists.

## Code shape

Match the repo's conventions where they differ from the global style guide: free exported
functions plus classes with `#private` fields, `{ ok: true, value } | { ok: false, error }`
results for parsers, positional constructor deps with defaults, `now: () => Date` as the clock
(as `ApprovalService` does), single quotes, no semicolons, vitest with `vi.useFakeTimers()`.

### New module `src/quiet/`

Self-contained, no Telegram imports. Roughly:

- `types.ts`: `QuietHours = { readonly startMinute: number; readonly endMinute: number }` (minutes
  after midnight), parse result types, the persisted patch shape.
- `constants.ts`: `DEFAULT_MUTE_MS` (1h), `MAX_MUTE_MS` (7d), the time and duration patterns
  (`_PATTERN` suffix), command names and descriptions for `setMyCommands`.
- `parser.ts`, pure and never throws:
  - `parseQuietHours(raw: string): QuietHoursParseResult`
  - `formatQuietHours(hours: QuietHours): string` (normalized form)
  - `parseMuteDuration(raw: string): MuteDurationParseResult` (milliseconds)
- `schedule.ts`, pure, all inputs as arguments including the instant and zone:
  - `isInQuietHours(hours, at: Date, timeZone: string): boolean`
  - `findQuietEnd(state, at: Date, timeZone: string): Date | undefined` (undefined when not quiet)
- `service.ts`: `QuietService` class holding quiet hours, `mutedUntil`, the zone, `now`, a
  `save(patch)` callback and `log`. Public: `isQuiet(): boolean`, `quietUntil(): Date | undefined`,
  and `handleCommand(name: string, argument: string): string | undefined` that returns the reply
  text (undefined for a name it doesn't own). Synchronous and never throws: `updateConfigFile` is
  already synchronous, and `save` failures are caught inside. The class reads the clock once per
  call.
- `index.ts`: named re-exports only.

The core owns quiet state and command handling, not the provider. Decision (made without user
input): same reasoning as the core owning notification timers; a future provider gets quiet hours
by routing commands and honoring one flag.

### Provider seam changes

- `Notifier.sendNotification` and `ProviderRuntime.sendNotification` take a third argument,
  `options: { readonly silent: boolean }`. Required, not optional, so every caller decides.
  Decision (made without user input).
- `RuntimeHandlers` gets the same two fields `2026-10-19-bot-commands-design.md` defines, so both
  features share one registry:
  - `commands: readonly OwnerCommand[]` (name plus menu description), required on the handlers
    object, and
  - `command: (name: string, argument: string) => string | undefined`, never throws, undefined means
    stay silent.
  The provider routes owner commands with those names to `command` and sends the returned text as
  a reply. If bot-commands hasn't landed, this spec adds these fields itself with exactly that
  shape; if it has, quiet hours adds its three entries to the list and its names to the dispatcher.
- `sendRequest` doesn't change.

### Telegram

- `createTelegramMessenger`'s `sendNotification` passes `disable_notification: options.silent` to
  `sendMessage`.
- `createTelegramRuntime.start` registers one command handler with grammY's `bot.command(...)` for
  every name in `handlers.commands`, before the pairing handler. It replies only in a private chat
  when `from.id === owner.id` (a pure helper like `routeTap` makes that testable), and calls the
  single chat-scoped `setMyCommands` described above. The argument is `context.match`.

### Notify

- `NotificationService` gets a quiet dependency, e.g. `Pick<QuietService, 'quietUntil'>`, and calls
  `quietUntil()` once per `notify`: `silent` is `quietUntil() !== undefined`, and the expiry delay is
  `min(MAX_NOTIFICATION_TTL_MS, (quietEnd - now) + NOTIFICATION_TTL_MS)` when quiet, else
  `NOTIFICATION_TTL_MS` as today. Constructor shape (positional vs options object) is the
  builder's call; existing tests construct it positionally.

### Config, daemon, install

- `Config` gains `quietHours?: QuietHours` and `mutedUntil?: Date` (omitted when absent).
- `startService` builds the `QuietService` from `config`, gives it a `save` that calls
  `updateConfigFile(configPath, patch)` inside a `try`, passes it to `NotificationService` and wires
  `handlers.commands` and `handlers.command`.
- `formatEnvFile` (or its callers in `compose.ts` and `quadlet.ts`) adds a `TZ=` line with the
  host's zone. The zone is passed in, not read inside the template function, so tests stay
  deterministic.

## Tests

- Parser: valid windows (wrapping, same-day, bare hours, normalization), start equal to end,
  out-of-range hours or minutes, garbage. Durations: each unit, combinations, case, zero, over 7d,
  bare number, empty.
- Schedule with fixed instants and explicit zones: inside, outside, exactly at start (quiet) and end
  (not quiet), midnight wrap, a DST transition day in a zone that has one, `findQuietEnd` for
  mute-only, window-only, mute ending inside the window, window ending inside the mute.
- `QuietService` with an injected clock and a fake `save`: each command's state change and reply,
  default 1h mute, replace on re-mute, unmute leaving quiet hours, usage replies changing nothing,
  `save` throwing still applies the change and adds the warning, expired `mutedUntil` not quiet.
- `NotificationService` with fake timers: silent flag passed through, expiry at quiet end + 8h, no
  timer at all when that would pass 47h after the send, not quiet means 8h exactly as today.
- Telegram adapter: `disable_notification` follows the flag; approval `sendMessage` calls never set
  it (assert on the request even while quiet); commands from a non-owner and while unpaired get no
  reply and change nothing; `/mute@botname` routes; pairing with `/start CODE` still works with the
  command handler registered; `setMyCommands` is called once, with chat scope, and its list includes
  the quiet commands.
- Config: `quietHours` and `mutedUntil` round-trip; invalid `quietHours` fails `loadConfig` with the
  message above; invalid `mutedUntil` is ignored.
- Daemon: `/mute` through the fake provider's `handlers.command` writes `mutedUntil` to the temp
  config file, and a restarted service picks it up.
- Install: container env files include `TZ=` when a zone is given, and omit it when not.

## README

New "Quiet hours" section near Notifications: what goes silent and what doesn't (approvals always
ping), the commands table, the `config.json` keys, the time zone note including "container installs
from before this release use UTC until you re-run `init`", and the longer expiry for notifications
sent while quiet. Add a line to the `/notify` section that it's sent silently during quiet hours.
No OpenAPI change.

## Other specs dated 2026-10-19

Several other autonomous specs were written the same day against the same code. Decision (made
without user input), same rule `2026-10-19-bot-commands-design.md` uses: plan and build this one
against `99ae1b9` (0.3.0) alone, don't wait for the others, and whichever lands second rebases onto
`main` and resolves the touchpoints below. If one has already merged when planning starts, plan
against `main` and apply its rule up front.

- `2026-10-19-bot-commands-design.md`: one command registry and dispatcher, one chat-scoped
  `setMyCommands` call, command handler before the pairing handler. Quiet hours' `/mute`,
  `/unmute` and `/quiet` join `OWNER_COMMANDS`; their logic stays in `src/quiet/` and the shared
  dispatcher routes those names to `QuietService.handleCommand`.
- `2026-10-19-free-text-replies-design.md`: its owner `message:text` handler must keep passing
  `/mute`, `/unmute` and `/quiet` through (it already passes commands through) so `bot.command`
  sees them.
- `2026-10-19-restart-safe-state-design.md`: it gives `NotificationService` a `now: () => number`
  and persists `expiresAtMs`. With both, `NotificationService` keeps that single clock, converts
  `quietUntil()` with `getTime()`, and persists the extended expiry as `expiresAtMs`; a notification
  left without a timer (the over-47h case) isn't persisted for expiry. `quietHours` and
  `mutedUntil` stay in `config.json`, not `state.json`. Decision (made without user input): they're
  owner settings the owner may hand-edit, not provider-specific records, and `state.json` throws
  away records on a provider mismatch.

## Left to the builder

- File names inside `src/quiet/`, type and constant names, exact reply wording within the table's
  constraints.
- `NotificationService` constructor shape.
- Whether the `TZ` line goes in `formatEnvFile` or its callers.

## Decisions made without user input

1. Silent sends only; no batching or digest.
2. No per-call urgent or silent override on `/notify`.
3. No HTTP API, `/status`, OpenAPI, `Client` or MCP change.
4. One daily window, no per-weekday schedules.
5. Start equal to end is rejected; use a mute for "always quiet".
6. Window input accepts bare hours (`23-8`) and is stored normalized.
7. Time zone is the process zone; no `timeZone` config key; `init` writes `TZ` to container `.env`.
8. Mute capped at 7 days; `/mute` alone means 1 hour; re-muting replaces the end time; bare numbers
   are rejected.
9. Commands from non-owners and while unpaired get no reply.
10. One `setMyCommands` call with the owner's chat scope, shared with bot-commands, failure logged.
11. Quiet hours settable from the bot with `/quiet`, as well as in `config.json`.
12. No env var for `quietHours` or `mutedUntil`, because `init` rewrites the container `.env`.
13. Mute persisted to `config.json` so restarts don't unmute.
14. Invalid `quietHours` in the file fails startup; invalid `mutedUntil` is ignored and logged.
15. Failed config writes apply in memory, log, and warn in the reply.
16. Notifications sent while quiet expire 8h after the quiet period ends, computed once at send time.
17. When that expiry would pass 47h after the send (Telegram's 48h delete limit), no auto-delete;
    the message stays until dismissed, instead of a cap that deletes it mid-mute.
18. A pinged notification whose plain 8h expiry lands inside quiet hours isn't extended.
19. The core owns quiet state and command handling; providers only route commands and honor the
    silent flag.
20. `silent` is a required argument on `sendNotification`.
21. Command seam matches bot-commands: required `commands` list plus a sync `command` returning
    `string | undefined`, handler before the pairing handler.
22. Build against 0.3.0 alone; whichever of the 2026-10-19 specs lands second resolves the
    touchpoints listed above.
23. `quietHours` and `mutedUntil` stay in `config.json` even if `state.json` exists.
