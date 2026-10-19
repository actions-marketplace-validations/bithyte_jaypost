# Audit log: design

Source: the owner's one-paragraph request on 2026-10-19 ("an append-only JSONL log of questions,
answers, timestamps and project, readable with a `telegram-ask log` command; it answers 'what did I
approve last night?'"). There was no conversation after that: every other choice below was made from
the codebase and sensible defaults, and each one is marked "Decision (made without user input)" so
the owner can check them while reading. A builder check (a fresh reviewer reading this doc against
the code) raised three open questions; their answers are folded in and marked the same way.
What the code and README describe today stays as it is unless this doc says otherwise.

## Intent

Agents and scripts ask the owner things at odd hours, and the owner taps a button half asleep. The
next morning the only record is the Telegram chat, which is scrolled past, has no project filter,
and loses nothing but also can't be searched or piped anywhere. The owner wants a durable,
local record of every question the service asked, what they answered (or that it timed out), when,
and for which project, plus a CLI command that shows it.

Success: the morning after, `telegram-ask log --since 12h` prints a short table that answers "what
did I approve last night?" without opening Telegram, on any of the three install targets.

## Goals

- The service appends one JSON line when a question is sent and one when it settles (answered,
  timed out, cancelled). Lines are never rewritten.
- Each record carries the request id, a UTC timestamp, the project (when given), the question text,
  the options and the outcome.
- `telegram-ask log` reads the log of the installed service, whichever target it runs on, and prints
  it as a table, or as JSON lines with `--json`.
- Filters for the common questions: since when, which project, how many.
- Logging can't break or slow down asking. A failed write is reported in the service log and the
  question goes ahead.

## Non-goals

- Logging notifications (`POST /notify`, `notify_user`, `send notify`). Decision (made without user
  input): notifications are informational and are deleted from the chat after 8 hours by design;
  keeping their text forever would cut against that, and the request is about questions and
  answers.
- Logging requests that never reached Telegram (400s, 503 not paired, 502 send failures). Nothing
  was asked, so there's nothing to approve.
- Logging late taps on expired messages.
- Reading the log over HTTP or MCP. Decision (made without user input): the API has no auth, and
  any local process or agent could then read the owner's full approval history. The log stays a
  file that only the CLI reads.
- Turning the log off, clearing it from the CLI, or configuring its location. Decision (made without
  user input): v1 is always on, in a fixed place. It can be deleted by hand (see Retention) or with
  `uninstall` and purge.
- Moving the log when `init` switches target (say systemd to quadlet). The old target's log stays
  where it was; the new one starts empty.
- Search by answer or text. `--json` piped to `jq` or `grep` covers that.
- A tamper-evident log (hashes, signatures). This is the owner's own record on their own machine.

## Anti-goals

- A question failing, hanging or being delayed because the log can't be written (full disk, bad
  permissions, read-only volume).
- The log showing an answer the owner didn't give, or hiding one they did. If the log is unsure
  (a question with no recorded outcome) it says so instead of guessing.
- Question text, which can hold secrets an agent pasted in, being readable by other users on the
  machine.
- `telegram-ask log` needing the service to be running. The morning after a crash is exactly when
  the owner wants it.

## Constraints

- Node 24, ESM, the repo's existing deps (commander, zod). No new runtime dependency.
- One service instance per bot token (README), so there's a single writer per log file.
- The container targets keep state only in their data volume (`/data`, with
  `TELEGRAM_ASK_CONFIG=/data/config.json` set in the image). The CLI runs on the host and can't read
  the volume directly; it reaches it the way `clearOwner` and `readSecrets` already do, by running
  the package's own CLI inside a container.
- Existing installs (0.3.0 and earlier) don't write a log and their images don't have the hidden
  read command. They get a clear "re-run init" message.

## Where the log lives

The file is `audit.jsonl` in the same directory as the config file the service runs with
(`dirname(resolveConfigPath(env))`). Decision (made without user input): next to `config.json`
rather than in `$XDG_STATE_HOME`, because the service already resolves that directory on every
target, the container image puts it in the data volume for free, and the systemd install record
already stores the exact `configFile` the unit uses. One rule covers all three targets plus a
hand-run `start`.

| Target  | Log path the service writes                                                   |
| ------- | ----------------------------------------------------------------------------- |
| systemd | `dirname(record.configFile)/audit.jsonl`, normally `~/.config/telegram-ask/` |
| quadlet | `/data/audit.jsonl` in volume `telegram-ask-data`                             |
| compose | `/data/audit.jsonl` in the compose project's `data` volume                     |
| no install, `start` by hand | next to `$TELEGRAM_ASK_CONFIG` or the default config path |

The file is created with mode `0600` (the repo's `SECRET_FILE_MODE`), since question text can hold
secrets.

### Retention

Decision (made without user input): size-based rotation with one old generation. Before an append,
if the current file plus the new line would exceed 10 MiB (`MAX_AUDIT_LOG_BYTES`, a constant), the
writer renames `audit.jsonl` to `audit.jsonl.1` (replacing any older `.1`) and starts a new file.
That keeps between 10 and 20 MiB of history, which at typical use is years of questions, and caps
disk use on a volume the owner rarely looks at. Readers always read `audit.jsonl.1` then
`audit.jsonl`. The size is taken with one `stat` on the first append and tracked in memory after
that, so appends don't stat.

Deleting by hand is fine: the writer recreates the file on the next append. The README says how
(`rm` for systemd, `podman exec telegram-ask rm /data/audit.jsonl*` or the compose equivalent).

## Record format

One JSON object per line, `JSON.stringify(record) + '\n'`, UTF-8. Two kinds, joined by `id`:

```json
{"v":1,"event":"asked","id":"5f0c…","at":"2026-10-18T21:41:07.312Z","project":"deploy","text":"Force-push main?","options":["Approve","Decline"],"timeoutOption":"Decline","timeoutSeconds":300}
{"v":1,"event":"settled","id":"5f0c…","at":"2026-10-18T21:41:52.004Z","outcome":"answered","answer":"Approve"}
```

| Field            | In        | Notes                                                                       |
| ---------------- | --------- | --------------------------------------------------------------------------- |
| `v`              | both      | Format version, `1`. Readers skip lines with another value.                  |
| `event`          | both      | `asked` or `settled`.                                                       |
| `id`             | both      | The request id `ApprovalService` already generates (`crypto.randomUUID()`). |
| `at`             | both      | `Date.toISOString()` (UTC) from the service's injected clock.               |
| `project`        | asked     | Trimmed project name; omitted when the caller sent none.                    |
| `text`           | asked     | The question as the caller sent it, without the `[project]` prefix.         |
| `options`        | asked     | Button labels in order.                                                     |
| `timeoutOption`  | asked     |                                                                             |
| `timeoutSeconds` | asked     | After clamping to 300.                                                      |
| `outcome`        | settled   | The settlement `kind`: today `answered`, `timedOut` or `cancelled`.         |
| `answer`         | settled   | The tapped option, or the timeout option; omitted for `cancelled`.          |

The set of outcomes is open (see "Fitting with the other 2026-10-19 specs"): the writer records
whatever `kind` the settlement has, plus its `answer` when it has one, and readers must accept any
non-empty `outcome` string. `options` may be an empty array. Adding outcome values doesn't bump `v`.

Decision (made without user input): two events per question rather than one line at the end. A
single line written on settle would lose questions that were on the owner's screen when the service
restarted, which is when the owner most wants to know what happened. Two events also keep the file
strictly append-only.

Decision (made without user input): UTC in the file, local time on screen. The container's clock
zone usually isn't the owner's (the image doesn't set `TZ`), so formatting happens in the host CLI.

Optional fields are omitted, never `null` or `undefined`, as elsewhere in the repo.

## Service side

### Keeping the project

Today `createApprovalRequestSchema` folds the project into `text` (`[project]\n\n<text>`) and drops
it, so `ApprovalService` never sees the project or the bare question. The parsed `ApprovalRequest`
needs to carry both, for example an optional `project` and the bare question alongside the combined
display text. Naming is the builder's call; the constraint is that what goes to Telegram doesn't
change and the log gets the bare text and the project separately. The 3900 limit check stays where
it is.

### The audit seam

`approval/types.ts` gets a small sink type next to `Messenger`, something like:

```ts
/** Records what happened to each request; implementations must not throw. */
export type AuditSink = {
  readonly asked: (id: string, request: ApprovalRequest, at: Date) => void
  readonly settled: (id: string, settlement: Settlement, at: Date) => void
}
```

`ApprovalService` takes it as an optional dependency (absent means no logging, which keeps the
existing tests and the library use unchanged). The constructor is positional today
(`messenger, now, newId`); whether the sink becomes a fourth argument or the optional ones move into
an options object is the builder's call.

Inside `request()`:

1. `sendRequest` succeeds, then `asked(id, request, now())`. A send failure logs nothing.
2. The request settles (tap, timeout or abort), then `settled(id, settlement, now())`, before the
   final Telegram edit, so a failed edit doesn't lose the record.

Both calls are synchronous and happen before any further `await`, so record order in the file
matches the order things happened.

### The writer

A new module `src/audit/` (`types.ts`, `constants.ts`, `schema.ts`, `store.ts`, `parser.ts`,
`formatter.ts`, `index.ts`, following the existing module layout). The writer is a class, say
`AuditLog`, that implements `AuditSink`:

- Constructor takes the file path, an optional max size (default `MAX_AUDIT_LOG_BYTES`) and an
  optional `log` for errors (default `console.error`), matching `NotificationService`.
- Each event becomes one line and is written with a single synchronous append (`appendFileSync` with
  mode `0600`, creating the directory if missing). Decision (made without user input): synchronous,
  no fsync per line. Lines are small, the event loop cost is negligible, ordering is free, and a
  power cut losing the last second of lines is acceptable for this tool.
- Never throws. Any I/O error, including a failed rotation, is reported through `log` as
  `failed to write audit log <path>: <message>` and the request goes on. Decision (made without user
  input): log every failure, no rate limiting; a broken disk will be noisy, which is fine.

`daemon/service.ts` (`startService`) builds the `AuditLog` with the path next to `configPath` and
passes it to `ApprovalService`. `ServiceOptions` can take an optional audit path or sink for tests.

## CLI: `telegram-ask log`

```
telegram-ask log [--since WHEN] [--project NAME] [-n, --limit N] [--json]
```

Reads the log of the installed service and prints the questions, oldest first, newest at the
bottom (next to the prompt).

- `--since WHEN`: only questions asked at or after WHEN. Accepts a duration (`30m`, `12h`, `7d`), a
  local date (`2026-10-18`, meaning local midnight), or an ISO 8601 date-time. Anything else is a
  usage error (exit 2, via commander's `InvalidArgumentError` like `parsePort`).
- `--project NAME`: exact match on the trimmed project name.
- `-n, --limit N`: show the last N matching questions. Decision (made without user input): defaults
  to 20 without `--since` and to no limit with `--since`, since "since 12h" means all of them.
  `-n` given explicitly always wins.
- `--json`: one JSON object per line per question, the merged view below, with full text and both
  timestamps. Meant for `jq`.

### Merging

The reader parses both files, keeps `asked` records in file order and attaches the `settled` record
with the same id. A question's status is:

| Status        | When                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `answered`    | settled with `answered`                                                  |
| `timedOut`    | settled with `timedOut`                                                  |
| `cancelled`   | settled with `cancelled` (the caller went away)                          |
| `pending`     | no settled record and `asked.at + timeoutSeconds` is still in the future |
| `interrupted` | no settled record and the timeout has passed, so the service stopped     |
| anything else | settled with an outcome this CLI doesn't know: shown as the raw outcome  |

An unknown outcome is shown, never dropped: the table prints the outcome name followed by the answer
when there is one (for example `rejected: Decline`), and `--json` passes it through as `status`.

The clock is injected, as elsewhere. A `settled` with no `asked` (its `asked` was in a generation
that got rotated away) is dropped.

### Table format

```
2026-10-19 00:41  deploy  Approve              Force-push main to origin?
2026-10-19 01:12  nas     Decline (timed out)  Delete 14 old snapshots?
2026-10-19 02:03          cancelled            Run migrations on prod?
2026-10-19 03:30  ci      interrupted          Merge #212?
```

Columns: asked time in host local time as `YYYY-MM-DD HH:MM`, project (empty when none), result,
first line of the question. Column widths fit the widest value shown, project capped at 20
characters. Decision (made without user input): the question shows only its first line, cut at 80
characters with `...`, whether or not stdout is a TTY; `--json` is the way to get the full text.
The settle time isn't in the table, only in `--json`.
The result column uses the first line of the answer, cut at 30 characters with `...`, so a long
typed answer (free-text replies) doesn't blow up the table.

No questions (missing file, empty file, or nothing matches the filters): prints `No questions
logged.` (or `No questions match.` when filters dropped everything) and exits 0.

### Bad lines

Lines that aren't valid JSON or don't match the schema (validated with zod in `audit/schema.ts`) are
skipped. The schema is deliberately loose where other specs may widen things: `outcome` is any
non-empty string, `answer` any string, `options` any array of strings (empty allowed), and unknown
fields are kept and ignored, so a newer service's lines aren't counted as unreadable. If any were skipped, after the output the CLI writes `skipped N unreadable log lines` to
stderr; exit code stays 0. A last line without a trailing newline is a write in flight and is
ignored silently.

### `--json` shape

```json
{"id":"5f0c…","askedAt":"2026-10-18T21:41:07.312Z","project":"deploy","text":"Force-push main?","options":["Approve","Decline"],"timeoutOption":"Decline","timeoutSeconds":300,"status":"answered","answer":"Approve","settledAt":"2026-10-18T21:41:52.004Z"}
```

`project`, `answer` and `settledAt` are omitted when absent. Timestamps stay UTC ISO strings.

### Exit codes

0 on success including an empty log, 1 when the log can't be read (container command failed, I/O
error, service too old), 2 for bad arguments, matching the other commands.

## How the CLI reaches the log

`Target` gets one more operation:

```ts
/** Raw contents of audit.jsonl.1 then audit.jsonl; '' when neither exists. Throws when it can't read. */
readonly readAuditLog: (record: InstallRecord) => Promise<string>
```

- systemd: reads the two files next to `resolveConfigFile(record)` directly.
- quadlet: `podman exec telegram-ask telegram-ask audit dump`; if that fails (not running),
  `podman run --rm -v telegram-ask-data:/data localhost/telegram-ask:<version> telegram-ask audit
  dump`, the same fallback `clearOwner` uses.
- compose: `docker compose -f <file> run --rm --no-deps -T bot telegram-ask audit dump`, the same
  shape `readSecrets` uses; `-T` so no TTY mangles the output.

`audit dump` is a new hidden command (like `owner`) that runs inside the container and writes
`audit.jsonl.1` then `audit.jsonl` from the config directory to stdout, raw. Missing files are
skipped; no files means empty output and exit 0. Decision (made without user input): the container
only dumps bytes and all parsing, filtering and time formatting happen in the host CLI, so the
output follows the host's time zone and the host CLI's version, and the in-image command stays
trivial.

With no install at all, `log` reads the two files next to `resolveConfigPath(env)` on the host, for
people running `start` by hand.

Too old: if `record.version` is `legacy`, or is older than `MIN_AUDIT_VERSION` and isn't equal to
the running CLI's own `VERSION`, `log` prints
`the installed service (<version>) doesn't keep a log; run telegram-ask init to upgrade` to stderr
and exits 1, without running anything. Decision (made without user input): check the recorded
version instead of probing the container, so the message is the same on every target and an old
image is never started just to fail. A plain numeric `major.minor.patch` comparison is enough; no
semver dependency.

Decision (made without user input): `MIN_AUDIT_VERSION` is `0.4.0`. This is a new feature on top of
0.3.0, so the next minor release; this work doesn't bump `package.json`, the release commit does.
The "equal to the CLI's own `VERSION`" exemption is for development: `init --tarball` from this
branch records 0.3.0, the same version the CLI reports, so the containers can be tested end to end
before release. The one case it lets through wrongly (this branch's CLI against a released 0.3.0
service) fails at `audit dump` as an unknown command, which `readAuditLog` reports as
`couldn't read the log from the container: <stderr>` with exit 1. Ugly but harmless, and it can't
happen once 0.4.0 is out.

## Uninstall and init

- `uninstall` with purge removes the log too. Containers already drop the volume. The systemd
  target's `remove(record, true)` also deletes `audit.jsonl` and `audit.jsonl.1` next to the config
  file. The purge question becomes "Also delete the saved credentials, paired owner and question
  log?".
- Without purge the log stays, and a later `init` on the same target keeps appending to it (same
  config directory, same volume).
- `init` replacing an install on the same target keeps the log, since the volume and config dir
  survive.

## Docs

README:

- `telegram-ask log` in the Commands list and its own short section with the example table.
- Where the file lives per target, the 10 MiB rotation, and how to delete it by hand.
- Security: the log keeps question text on disk (mode 0600, or inside the data volume); agents
  sometimes put secrets in questions.
- The uninstall bullet mentions the log.

No OpenAPI change; the HTTP API is untouched.

## Fitting with the other 2026-10-19 specs

Several sibling specs written the same day (uncommitted, in this directory) touch the types the log
records. Decision (made without user input): this design doesn't depend on build order. It works
on today's code and stays correct whichever of them lands first, because the record format and the
reader are open where those specs widen things:

- bot-commands adds a `rejected` settlement (from `/cancel`), with an `answer`. The writer records
  it like any other kind; the reader shows `rejected: <answer>`. Whoever builds second can give it
  a friendlier label in the formatter (`Decline (rejected)`), but nothing is lost before then.
  Its `/history` is in-memory and separate; making it read this log is out of scope here.
- free-text-replies adds a `replied` settlement and text-only questions. `options: []` is valid in
  the `asked` record and the typed answer goes in `answer`, cut in the table (above) and in full in
  `--json`. Typed answers can hold secrets too; the file mode covers that.
- restart-safe-state edits orphaned requests to an "expired" line at startup, through a type wider
  than `Settlement`. If it lands, its startup recovery should also call the sink's `settled` with
  outcome `expired` for each orphan, so the log shows `expired` instead of the reader's
  `interrupted` guess. Until then, `interrupted` covers the same case. The sink's `settled` should
  therefore take a value with at least `kind` and an optional `answer`, not strictly `Settlement`,
  so that spec can reuse it; exact typing is the builder's call.
- attachments changes the request shape. Decision (made without user input): the log records an
  attachment, if present, only by its file name (`attachment` field, omitted otherwise), never its
  bytes. Whoever builds second adds the field; old readers keep it as an unknown field.

## Code conventions

Decision (made without user input): the repo's conventions win over the global TypeScript rules
where they differ. New code follows what `src/` does today: free functions plus classes with
`#private` fields where state is needed (like `NotificationService`), `ok`/`kind` result unions,
zod for parsing, single quotes, no semicolons, tests in `vite-plus/test`. From the global rules,
keep what the repo already agrees with: `readonly` types, omitted optional fields, exhaustive
`switch` on closed `kind` unions (the open `outcome` string gets known cases plus a default),
`<what> <quoted value> <problem>` error messages, missing file as a normal state.

## Testing

Matching the repo: `vite-plus/test`, tests under `test/<module>/`, real files in a `mkdtemp`
directory, fake `Exec` for targets as `test/install/*.test.ts` already do, injected clocks.

- `AuditLog`: writes the two event shapes exactly; creates the file 0600 and the directory;
  rotation at the size cap (old content ends up in `.1`, older `.1` replaced); an unwritable path
  doesn't throw and reports through `log`.
- `ApprovalService` with a fake sink: `asked` after a successful send only, `settled` for each of
  answer, timeout and abort, `settled` recorded even when `finalize` throws, no events on send
  failure.
- Parser: `/request` with a project keeps project and bare text for the log and the same combined
  text for Telegram.
- Reader and formatter: merging across `.1` and current, all five statuses plus an unknown outcome
  (shown, not dropped), `options: []` accepted, `--since` forms,
  `--project`, the limit defaults, bad and unknown-version lines counted, a trailing partial line
  ignored, empty and missing files.
- Targets: `readAuditLog` for each target issues the expected commands, including the quadlet
  fallback and the too-old path.
- CLI: `log` argument errors exit 2.

## Left to the builder

- Names of the new fields on `ApprovalRequest`, the sink's exact method signatures, and whether
  `ApprovalService` moves to an options object.
- How `log`'s dependencies are injected (follow `runStatus` and `StatusDeps`).
- Column padding details and how the table handles very long project names beyond the cap.
- Whether `audit dump` streams the files or reads them whole (either is fine at 20 MiB).
- Exact wording of messages other than the ones quoted above.
