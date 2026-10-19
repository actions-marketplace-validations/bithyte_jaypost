# Claude Code hook mode: design

Source: autonomous brainstorming run on 2026-10-19, with no owner available to answer questions.
Every call that would normally go to the owner is marked "Decision (made without user input)".
Builds on the shipped HTTP API, `telegram-ask mcp` and `telegram-ask send`; what those do stays as
it is unless this doc says otherwise.

Hook contract facts below come from the Claude Code docs as of this date:
<https://code.claude.com/docs/en/hooks> and <https://code.claude.com/docs/en/hooks-guide>. Facts
the docs don't state are marked "unverified" and the builder checks them first (see
[Verify first](#verify-first)).

## Intent

Today an agent reaches the owner's phone only if it decides to call `ask_for_permission`. Claude
Code's own permission prompts (run this Bash command, edit this file, fetch this URL) still wait in
the terminal, so a session the owner walked away from just sits there. The request: a
`telegram-ask hook` subcommand that Claude Code runs as a `PermissionRequest` and `Notification`
hook, so those prompts go to the phone automatically and the owner taps Allow or Deny from
wherever they are. The agent doesn't have to know telegram-ask exists.

## Goals

- `telegram-ask hook` reads one Claude Code hook event as JSON on stdin and handles it:
  - `PermissionRequest`: asks the owner on Telegram via `POST /request`, then writes Claude Code's
    decision JSON on stdout (allow, deny) or nothing (let the terminal dialog handle it).
  - `Notification`: forwards the message via `POST /notify` and writes nothing.
- One command for both events; it dispatches on `hook_event_name`.
- Fails open to the terminal: any failure (service down, not paired, bad input, timeout) leaves the
  normal Claude Code permission flow unchanged. It never denies on its own.
- The owner can tell which project and which agent is asking.
- A README section with the `settings.json` snippet to install it.

## Non-goals

- Answering `AskUserQuestion` from the phone. The docs say a plain "allow" isn't enough for it and
  that answering needs `updatedInput.answers`; whether that works through `PermissionRequest` is
  unverified, and multi-select and "Other" free text don't map to buttons cleanly. The hook passes
  it through untouched. Decision (made without user input).
- Free-text deny reasons. Buttons only, as everywhere else in telegram-ask.
- Editing the tool input from the phone (`updatedInput` for anything but pass-through).
- Writing to the owner's Claude Code settings. No `init` step or `hook install` command touches
  `~/.claude/settings.json`; the README shows the snippet and the owner pastes it. Decision (made
  without user input).
- Detecting whether the owner is at the keyboard ("away mode"). The owner turns the hook on or off
  in settings.
- Reading the transcript (`transcript_path`) to add context such as the last assistant message.
- `PreToolUse` mode. `PermissionRequest` only fires when Claude Code would actually ask, which is
  exactly the set of prompts the owner wants routed.
- Exporting any of this from the package's Node entry (`src/index.ts`).
- Any change to the HTTP API or the service. The hook is a client like `mcp` and `send`.

## Anti-goals

- A hook that denies a tool call because of its own failure. Errors and timeouts must fall through
  to the terminal dialog (or, in `-p` mode, to Claude Code's own "no decision means deny", which is
  Claude Code's rule, not ours).
- A live question with buttons left in Telegram after the call is settled elsewhere. When Claude
  Code kills the hook, the request is cancelled so the message flips to the "cancelled" line.
- Anything on stdout except the one decision JSON object. Claude Code parses stdout; logs go to
  stderr.
- Reading `config.json` or the bot token. Same rule as `mcp`.
- A message that leaks unbounded tool input to Telegram (huge `Write` contents). Text is truncated
  to a fixed budget.

## Claude Code contract (from the docs)

Common stdin fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`,
and `agent_id` / `agent_type` when the hook fires inside a subagent.

`PermissionRequest`:

- Fires when Claude Code is about to ask for permission to use a tool. Also fires for subagents and
  in `-p` mode; there, if no hook decides, the call is denied.
- Extra stdin fields: `tool_name`, `tool_input` (object), optional `mcp_server` for MCP tools,
  optional `permission_suggestions` (array of permission update entries such as
  `{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }],
  "behavior": "allow", "destination": "localSettings" }`).
- Decision on stdout, exit 0:

  ```json
  { "hookSpecificOutput": { "hookEventName": "PermissionRequest",
      "decision": { "behavior": "allow" } } }
  ```

  `allow` may carry `updatedPermissions` (array of permission update entries). `deny` may carry
  `message` (shown to Claude) and `interrupt`. Deny rules still win over a hook's allow.
- Exit 0 with no stdout, exit 2, any other non-zero exit, or a timeout: no decision, normal flow.
- Matcher matches tool names, same as `PreToolUse` (`Bash`, `Edit|Write`, `mcp__.*`); omitted
  matches all.
- Default command hook timeout is 600 s; `timeout` in seconds on the hook entry changes it. A
  timed-out hook is cancelled and its output discarded.

`Notification`:

- Extra stdin fields: `message`, optional `title`, `notification_type`. Types include
  `permission_prompt` (a permission prompt has waited about 6 s), `idle_prompt` (finished
  responding about 60 s ago), `auth_success`, `elicitation_dialog`, `agent_needs_input`,
  `agent_completed` and a few more.
- Matcher matches `notification_type`; omitted matches all.
- Output and exit code are ignored. Side effects only.

Unverified, see [Verify first](#verify-first): whether the terminal dialog shows while the
`PermissionRequest` hook is still running, and how Claude Code stops a hook it no longer needs.

## The command

```
telegram-ask hook [--port N] [--project NAME] [--timeout S]
```

- `--port`: as `mcp` and `send`, via `resolveMcpPort`: flag, then `PORT`, then `install.json`, then
  8787. Host is always `127.0.0.1`.
- `--project`: the `[name]` line. Default: basename of `$CLAUDE_PROJECT_DIR`, else basename of the
  input's `cwd`, else `claude`. Truncated to 100 characters (`MAX_PROJECT_LENGTH`). Decision (made
  without user input).
- `--timeout`: seconds to wait for a tap on a `PermissionRequest`. Default and max 300, same as the
  API; parsed with the CLI's existing `parseTimeout`. Ignored for `Notification`.
- No positional arguments. The event comes from stdin only.

Install snippet for the README (user or project `settings.json`):

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "telegram-ask hook", "timeout": 360 }] }
    ],
    "Notification": [
      {
        "matcher": "idle_prompt|elicitation_dialog|agent_needs_input",
        "hooks": [{ "type": "command", "command": "telegram-ask hook" }]
      }
    ]
  }
}
```

- `PermissionRequest` has no matcher, so every prompt goes to the phone. The README shows narrowing
  it (`"matcher": "Bash|Edit|Write"`) as an option. Decision (made without user input).
- `timeout: 360` is the 300 s wait plus the 30 s HTTP grace plus slack, so Claude Code doesn't kill
  the hook before the service answers. The 600 s default would also work; the explicit value
  documents the relationship.
- The `Notification` matcher leaves out `permission_prompt`, which would duplicate the question the
  `PermissionRequest` hook already sent (our hook usually takes longer than the 6 s after which
  that notification fires). Decision (made without user input).
- `npx -y telegram-ask hook` for owners without the package on `PATH`, with a note that npx adds
  startup time to every prompt.
- README note: hooks inherit Claude Code's environment, so a `PORT` meant for the owner's own app
  (say `PORT=3000`) would point the hook at the wrong port. Pass `--port` in that case. Kept
  consistent with `mcp` and `send` rather than special-cased. Decision (made without user input).

## Flow

1. Read all of stdin, parse JSON, validate with zod (the repo's validator). Keep unknown fields;
   only check what the hook uses: `hook_event_name` string, and per event the fields below.
2. Dispatch on `hook_event_name`:
   - `PermissionRequest`: see below.
   - `Notification`: see below.
   - anything else: stderr `telegram-ask: unsupported hook event "<name>"`, exit 1.
3. Write at most one line to stdout, then exit.

### PermissionRequest

Validated fields: `tool_name` string, `tool_input` object, optional `permission_suggestions`
array, optional `mcp_server`, `agent_type`, `cwd`.

- `tool_name === "AskUserQuestion"`: exit 0, no output (see Non-goals).
- Otherwise build the question (see [Message format](#message-format)) and `POST /request` with
  `project`, `text`, `options`, `timeoutOption` and `timeout`.

Buttons, in this order. Decision (made without user input) on all of them:

| Button           | Shown when                              | Result                                              |
| ---------------- | --------------------------------------- | --------------------------------------------------- |
| `Allow`          | always                                  | `allow`                                             |
| `Always allow`   | `permission_suggestions` is non-empty   | `allow` with `updatedPermissions` = the suggestions |
| `Deny`           | always                                  | `deny` with `message` (below), no `interrupt`       |
| `Ask in terminal`| always                                  | no output, exit 0                                   |

- `timeoutOption` is `Ask in terminal`, so the final Telegram line reads "Timed out, Ask in
  terminal", which is what actually happens. On `timedOut: true` the hook writes nothing and exits
  0 regardless of the answer text.
- `Always allow` passes `permission_suggestions` through unchanged, unknown fields included; the
  hook doesn't invent rules. That mirrors the terminal's "don't ask again" choice, including its
  `destination` (often `localSettings`, so it persists).
- Deny `message`: `the owner denied this from telegram-ask`. Claude sees it and can adapt. Exact
  wording left to the builder.
- Answer text that isn't one of the buttons (shouldn't happen): stderr, exit 1, no decision.

### Notification

Validated fields: `message` string, optional `title`, optional `notification_type`, optional
`agent_type`.

`POST /notify` with `project` and the text from [Message format](#message-format). Exit 0 on
success, exit 1 with stderr on failure (Claude Code ignores both; the stderr helps when debugging
with `claude --debug`). The command itself doesn't filter by type; the matcher does.

## Message format

Plain text, as all telegram-ask messages are (the adapter sends no parse mode). The service adds
the `[project]` line. The hook builds the rest. Rough shape, exact wording left to the builder:

```
Claude wants to run Bash:
npm test -- --watch=false
Run the unit tests

Always allow adds: Bash(npm test:*)
```

- First line: `Claude wants to use <tool>:` or a tool-specific verb. With `agent_type`, say which
  agent: `Claude (subagent Explore) wants to ...`.
- Body per tool, a summary of `tool_input` rather than the raw JSON:
  - `Bash`: `command`, then `description` if present.
  - `Edit`, `MultiEdit`, `Write`, `NotebookEdit`: the file path (relative to `cwd` when inside it),
    then a short preview of the new text.
  - `Read`, `Glob`, `Grep`: path or pattern.
  - `WebFetch`: `url`. `WebSearch`: `query`.
  - `ExitPlanMode`: the plan text if a `plan` string is present in `tool_input`.
  - MCP tools (`mcp__<server>__<tool>`): server and tool name, then the input as JSON.
  - Anything else: `JSON.stringify(tool_input, null, 2)`.
- When `Always allow` is offered, one line describing what it adds: `addRules` entries as
  `<toolName>(<ruleContent>)`, `setMode` as `switches to <mode> mode`, other types by their `type`.
- Truncation: the whole hook-built text is capped at 3000 characters, never cutting the first line
  or the "Always allow" line, and marking any cut with `…`. 3000 plus the 100-character project
  line stays under Telegram's 3900. The hook can't read the provider's limit without
  `config.json`, so it uses this fixed budget. Decision (made without user input).
- Each tool family has one primary field, the thing actually being approved: the Bash `command`,
  the file path for edits and writes, the `url`, the `query`, the plan, the MCP or generic input
  JSON. Secondary parts (Bash `description`, edit and write previews) are cut first; the primary
  field is cut last. Decision (made without user input).
- If the primary field itself had to be cut, the owner can't see everything they'd approve, so the
  question drops `Allow` and `Always allow` and offers only `Deny` and `Ask in terminal`, with a
  line like `Too long to show in full; answer in the terminal to allow it.` The formatter decides
  this; the result it returns (`{ text, options }`) already carries the reduced buttons, so callers
  need no extra flag. Previews are labeled as previews and don't trigger this. Decision (made
  without user input).
- Notification text: `title`, a blank line, `message` when `title` is present and differs from
  `message`; otherwise `message`. Prefixed with the subagent name the same way when `agent_type` is
  present. Same 3000 cap.

## Errors and exit codes

| Situation                                     | stdout   | stderr                         | exit |
| --------------------------------------------- | -------- | ------------------------------ | ---- |
| Allow, Always allow, Deny                     | decision | nothing                        | 0    |
| Ask in terminal, timed out, `AskUserQuestion` | nothing  | nothing                        | 0    |
| Notification sent                             | nothing  | nothing                        | 0    |
| stdin not JSON, missing fields, unknown event | nothing  | `telegram-ask: <reason>`       | 1    |
| Service failure (any `postApi` failure)       | nothing  | `telegram-ask: <message>`      | 1    |
| Killed by SIGTERM or SIGINT                   | nothing  | nothing                        | 1    |
| Bad flags                                     | nothing  | commander's usage error        | 2    |

- Exit 1, not 2, for failures. For `PermissionRequest` both leave the flow unchanged, but exit 2
  discards stderr, and the stderr is the only trace of why the phone stayed silent.
- Bad flags exit 2 like every other command; Claude Code treats that as "no decision" too, so it's
  harmless.
- Service failure messages come from `postApi` unchanged (not reachable, not paired, couldn't
  send, too old), so they read the same as in `send` and `mcp`.
- No retries; a retried `/request` would send a second question.

## Cancellation

- SIGTERM and SIGINT abort the in-flight `/request`. The service sees the connection close and
  edits the message to the "cancelled" line (existing behavior). The CLI's `runWithSigint` only
  listens for SIGINT today; the hook needs SIGTERM as well. Whether that's a widened helper or a
  hook-local one is left to the builder.
- If Claude Code exits without killing the hook, the question stays live until its own timeout and
  then flips to "Timed out". Watching the parent process is out of scope.
- If the dialog runs alongside the hook and the owner answers in the terminal without Claude Code
  signalling the hook at all, the hook has no way to know: there's no channel from Claude Code to a
  running hook, and polling the transcript would be a guess against a file the docs say may lag.
  The phone question stays live until its timeout. That's harmless for correctness (Claude Code
  already decided, and a later tap's output is discarded since the first decision applies), just
  noisy. Decision (made without user input): document it as a known issue in the README, with the
  tip that a shorter `--timeout` (say 120) shortens how long such a question lingers. No watchdog,
  no transcript polling.

## Verify first

Before planning the rest, the builder runs a throwaway check against the real Claude Code (a
`PermissionRequest` hook that logs to a file and sleeps) to settle these. The plan depends on the
answers:

1. Does the terminal permission dialog show while the hook runs, or only after it returns? The SDK
   docs say "whichever decides first applies", and the `permission_prompt` notification is skipped
   "if you or a PermissionRequest hook answer sooner", which suggests concurrent. If it's
   concurrent: answering in the terminal should stop the hook, see 2. If it's blocking: the owner
   at the keyboard waits for a tap, `Ask in terminal` or the timeout. In that case don't redesign;
   say so prominently in the README next to the snippet ("while the hook is on, prompts wait for
   your phone first; tap Ask in terminal to answer at the keyboard"). Decision (made without user
   input).
2. When the dialog is answered in the terminal (or the session ends), does Claude Code signal the
   hook, and with what? If it sends SIGTERM or SIGKILL, record which. SIGKILL can't be caught, so
   the Telegram message would stay live until its timeout; note that as a known issue in the
   README rather than adding a watchdog. Decision (made without user input).
3. Does `ExitPlanMode` arrive with the plan text in `tool_input`, and under what key? If not,
   it falls back to the generic JSON body.
4. Does a timed-out or killed hook in a subagent behave like the main session (no decision,
   dialog shown)?

Record the findings in the plan and in the README where they affect users.

Who runs it, and how it fits the plan. Decision (made without user input):

- The code doesn't depend on the answers. SIGTERM and SIGINT handling, the four buttons, fail-open
  exits and the formatter are built the same either way (signal handling is needed for Ctrl-C
  anyway). Only the README text and the `ExitPlanMode` body branch on the findings.
- So the plan is linear for the code and puts the README section last. The builder tries the check
  itself first (an interactive `claude` session driven through `tmux`, with a logging, sleeping
  hook). If it can't observe the dialog reliably, the plan turns that step into a checkpoint for
  the owner, with exact steps to run, and the README task waits on it. No other task waits.

## How it gets made

Follows the repo's conventions, which differ from the owner's general TypeScript rules in a few
places (functions instead of `<Module><Role>` classes, commander instead of `parseArgs`, zod for
parsing, vite-plus test with `expect`). Match the repo.

- New module `src/hook/`, shaped like `src/mcp/`:
  - `types.ts`: parsed event types as a discriminated union on the event name, the decision type,
    the hook deps type.
  - `constants.ts`: button labels, the 3000 text budget, the deny message, the default project.
  - `parser.ts`: zod schemas and `parseHookEvent(raw: string)`, returning a `kind`-tagged result
    (`parsed` / `invalid` with a message), never throwing.
  - `formatter.ts`: pure functions from a parsed event to `{ text, options }`, and from an answer
    to the stdout JSON (or none). No I/O, so most tests live here.
  - `runner.ts` (or `hook.ts`): `runHook(args, deps): Promise<number>`, the edge. Deps injected the
    way `SendDeps` does it: `port`, `signal`, `readInput: () => Promise<string>`, `print`,
    `printError`, `env` for `CLAUDE_PROJECT_DIR`.
  - `index.ts`: named re-exports for `cli.ts` and tests.
- `src/cli.ts`: `program.command('hook')` with the three options, wired like `send request`.
- Uses `postApi`, `isOutcome`, `toFetchTimeoutMs`, `FETCH_GRACE_MS` from `src/client/` and
  `MAX_PROJECT_LENGTH`, `MAX_TIMEOUT_SECONDS` from `src/approval/`. No imports from provider,
  telegram or config-secret code.
- README: a "Claude Code hook" section after "Agents (MCP)", the command in the Commands list, and
  the findings from [Verify first](#verify-first).

## Tests

- Formatter: one case per tool family above, the subagent prefix, the `Always allow` line per
  suggestion type, truncation keeps the first line and the suggestion line, secondary parts cut
  before the primary field, a cut primary field leaves only `Deny` and `Ask in terminal`,
  notification with and without `title`.
- Decision mapping: each button to its exact stdout JSON (whole-object `toEqual`), `Always allow`
  passes suggestions through with unknown fields intact, timed out maps to no output whatever the
  answer.
- Parser: valid events of both kinds, unknown fields kept, missing `tool_name`, non-object
  `tool_input`, not JSON, unknown event.
- `runHook` against the real `createApiServer` with a recording messenger and notifier, like
  `test/commands/send.test.ts`: the body sent to `/request` and `/notify` (project, text, buttons,
  timeout option, timeout), answered and timed-out paths, service down gives exit 1 with the
  not-reachable message and no stdout, `AskUserQuestion` sends nothing.
- Project resolution: flag, then `CLAUDE_PROJECT_DIR`, then `cwd`, then `claude`; long names
  truncated.
- Spawned CLI, one or two cases: pipe an event into `node src/cli.ts hook --port <p>`, check stdout
  is exactly one JSON line; send SIGTERM mid-wait and check the service saw the request cancelled.
- `test/cli.test.ts`: `hook --port abc` and `hook --timeout 0` exit 2.

## Other specs from the same day

Several sibling specs dated 2026-10-19 sit next to this one, all unbuilt. This doc plans against
the shipped 0.3.0 code and doesn't depend on any of them. Where they'd touch the hook once landed:

- Local auth token: the hook is one more client. It should find and send the token by the same rule
  `mcp` and `send` use under that spec, with no hook-specific lookup.
- Bot commands: `/cancel` settles open requests with their timeout option, which for the hook is
  `Ask in terminal`, so it maps to no decision and the terminal dialog. Correct as is.
- Message formatting: once it lands, the Bash command and previews could go in code blocks. Not part
  of this build.
- Free-text replies and quiet hours don't affect hook requests (no `allowText`, and quiet hours
  only silence notifications). Quiet hours would silence the hook's `Notification` forwards, which
  seems right.

## Left to the builder

- Exact message wording and per-tool body layout, within the format above.
- Preview length for edits and writes, inside the 3000 budget.
- Whether the SIGTERM handling widens `runWithSigint` or stays hook-local.
- File names inside `src/hook/`.
- Deny message wording.

## Decisions made without user input

- `AskUserQuestion` is passed through, not answered from the phone.
- No command or `init` step writes Claude Code's settings; README snippet only.
- Buttons: `Allow`, `Always allow` (only with suggestions), `Deny`, `Ask in terminal`; timeout
  option is `Ask in terminal`, and a timeout writes no decision.
- `Always allow` forwards `permission_suggestions` unchanged as `updatedPermissions`.
- Deny carries a fixed message and never sets `interrupt`.
- Every failure exits 1 with stderr and no decision; never exit 2 for failures, never deny on
  error.
- Project name: `--project`, then basename of `CLAUDE_PROJECT_DIR`, then of `cwd`, then `claude`.
- Port resolution kept identical to `mcp` and `send`, `PORT` hazard documented, not special-cased.
- Suggested `PermissionRequest` hook has no matcher; suggested `Notification` matcher is
  `idle_prompt|elicitation_dialog|agent_needs_input`, leaving out `permission_prompt`.
- Suggested hook `timeout` is 360 s.
- Hook-built text capped at a fixed 3000 characters instead of reading the provider limit.
- If the dialog turns out to block while the hook runs, document it; don't redesign.
- If Claude Code SIGKILLs the hook, document the lingering message; no watchdog.
- No API or service changes; no Node export.
- Truncation cuts secondary parts first; if the primary field (command, path, URL, input) is cut,
  only `Deny` and `Ask in terminal` are offered.
- A terminal answer that never signals the hook leaves the phone question live until timeout;
  documented with a shorter `--timeout` tip, no watchdog or transcript polling.
- Verify-first is tried by the builder via `tmux`, falling back to an owner checkpoint that only the
  README task waits on.
