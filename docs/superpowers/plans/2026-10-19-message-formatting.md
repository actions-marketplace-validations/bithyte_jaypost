# Message Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in `format: "markdown"` on `POST /request`, `POST /notify`, both MCP tools, the Node `Client` and `send`, rendered by a small conservative parser into plain text plus spans that Telegram receives as `entities`.

**Architecture:** A new pure module `src/format/` turns source text into `FormattedText` (`{ text, spans }`). Approval and notify parsing build a `FormattedText` from `text` + `format`, check the limit on the rendered text, and pass it through the provider contract instead of a string. The Telegram adapter maps spans to `entities` (never `parse_mode`), fixes Telegram's nesting rules, and on a 400 retries once without entities.

**Tech Stack:** Node 24 (runs `.ts` directly), zod 4, Fastify 5, grammY, MCP SDK, commander, vite-plus (`vp test` with the vitest API, `vp check` for fmt and lint), TypeScript 7 (`tsc` for types only).

**Spec:** `docs/superpowers/specs/2026-10-19-message-formatting-design.md`. Read it before each task; this plan doesn't repeat its reasoning. The spec was written against 0.3.0; the repo is now 0.4.0 (restart-safe state, hook mode, quiet hours). Where they differ, this plan says what to do.

## Global Constraints

- Never use em-dashes anywhere: code, comments, tests, README, changeset, commit messages.
- Commits: conventional, lowercase summary (`feat:`, `refactor:`, `docs:`). No `Co-Authored-By` trailer or any Claude/Anthropic attribution.
- Repo style wins over the global TS rules: exported functions with JSDoc (no `<Module><Role>` classes), single quotes, no semicolons, width 100, `vite-plus/test` with flat `test(...)`, tests import from `src/<module>/index.ts`. Where the repo is silent: `type` only, `readonly` fields, explicit return types, full-word names, regexes end in `_PATTERN`, "Never throws" in JSDoc for data APIs.
- Plain mode is byte-identical to today: same text (no trim, no CRLF change), same Telegram call options (no `entities` key), same error messages.
- `src/format/` is pure and imports nothing outside itself (no zod): `src/index.ts` re-exports from it into the CJS library build.
- Offsets and lengths are UTF-16 code units (JS string indices). Shorthand in this plan: `code 4/2` means `{ kind: 'code', offset: 4, length: 2 }`; `pre 0/5 language diff` adds `language: 'diff'`.
- Exact copy: `format must be "plain" or "markdown"`; `text must not be blank after formatting`; `text must be at most N characters after formatting` (markdown only); log line `telegram rejected formatting, sent as plain text: <description>`.
- Hook mode (`src/hook/`) stays plain. It isn't in the spec; don't change it.
- Setup: the worktree has no `node_modules`; run `npm ci` once before Task 1.
- Verification after every task: `npx tsc -p tsconfig.json` exits 0, `npx vp check` green, `npx vp test` green. A task that changes a shared type updates every caller and fixture in the same task.

## Review Focus

1. A request pending across a restart: the expired edit must keep its formatting, and a 0.4.0 state file (records without `spans`) must still load. Tests in Task 4.
2. Markdown that renders to whitespace only (`` `   ` ``, a code span of spaces) must be a 400, not a Telegram "message text is empty" 502. Test in Task 5.
3. Markup in `project` (`project: "**x**"` with markdown) must stay literal in the `[project]` line, with every span shifted past it. Test in Task 5.
4. `/pending`, `/cancel` and `/history` summaries of a markdown request must show the rendered text (no backticks), cut at 80 without splitting a surrogate pair. Test in Task 4.
5. A Windows-edited diff (CRLF lines, closing fence with trailing spaces) must close the fence and keep the diff lines verbatim. Test in Task 2.

---

### Task 1: `src/format/` types and inline rules

**Files:**
- Create: `src/format/types.ts`, `src/format/constants.ts`, `src/format/inline.ts`, `src/format/parser.ts`, `src/format/index.ts`
- Test: `test/format/parser.test.ts`

**Interfaces:**
- Produces:
  - `type MessageFormat = 'plain' | 'markdown'`
  - `type Span` and `type FormattedText` exactly as in the spec's "Data shapes" (`pre` is its own union member with `readonly language?: string`; the other five share one member)
  - constants `MESSAGE_FORMATS = ['plain', 'markdown'] as const`, `DEFAULT_FORMAT = 'plain'` (typed `MessageFormat`), `LANGUAGE_PATTERN = /^[A-Za-z0-9_+#.-]{1,32}$/`, `ESCAPABLE_CHARACTERS` (the CommonMark ASCII punctuation set from the spec, as a string)
  - `parseMarkdown(source: string): FormattedText` in `parser.ts`. Never throws.
  - `index.ts` re-exports `parseMarkdown`, `MESSAGE_FORMATS`, `DEFAULT_FORMAT`, types `MessageFormat`, `Span`, `FormattedText`

In this task every line is a normal line (block rules come in Task 2). `parseMarkdown` splits on `\n`, runs each line through the inline scanner, joins the outputs with `\n` (shifting each line's spans by the running offset), then trims the edges: leading whitespace (JS `\s`, same as `String.prototype.trim`) is removed only up to the first span's offset, trailing only back to the largest span end; all spans shift by the leading amount.

Suggested inline structure (in `inline.ts`): first tokenize the line left to right into literal characters (each flagged `escaped` or not) and code spans (backslash escapes and backtick runs handled here, so emphasis never sees inside code); then run emphasis over the token list as a segment, recursing into each emphasis content as its own segment. Only unescaped `*` and `~` literal tokens can be delimiters. Spans with length 0 are dropped. At an opener position, `**` is tried first; if it finds a closer, that decides the position (empty content makes both `*` literal and scanning moves past them), and `*` is tried only when `**` has no closer. That's what keeps `****` literal.

- [ ] **Step 1: Write the failing tests**

Helpers at the top of `test/format/parser.test.ts`:

```ts
function expectValidSpans(result: FormattedText): void
// sorted by offset (outer first on ties: longer length first), length > 0,
// offset + length <= text.length, any two spans either disjoint or nested,
// no span inside a code or pre span
const UNCHANGED = (source: string) => ({ text: source, spans: [] })
```

Call `expectValidSpans` on every result in this file.

Tests (`expect(parseMarkdown(source)).toEqual(expected)`):

| test name | source | expected |
| --- | --- | --- |
| inline code | ``'Run `rm -rf build`?'`` | `{ text: 'Run rm -rf build?', spans: [{ kind: 'code', offset: 4, length: 12 }] }` |
| bold and italic | `'**Deploy** to *prod*'` | text `'Deploy to prod'`, `bold 0/6`, `italic 10/4` |
| strikethrough | `'~~old~~ new'` | text `'old new'`, `strikethrough 0/3` |
| anti-goal strings stay literal (`test.each`) | `'snake_case_name and 2*3*4'`, `'__init__.py and _private_'`, `'**/*.ts and *.js'`, `'rm -rf /tmp/* and src/**/*.ts'`, `'a_b_c'`, `'x * y * z'`, `'*args and **kwargs'`, `'_x_ and __x__'`, `'****'`, `'* item\n* item'` | `UNCHANGED(source)` |
| backslash escape | `'\\*not italic\\*'` | `UNCHANGED('*not italic*')` |
| backslash before non-punctuation stays | `'C:\\dir a\\b'` | `UNCHANGED('C:\\dir a\\b')` |
| code with inner backtick | ``'`` a ` b ``'`` | text ``'a ` b'``, `code 0/5` |
| code is verbatim | ``'`**x** a\\*b`'`` | text `'**x** a\\*b'`, `code 0/10` |
| unmatched backticks are literal | ``'a `b'`` | `UNCHANGED` |
| code inside bold | ``'**run `ls` now**'`` | text `'run ls now'`, `[bold 0/10, code 4/2]` |
| emoji offsets | ``'😀 `x`'`` | text `'😀 x'`, `code 3/1` |
| markers at word edges with punctuation | `'**Deploy**.'`, `'(*note*)'`, `'"**yes**"'` | `'Deploy.'` bold 0/6; `'(note)'` italic 1/4; `'"yes"'` bold 1/3 |
| emphasis doesn't cross lines | `'**a\nb**'` | `UNCHANGED` |
| lines and blank lines are kept | `'a\n\n  b'` | `UNCHANGED` |
| edges are trimmed | `'  hi  \n'` | `UNCHANGED('hi')` |
| code at the edge keeps its spaces | ``'`  x  `'`` (content `'  x  '` starts and ends with a space, so one is stripped from each end) | text `' x '`, `code 0/3` |

- [ ] **Step 2: Run to verify they fail**

Run: `npx vp test test/format/parser.test.ts`
Expected: FAIL, cannot resolve `src/format/index.ts`.

- [ ] **Step 3: Implement the types, constants and `parseMarkdown` (inline rules only)**

Follow the spec's "Inline rules" exactly: escape set, CommonMark code span stripping, `**` tried before `*`, opener/closer word-edge rules with the `([{"'` and `.,:;!?)]}"'` runs, nearest valid closer, empty content literal, `_` never a marker.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vp test test/format/parser.test.ts`, then the three global checks.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format test/format
git commit -m "feat: markdown subset parser, inline rules"
```

---

### Task 2: block rules

**Files:**
- Modify: `src/format/parser.ts`, `src/format/constants.ts` (fence, heading and blockquote line patterns)
- Test: `test/format/parser.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseMarkdown` and inline scanner.
- Produces: no new exports; `parseMarkdown` now applies the spec's block rules.

Model: each source line maps to zero or one output line; fence lines map to zero. Output lines join with `\n`. Normalize `\r\n` and lone `\r` to `\n` first. Block order per line: fence, heading, blockquote run, normal line. A `pre` span covers the joined content lines (no trailing newline), with `language` only when the info string's first word matches `LANGUAGE_PATTERN`; omit the key otherwise. A backtick fence whose info string contains a backtick isn't a fence.

- [ ] **Step 1: Write the failing tests**

| test name | source | expected |
| --- | --- | --- |
| fenced diff | `` '```diff\n-a\n+b\n```' `` | text `'-a\n+b'`, `[{ kind: 'pre', offset: 0, length: 5, language: 'diff' }]` |
| unclosed fence runs to the end | `` '```\nunclosed' `` | text `'unclosed'`, `pre 0/8` (no `language` key) |
| empty fence is blank | `` '```\n```' `` | `{ text: '', spans: [] }` |
| tilde fence | `'~~~sh\nls\n~~~'` | text `'ls'`, pre 0/2 language `sh` |
| longer fence holds a shorter one | `` '````md\n```\nx\n```\n````' `` | text `` '```\nx\n```' ``, pre 0/9 language `md` |
| indented fence (`test.each` over 1 to 3 spaces) | `` ' '.repeat(n) + '```\nx\n' + ' '.repeat(n) + '```' `` | text `'x'`, pre 0/1 |
| four spaces isn't a fence | `` '    ```\nx' `` | `UNCHANGED('```\nx')` |
| invalid language is dropped | `` '```c<>\nx\n```' `` | text `'x'`, pre 0/1, no `language` |
| fence content is verbatim | `` '```\n  **x** `y` \\*\n```' `` | text `` '  **x** `y` \\*' ``, one pre span over all of it |
| backtick in info string isn't a fence | `` '```foo```' `` | text `'foo'`, `code 0/3` |
| fence mid-text | `` 'Apply?\n```diff\n-a\n```\nok' `` | text `'Apply?\n-a\nok'`, pre 7/2 language `diff` |
| heading | `'## Plan\nship it'` | text `'Plan\nship it'`, `bold 0/4` |
| heading with closing hashes | `'# Title ##'` | text `'Title'`, bold 0/5 |
| heading with inline code | ``'# Run `ls`'`` | text `'Run ls'`, `[bold 0/6, code 4/2]` |
| not headings (`test.each`) | `'#123 is fixed'`, `'#tag'`, `'####### seven'` | `UNCHANGED` |
| blockquote | `'> quoted\n> more'` | text `'quoted\nmore'`, `blockquote 0/11` |
| blockquote with inline code | ``'> run `ls`'`` | text `'run ls'`, `[blockquote 0/6, code 4/2]` |
| fences aren't recognized in quotes | `` '> ```' `` | text `` '```' ``, blockquote 0/3 |
| CRLF and lone CR | `'**a**\r\nb\rc'` | text `'a\nb\nc'`, bold 0/1 |
| Windows-edited diff (Review Focus 5) | `` '```diff\r\n-a\r\n+b \r\n```  \r\nok' `` | text `'-a\n+b \nok'`, pre 0/6 language `diff` |
| indented first code line keeps its indent | `` '```\n  indented\n```' `` | text `'  indented'`, pre 0/10 |

- [ ] **Step 2: Run to verify they fail**

Run: `npx vp test test/format/parser.test.ts`
Expected: the new tests FAIL (fences and headings come out literal); Task 1 tests still PASS.

- [ ] **Step 3: Implement the block rules in `parseMarkdown`**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vp test test/format/parser.test.ts`, then the three global checks.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format test/format
git commit -m "feat: markdown subset parser, block rules"
```

---

### Task 3: format helpers and package exports

**Files:**
- Create: `src/format/text.ts` (`toFormattedText`, `prependText`, `appendText`), `src/format/escape.ts` (`escapeMarkdown`, `formatCodeBlock`)
- Modify: `src/format/index.ts`, `src/index.ts`
- Modify (only if it lists the package's exports): `test/pack.test.ts`
- Test: `test/format/text.test.ts`, `test/format/escape.test.ts`

**Interfaces:**
- Produces (all re-exported from `src/format/index.ts`):
  - `toFormattedText(text: string, format: MessageFormat): FormattedText`: plain is `{ text, spans: [] }` with `text` untouched; markdown is `parseMarkdown(text)`
  - `prependText(prefix: string, formatted: FormattedText): FormattedText`: every span's offset `+ prefix.length`
  - `appendText(formatted: FormattedText, suffix: string): FormattedText`: spans unchanged
  - `escapeMarkdown(text: string): string`: puts `\` before every `` \ ` * ~ # > ``. Never throws.
  - `formatCodeBlock(code: string, language?: string): string`: `` `${fence}${language ?? ''}\n${code}\n${fence}` `` where `fence` is backticks, one more than the longest backtick run that starts a line of `code` after 0 to 3 spaces, minimum 3. Throws `RangeError` (`language "<value>" must match <pattern source>`, value via `JSON.stringify`) when `language` doesn't match `LANGUAGE_PATTERN`; that's caller misuse.
- `src/index.ts` adds `export { escapeMarkdown, formatCodeBlock } from './format/index.ts'` and `MessageFormat` to the type exports.

- [ ] **Step 1: Write the failing tests**

`test/format/text.test.ts`:
- `plain is untouched`: `toFormattedText('  a\r\n*b*  ', 'plain')` equals `{ text: '  a\r\n*b*  ', spans: [] }`.
- `markdown parses`: `toFormattedText('`ls`', 'markdown')` equals `{ text: 'ls', spans: [code 0/2] }`.
- `prepend shifts spans`: `prependText('[api]\n\n', { text: 'ls', spans: [code 0/2] })` equals `{ text: '[api]\n\nls', spans: [code 7/2] }`.
- `append keeps spans`: `appendText({ text: 'ls', spans: [code 0/2] }, '\n\nok')` equals `{ text: 'ls\n\nok', spans: [code 0/2] }`.

`test/format/escape.test.ts`:
- Helper: a seeded PRNG (mulberry32, fixed seed) that builds strings by picking from `` [...'ab \t\n\\`*~#>_[]()!.😀'] `` (spread, so the emoji stays one pick), lengths 0 to 40.
- `escaped text round-trips with no spans`: for 2000 generated `s`, `parseMarkdown(escapeMarkdown(s))` equals `{ text: s.trim(), spans: [] }`.
- `escapes every marker`: `escapeMarkdown('\\`*~#>_')` is `` '\\\\\\`\\*\\~\\#\\>_' ``.
- `code block round-trips`: for `code` in `['-a\n+b', '```\nx\n```', '  ````inner', 'a\n']`, `parseMarkdown(formatCodeBlock(code, 'diff'))` equals `{ text: code, spans: [pre 0/code.length language 'diff'] }`.
- `fence is longer than the longest leading run`: `formatCodeBlock('````x')` starts with ``'`````\n'``.
- `bad language throws`: `expect(() => formatCodeBlock('x', 'a b')).toThrow(RangeError)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vp test test/format`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement the five functions and the package exports**

- [ ] **Step 4: Run to verify they pass**

Run: `npx vp test test/format`, then the three global checks.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format src/index.ts test/format test/pack.test.ts
git commit -m "feat: markdown escaping and code block helpers"
```

---

### Task 4: `FormattedText` through the core and provider contract

No behavior change: every request is still plain. This task swaps the string for a `FormattedText` end to end so Tasks 5 and 6 only add behavior.

**Files:**
- Modify: `src/approval/types.ts`, `src/approval/formatter.ts`, `src/approval/parser.ts`, `src/approval/service.ts`, `src/approval/commands.ts` (if it reads `request.text`)
- Modify: `src/notify/types.ts`, `src/notify/parser.ts`, `src/notify/service.ts`
- Modify: `src/provider/types.ts`, `src/state/types.ts`, `src/state/schema.ts`
- Modify: `src/telegram/adapter.ts` (send `message.text`; entities come in Task 6)
- Modify: `test/provider/fake.ts` and every test that builds an `ApprovalRequest`/`NotifyRequest` or reads `sent[].text` (tsc lists them: approval, notify, daemon, server, commands/send, mcp, telegram, state)
- Test: `test/approval/formatter.test.ts`, `test/approval/service.test.ts`, `test/approval/commands.test.ts`, `test/state/parser.test.ts`

**Interfaces:**
- Consumes: `FormattedText`, `Span`, `prependText`, `appendText`, `toFormattedText`, `DEFAULT_FORMAT` from `src/format/index.ts`.
- Produces:
  - `ApprovalRequest.message: FormattedText` (replaces `text`); `NotifyRequest = { readonly message: FormattedText }`
  - `Messenger.sendRequest(id: string, message: FormattedText, options: readonly string[])`, `Messenger.finalize?(reference, message: FormattedText, ending: MessageEnding)`
  - `Notifier.sendNotification(id: string, message: FormattedText, options: SendNotificationOptions)`
  - `ProviderRuntime.sendRequest`, `.finalize`, `.sendNotification`: same three signatures
  - `formatProjectText(project: string, message: FormattedText): FormattedText` (`prependText(\`[${project}]\n\n\`, message)`)
  - `formatFinalText(original: FormattedText, ending: MessageEnding, at: Date): FormattedText` (`appendText(original, \`\n\n${formatResultLine(ending, at)}\`)`)
  - `checkProjectText(message: FormattedText, project: string | undefined, maxTextLength: number): { ok: true; message: FormattedText } | { ok: false; error: string }` (limit on `message.text`, messages unchanged; Task 5 adds a `format` parameter)
  - `RequestRecord = { id; reference; text: string; spans?: readonly Span[] }`: `spans` is omitted when empty. `stateFileSchema` accepts an optional `spans` array validated per span (`kind` one of the six, `offset` integer `>= 0`, `length` integer `> 0`, `language` string only on `pre`); a bad span makes the file invalid like any other bad field. `STATE_VERSION` stays 1.
  - `HistoryEntry.text` stays a string: the rendered `message.text`.
  - `FakeRuntime.sent: { id: string; message: FormattedText; options: readonly string[] }[]`

Body schemas build `message` with `toFormattedText(text, DEFAULT_FORMAT)` before `checkProjectText`. `ApprovalService.expireOrphans` finalizes with `{ text: record.text, spans: record.spans ?? [] }`.

- [ ] **Step 1: Write the failing tests**

- `test/approval/formatter.test.ts`, `final text keeps spans and appends a plain result line`: `formatFinalText({ text: 'Run ls', spans: [code 4/2] }, { kind: 'answered', answer: 'Approve' }, new Date(2026, 0, 1, 9, 5))` equals `{ text: 'Run ls\n\n✅ Approve, 09:05', spans: [code 4/2] }`.
- `test/approval/formatter.test.ts`, `summaries show the rendered text` (Review Focus 4): `formatPendingReply` on a summary whose `message` is `toFormattedText('😀'.repeat(50) + ' `x`', 'markdown')` returns a first entry line with no backtick, ending in `…`, with no lone surrogate.
- `test/approval/service.test.ts`, `store records spans only when present`: one request with `message` `{ text: 'Run ls', spans: [code 4/2] }` and one with `spans: []`; the store's `addRequest` records are `{ id, reference, text: 'Run ls', spans: [code 4/2] }` and `{ id, reference, text }` (no `spans` key; check with `Object.hasOwn`).
- `test/approval/service.test.ts`, `expired orphans keep their formatting`: `expireOrphans([{ id: 'r1', reference: 1, text: 'Run ls', spans: [code 4/2] }, { id: 'r2', reference: 2, text: 'old' }])` calls `finalize` with messages whose `spans` are `[code 4/2]` and `[]`, and whose text ends in the expired line.
- `test/state/parser.test.ts`: `a record with spans loads` (spans round-trip); `a 0.4.0 record without spans loads` (no `spans` key in the result); `a bad span invalidates the file` (`kind: 'link'` gives `{ ok: false, reason: 'invalid or missing fields' }`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsc -p tsconfig.json`
Expected: type errors in the new tests (and nowhere else yet).

- [ ] **Step 3: Change the types and signatures above, then fix every caller and fixture tsc reports**

- [ ] **Step 4: Run the three global checks**

Expected: all green. Existing tests pass unchanged apart from fixture shape (`text` to `message`, `sent[].text` to `sent[].message.text`).

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "refactor: pass formatted text through the provider contract"
```

---

### Task 5: `format` on `/request` and `/notify`, OpenAPI

**Files:**
- Modify: `src/approval/parser.ts`, `src/approval/index.ts`, `src/notify/parser.ts`
- Modify: `src/server/openapi.ts`, `docs/openapi.yaml` (regenerated)
- Test: `test/approval/parser.test.ts`, `test/notify/parser.test.ts`, `test/server/openapi.test.ts`, `test/server/server.test.ts`

**Interfaces:**
- Consumes: `MESSAGE_FORMATS`, `DEFAULT_FORMAT`, `MessageFormat`, `toFormattedText` from `src/format/index.ts`; Task 4's shapes.
- Produces:
  - `createFormatSchema()` in `src/approval/parser.ts`, exported from `src/approval/index.ts`: `z.enum(MESSAGE_FORMATS, { error: 'format must be "plain" or "markdown"' }).optional()`
  - `checkProjectText(message: FormattedText, project: string | undefined, maxTextLength: number, format: MessageFormat)`: same as Task 4, but for `markdown` both limit messages get the suffix ` after formatting`
  - Both body schemas: field `format: createFormatSchema()`; in the transform, render with `toFormattedText(text, format ?? DEFAULT_FORMAT)`, add the issue `text must not be blank after formatting` when `message.text.trim() === ''`, then `checkProjectText`
  - `openapi.ts`: `BODY_DESCRIPTIONS.format = { description: '`plain` (default) or `markdown`, a small subset: code spans and fenced blocks, bold, italic, strikethrough, headings and quotes. Anything else stays as typed. See Formatting in the README.' }`; `text` loses `maxLength` (keeps `minLength: 1`); `TEXT_DESCRIPTION` becomes `toTextDescription(maxTextLength)` stating the limit: max N characters, with `format: markdown` counted after markup is removed, and the existing `project` sentence

- [ ] **Step 1: Write the failing tests**

`test/approval/parser.test.ts` (update the existing `valid, default timeout` expectation to `value: { message: { text: base.text, spans: [] }, options, timeoutOption, timeoutSeconds: 300 }`):
- `plain is the default and keeps the text as is`: `{ ...base, text: '  **a**  ' }` gives `message: { text: '  **a**  ', spans: [] }`.
- `bad format`: `format: 'html'` gives `{ ok: false, error: 'format must be "plain" or "markdown"' }`.
- `blank after formatting` (`test.each`): markdown with `` '```\n```' `` and with `` '`   `' `` (Review Focus 2) give `{ ok: false, error: 'text must not be blank after formatting' }`.
- `markdown source over the limit that renders under it passes`: `` '`' + 'x'.repeat(3899) + '`' `` with max 3900 gives `message.text.length === 3899`.
- `markdown rendered one over the limit fails`: `'**' + 'x'.repeat(3901) + '**'` gives `text must be at most 3900 characters after formatting`.
- `plain over the limit keeps its message`: `'x'.repeat(3901)` gives `text must be at most 3900 characters`.
- `project shifts spans`: `{ text: '`ls`', project: 'api', format: 'markdown' }` gives `message: { text: '[api]\n\nls', spans: [code 7/2] }`.
- `markup in project stays literal` (Review Focus 3): `{ text: '**go**', project: '**x**', format: 'markdown' }` gives `message: { text: '[**x**]\n\ngo', spans: [bold 9/2] }`.
- `markdown with project over the limit`: rendered text one over `3900 - 7` gives `text must be at most 3893 characters after formatting`.

`test/notify/parser.test.ts`: default plain, bad format, blank after formatting, markdown limit message, project shift (same values as above).

`test/server/openapi.test.ts`: replace the `maxLength: 1234` assertions with `expect(ApprovalRequest.properties?.text).toMatchObject({ minLength: 1 })`, `not.toHaveProperty('maxLength')` on both bodies, and `description` containing `1234` and `markdown`; add `format` as `{ enum: ['plain', 'markdown'] }` on both bodies.

`test/server/server.test.ts`, `markdown request reaches the provider as spans`: `POST /request` with `format: 'markdown'`, text `` 'Run `ls`?' `` makes the fake runtime record `message: { text: 'Run ls?', spans: [code 4/2] }`; same for `POST /notify`; `format: 'html'` is a 400 with the format error.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vp test test/approval/parser.test.ts test/notify/parser.test.ts test/server`
Expected: FAIL (format ignored, old limit messages, `maxLength` present).

- [ ] **Step 3: Implement the schema, `checkProjectText` and OpenAPI changes**

- [ ] **Step 4: Regenerate the OpenAPI document**

Run: `npm run openapi`
Expected: `docs/openapi.yaml` gains `format` on both bodies and loses `maxLength` on `text`.

- [ ] **Step 5: Run the three global checks**

Expected: green, including `docs/openapi.yaml is up to date`.

- [ ] **Step 6: Commit**

```bash
git add src/approval src/notify src/server docs/openapi.yaml test
git commit -m "feat: format field on /request and /notify"
```

---

### Task 6: Telegram entities and plain fallback

**Files:**
- Modify: `src/telegram/adapter.ts`, `src/telegram/index.ts`, `src/telegram/runtime.ts` (pass `log` to the messenger)
- Test: `test/telegram/adapter.test.ts`

**Interfaces:**
- Consumes: `Span`, `FormattedText` from `src/format/index.ts`.
- Produces:
  - `toEntities(spans: readonly Span[]): MessageEntity[]` (`MessageEntity` from `grammy/types`), exported from `src/telegram/index.ts`. Maps each kind to the same-named entity type; `pre` carries `language` only when set. Nesting fixes: a `bold`/`italic`/`strikethrough` span containing `code` is split into the pieces outside the code (empty pieces dropped); a `blockquote` containing `code` is dropped. Output sorted by offset, longer first on ties.
  - `createTelegramMessenger(bot: Bot, owner: Owner, log: (line: string) => void = console.error)`. `sendRequest`, `finalize` and `sendNotification` add `entities: toEntities(message.spans)` only when `spans` is non-empty, never `parse_mode`. When a call that carried entities throws a `GrammyError` with `error_code === 400`, log `telegram rejected formatting, sent as plain text: ${error.description}` and repeat the same call once without `entities`. Anything else, or a failed retry, throws as today.

- [ ] **Step 1: Write the failing tests**

- `toEntities maps each kind`: bold, italic, strikethrough, code, blockquote, `pre` with `language: 'diff'` and `pre` without (no `language` key) map to `{ type, offset, length[, language] }`.
- `toEntities splits styles around code`: `[bold 0/10, code 4/2]` gives `[bold 0/4, code 4/2, bold 6/4]`.
- `toEntities drops a blockquote holding code`: `[blockquote 0/6, code 4/2]` gives `[code 4/2]`; `[blockquote 0/6, bold 0/3]` is kept as is.
- `plain sends have no entities key`: `sendRequest`, `sendNotification` and `finalize` with `spans: []` call the API with options that don't have `entities` (`not.toHaveProperty('entities')`) and equal today's options.
- `markdown sends carry entities`: `sendRequest('id', { text: 'Run ls', spans: [code 4/2] }, ['Yes'])` calls `sendMessage(42, 'Run ls', { entities: [{ type: 'code', offset: 4, length: 2 }], reply_markup: ... })`.
- `a 400 on a formatted send retries once as plain`: first `sendMessage` rejects with `new GrammyError(..., { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 'sendMessage', {})`, second resolves; two calls, the second without `entities`; `log` called once with `"telegram rejected formatting, sent as plain text: Bad Request: can't parse entities"`.
- `a 400 on a plain send doesn't retry`: one call, rejects, `log` not called.
- `a failed retry throws`: both calls reject with 400; the call rejects.
- `a non-400 failure on a formatted send doesn't retry`: `error_code: 429` rejects after one call.
- `finalize carries entities and falls back the same way`: `editMessageText` gets `entities` and `reply_markup: { inline_keyboard: [] }`; after a 400 it's retried once without `entities`.
- `notification falls back the same way`: one test for `sendNotification` with a 400.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vp test test/telegram/adapter.test.ts`
Expected: FAIL, `toEntities` missing and no `entities` sent.

- [ ] **Step 3: Implement `toEntities`, the entity options and the fallback; pass `log` from `createTelegramRuntime`**

- [ ] **Step 4: Run the three global checks**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/telegram test/telegram
git commit -m "feat: send formatting to telegram as entities"
```

---

### Task 7: `format` in MCP, the Node client and `send`

**Files:**
- Modify: `src/mcp/server.ts`, `src/client/types.ts`, `src/client/client.ts`, `src/commands/types.ts`, `src/commands/send.ts`, `src/cli.ts`
- Test: `test/mcp/server.test.ts`, `test/client/client.test.ts`, `test/commands/send.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `MESSAGE_FORMATS`, `MessageFormat` from `src/format/index.ts`.
- Produces:
  - MCP: both tools get `format: z.enum(MESSAGE_FORMATS).optional().describe(FORMAT_DESCRIPTION)` with `FORMAT_DESCRIPTION` the spec's text verbatim (``markdown shows **bold**, *italic*, `inline code` and fenced ``` blocks; put commands and diffs in a fenced block (```diff, ```sh) so the user sees them exactly``). `ASK_DESCRIPTION` and `NOTIFY_DESCRIPTION` each gain the sentence `For commands and diffs, set format to "markdown" and put them in a fenced code block.`; `textSchema`'s description becomes `Message to show the user; see format for commands and diffs`. `format` goes into the body only when set.
  - `AskRequest.format?: MessageFormat`, `Notification.format?: MessageFormat` with a one-line JSDoc (`Default plain; markdown renders a subset, see the README.`). Sent only when set.
  - `SendRequestArgs.format?: MessageFormat`, `SendNotifyArgs.format?: MessageFormat`; sent only when set.
  - `send request` and `send notify`: `.addOption(new Option('--format <format>', 'how to read TEXT: plain (default) or markdown').choices(MESSAGE_FORMATS))`

- [ ] **Step 1: Write the failing tests**

- `test/mcp/server.test.ts`: `ask_for_permission forwards format` (body the stub service receives has `format: 'markdown'`); `format is omitted when not set` (no `format` key); same pair for `notify_user`; `tool list shows format` (input schema has `format` with `enum: ['plain', 'markdown']`).
- `test/client/client.test.ts`: `request sends format when set`, `notify sends format when set`, `format is omitted by default`.
- `test/commands/send.test.ts`: `request --format markdown reaches the provider as spans` (fake messenger records `spans: [code ...]`); `notify passes format`.
- `test/cli.test.ts`: `expect(await main([...ask, '--format', 'html'])).toBe(2)`; same for `send notify`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vp test test/mcp test/client test/commands/send.test.ts test/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the three global checks**

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp src/client src/commands src/cli.ts test
git commit -m "feat: format option for mcp tools, client and send"
```

---

### Task 8: README and changeset

**Files:**
- Modify: `README.md`
- Create: `.changeset/message-formatting.md`

No tests; `npx vp check` covers formatting (README isn't in the fmt ignore list).

- [ ] **Step 1: README**, following the spec's "README" section:
  - `/request` and `/notify` tables: add the `format` row; change `text`'s "max 3900 chars" note to say markdown counts the rendered text; drop "Plain text." from `/notify`'s row.
  - MCP param tables (`ask_for_permission`, `notify_user`): `format` row.
  - `send` usage lines and the Commands list: `[--format plain|markdown]`.
  - "From Node": one sentence on `format` and on `escapeMarkdown` / `formatCodeBlock` for interpolating untrusted text.
  - New `### Formatting` section under "Scripts and tools (HTTP API)" (anchor `#formatting`, which `BODY_DESCRIPTIONS` points at): the subset as a compact table, the Intent example, unrecognized markup stays literal, `\` escapes, a longer fence for text containing ```` ``` ````, the limit counts the rendered text, put commands in code (the `ls *foo* bar` caveat), and the compatibility sentence modeled on the existing `project` one ("`format` needs a service at least as new as this release; an older one shows the markdown as typed. Re-run `init` to upgrade.").
- [ ] **Step 2: Changeset** `.changeset/message-formatting.md`, `'telegram-ask': minor`, two or three sentences in the style of `.changeset/quiet-hours.md`: what `format: "markdown"` does, where it's available, plain stays the default.
- [ ] **Step 3: Run the three global checks**

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add README.md .changeset/message-formatting.md
git commit -m "docs: message formatting"
```

---

## Manual checks for the owner (need a real bot; not tasks)

From the spec's "Unverified" list, once after merging, with a paired bot:

1. `telegram-ask send notify $'```\n  indented\n```' --format markdown` (no project): if the first line loses its indent, add the README sentence the spec gives ("start with a line of text, or set `project`, if the first code line is indented").
2. ``send notify '**run `ls` now**' --format markdown`` and `send notify $'> run `ls`' --format markdown`: if Telegram would have accepted the unsplit nesting, the splitting in `toEntities` can go.
3. A message with ~150 inline code spans: does it arrive formatted, partly formatted, or via the plain fallback (one log line)?
4. A URL in a markdown message still auto-links; a ```` ```diff ```` block gets highlighting.
