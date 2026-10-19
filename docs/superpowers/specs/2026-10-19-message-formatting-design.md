# Message formatting: design

Source: an autonomous brainstorming run on 2026-10-19 from a one-paragraph request. There was no
conversation with the owner, so every choice the request didn't make is marked "Decision (made
without user input)" so it can be checked. Builds on the code as of `99ae1b9` (0.3.0); what exists
stays as it is unless this doc says otherwise.

## Intent

Today every message goes to Telegram as plain text. When an agent asks "Run this?" or "Apply this
diff?", the command or diff shows up in the same proportional font as the question. Whitespace
alignment is lost, there's no clear edge to the part being approved, and the owner has to squint
on a phone to see exactly what they're saying yes to.

The request: an opt-in `format: "markdown"` (or similar) on `POST /request`, `POST /notify` and
both MCP tools, with correct escaping, plus code blocks for diffs and commands, so the thing being
approved is readable. Plain text stays the default.

What success looks like: an agent sends

````
Force-push `feature/login` to origin?

```diff
-  return token
+  return token.trim()
```
````

and the owner sees the branch name in monospace and the diff as a monospace block (with a copy
button in current Telegram clients), with the backticks gone. A caller who doesn't send `format`
sees exactly what they see today.

## Goals

- An optional `format` field, `"plain"` (default) or `"markdown"`, on `/request` and `/notify`, and
  a matching optional `format` param on `ask_for_permission` and `notify_user`.
- Markdown mode renders fenced code blocks (with an optional language, e.g. `diff`, `sh`), inline
  code, bold, italic, strikethrough, headings and blockquotes.
- Code content is shown exactly as written: no character inside a code span or block is ever
  changed, removed or interpreted.
- No caller-supplied text can make the Telegram send fail on markup. A malformed or unbalanced
  marker shows up as a literal character, never as an error.
- The `[project]` line, button labels and the result line ("✅ Approve, 09:05") can't be affected
  by the caller's markup and need no escaping.
- The 3900 limit keeps meaning "what the owner sees": in markdown mode it counts the text after
  markup is removed.

## Non-goals

- Full CommonMark or GFM. Lists, tables, links, images and HTML aren't interpreted; they show as
  typed (see the subset below).
- Raw Telegram markup passthrough (`parse_mode` MarkdownV2 or HTML). It would tie the HTTP API to
  one provider and put the escaping burden back on every caller.
- Clickable link text (`[text](url)`). URLs typed in the text are still auto-linked by Telegram.
- Formatted button labels. Labels stay plain, as today.
- Collapsible ("expandable") blocks or spoilers.
- Splitting long messages or attaching long diffs as files. The 3900 limit still applies and a
  longer message is still a 400.
- Detecting from the client whether the service supports `format` (see Compatibility).

## Anti-goals

These would make it a failure even if formatting technically works:

- The owner approves something different from what the caller sent because formatting ate,
  merged or hid characters. In particular `rm -rf /tmp/*`, `2*3*4`, `snake_case_name`,
  `__init__.py`, `src/**/*.ts`, `*.ts *.js` and `a_b_c` must survive outside code blocks, and
  everything inside code must survive verbatim. (A glob that looks exactly like emphasis, such as
  `ls *foo* bar`, can't be told apart from it; the docs and tool descriptions tell callers to put
  commands in code, which is what markdown mode is for.)
- A request that would have reached the owner as plain text fails to arrive because of
  formatting (Telegram rejecting entities, a parser bug, a blank result).
- Any change for callers who don't send `format`: same text, same Telegram call, no `entities`
  key, same errors.
- Content hidden behind link text or a collapsed block in a message the owner approves.

## Options considered

1. Pass the caller's text through with `parse_mode: 'MarkdownV2'`. MarkdownV2 needs 18 characters
   escaped everywhere outside code (`_*[]()~\`>#+-=|{}.!`). Agents and scripts will get that
   wrong constantly, Telegram answers 400 "can't parse entities", that surfaces as a 502, and the
   question never reaches the owner. Also Telegram-specific. Rejected.
2. Pass through `parse_mode: 'HTML'`. Escaping is smaller (`<`, `>`, `&`) but callers still have
   to do it and the same 400 failure mode exists. Rejected.
3. Parse a full CommonMark library's output (marked, micromark) into Telegram entities. Handles
   more syntax, but CommonMark happily turns `2*3*4` into `2<em>3</em>4`, reflows lines and
   decodes `&amp;`, which is the first anti-goal. Adds a runtime dependency for features we'd
   mostly flatten anyway. Rejected.
4. Parse a small, conservative markdown subset in the core into plain text plus formatting
   ranges, and have the Telegram adapter send those ranges as `entities` with no `parse_mode`.
   Chosen.

Decision (made without user input): option 4. With `entities`, Telegram never parses the text, so
there's nothing to escape on the Telegram side at all. The only escaping that exists is the
caller's own `\*` for a literal marker, and anything unrecognized is literal anyway. Ranges are
provider-neutral, so a future provider maps them to its own markup or ignores them and still
shows readable text.

Decision (made without user input): the field is named `format` with values `"plain"` and
`"markdown"`, default `"plain"`. "markdown" is the word agents and callers already know; the docs
say plainly that it's a subset.

## The markdown subset

The parser turns the source into `{ text, spans }`: `text` is what the owner sees, `spans` say
which ranges are bold, code and so on. It never throws. Anything that doesn't match a rule below
is copied to `text` unchanged, character for character.

Decision (made without user input): the whole subset below. It's chosen to cover what agents
actually write (fences, backticks, bold, headings) while never touching characters that plausibly
belong to a command, glob or identifier.

### Lines are kept

In markdown mode `\r\n` and lone `\r` become `\n` first (Decision (made without user input):
otherwise a Windows-edited fence line wouldn't match). Plain mode doesn't touch them. After that,
line breaks are kept exactly. There's no paragraph reflow and no joining of lines. Blank lines
stay. Leading and trailing whitespace of the whole rendered text is trimmed (spans adjusted), but
only up to the first and last span: whitespace inside a `code` or `pre` span is never trimmed, so
a block whose first line is indented keeps its indent. Interior whitespace is never touched.
Decision (made without user input): trimming the edges keeps offsets predictable whatever
Telegram does with edge whitespace. I'm not sure whether Telegram strips leading spaces inside a
leading `pre` entity. With a `[project]` line in front (always the case from MCP) it can't
matter. Without one (HTTP, CLI or `Client` callers that omit `project`), a block that opens the
message with an indented line, such as a diff starting with a context line, could lose that
first indent. Decision (made without user input): this is a manual check, not a task. If Telegram
does trim, document it in the README Formatting section ("start with a line of text, or set
`project`, if the first code line is indented") and don't work around it in code. The
workarounds (no-break spaces, invisible characters, falling back to plain) all change what the
owner copies or lose the formatting, which is worse than one lost indent that only happens
without a project line.

### Block rules (line based, checked in this order)

1. Fenced code block. An opening line of 0 to 3 spaces, then 3 or more backticks or 3 or more
   tildes, then an optional info string. The block ends at a line of 0 to 3 spaces and the same
   fence character repeated at least as many times as the opener, with only whitespace after. An
   unclosed fence runs to the end of the text (as in CommonMark). The fence lines are removed;
   the lines between are copied verbatim (including leading spaces and any markdown-looking
   characters) and get one `pre` span. The span doesn't include the newline before the closing
   fence. The first word of the info string becomes the span's `language` if it matches
   `^[A-Za-z0-9_+#.-]{1,32}$`; otherwise there's no language. A backtick fence whose info string
   contains a backtick isn't a fence (CommonMark rule, so ```` ```foo``` ```` on one line stays
   inline code). An empty block (no lines between the fences) produces no span.
2. Heading. 0 to 3 spaces, 1 to 6 `#`, then at least one space or tab, then the content. A
   trailing run of `#` preceded by a space is dropped. The leading `#`s and the space are removed,
   the content is parsed with the inline rules and wrapped in one `bold` span. `#123` and `#tag`
   (no space) stay literal.
3. Blockquote. A run of consecutive lines starting with 0 to 3 spaces and `>`. The `>` and one
   following space (if any) are removed from each line, each line is parsed with the inline rules,
   and the whole run (without its final newline) gets one `blockquote` span. A `>` further into a
   quoted line stays literal; quotes don't nest and fences inside a quote aren't recognized.
4. Anything else is a normal line, parsed with the inline rules. List markers (`- `, `* `,
   `1. `), table pipes, `---` and HTML stay as typed.

### Inline rules (within one line; nothing spans a line break)

- Backslash escape. A backslash before an ASCII punctuation character drops the backslash and
  keeps the character literal (CommonMark's set: ``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``). A
  backslash before anything else is literal. Inside code, backslashes are always literal.
- Inline code. A run of N backticks opens; it closes at the next run of exactly N backticks on the
  same line. The content is verbatim; if it starts and ends with a space and isn't all spaces, one
  space is stripped from each end (CommonMark). It gets a `code` span. An unmatched run is
  literal. Code is matched before emphasis, so markers inside code never count.
- Emphasis: `**x**` is bold, `*x*` is italic, `~~x~~` is strikethrough. `_` is never a marker:
  `_x_` and `__x__` stay literal. Decision (made without user input): underscores are far more
  common in identifiers (`__init__.py`, `_private_`, `snake_case`) than as emphasis in agent
  text, and agents use `*` for emphasis anyway.
  - Stricter than CommonMark, so markers only count at word edges. Decision (made without user
    input). A segment here is the line, or the content of an enclosing emphasis span.
    - An opener must be at the start of the segment or after whitespace, optionally with a run of
      `([{"'` in between, and must be followed by a non-whitespace character.
    - A closer must be preceded by a non-whitespace character, and must be at the end of the
      segment or before whitespace, optionally with a run of `.,:;!?)]}"'` in between.
    - So `2*3*4`, `src/**/*.ts`, `**/*.ts`, `*.ts *.js`, `*args and **kwargs` and `x * y * z`
      stay literal, while `**Deploy**.`, `(*note*)` and `"**yes**"` format.
  - The closer is the nearest matching delimiter on the same line that meets the closer rule,
    skipping escaped characters and code spans. No closer means the opener is literal.
  - The longer delimiter is tried first (`**` before `*`). The content is parsed again as its own
    segment, so emphasis can contain code and emphasis of another kind (`**bold *and italic***`
    may or may not nest as hoped; `**bold** and *italic*` always works).
  - Empty content (`****`) is literal.
- Links, images, autolinks, HTML tags and entity references (`&amp;`) aren't parsed; they stay
  as typed. Decision (made without user input): showing `[docs](https://x)` literally is less
  pretty but means the owner always sees the real URL before approving.

### Examples (these double as test cases)

Offsets and lengths are in UTF-16 code units, as JavaScript string indices.

| Source                                   | `text`                  | `spans`                                            |
| ---------------------------------------- | ----------------------- | -------------------------------------------------- |
| ``Run `rm -rf build`?``                  | `Run rm -rf build?`     | code 4+12                                          |
| ```` ```diff\n-a\n+b\n``` ````           | `-a\n+b`                | pre 0+5 language `diff`                            |
| `**Deploy** to *prod*`                   | `Deploy to prod`        | bold 0+6, italic 10+4                              |
| `snake_case_name and 2*3*4`              | unchanged               | none                                               |
| `__init__.py and _private_`              | unchanged               | none                                               |
| `**/*.ts and *.js`                       | unchanged               | none                                               |
| `rm -rf /tmp/* and src/**/*.ts`          | unchanged               | none                                               |
| `\*not italic\*`                         | `*not italic*`          | none                                               |
| `## Plan\nship it`                       | `Plan\nship it`         | bold 0+4                                           |
| `#123 is fixed`                          | unchanged               | none                                               |
| `> quoted\n> more`                       | `quoted\nmore`          | blockquote 0+11                                    |
| ```` ```\nunclosed ````                  | `unclosed`              | pre 0+8                                            |
| ``` `` a ` b `` ```                      | ``a ` b``               | code 0+5                                           |
| ``**run `ls` now**``                     | `run ls now`            | bold 0+10, code 4+2 (see Telegram nesting)         |
| ``😀 `x` ``                              | `😀 x`                  | code 3+1 (the emoji is 2 code units)               |
| `* item\n* item`                         | unchanged               | none                                               |
| ```` ```\n``` ````                       | (empty)                 | rejected: blank after formatting                   |

With `project: "api"`, ``` `ls` ``` becomes text `[api]\n\nls` with code 7+2: the project line is
plain and every span shifts by `project.length + 4`.

## Data shapes

The repo's conventions win where they differ from the owner's generic TS style rules
(`~/.claude/rules/ts-coding-style.md`): exported functions rather than `<Module><Role>` classes,
single quotes, no semicolons, `#private` fields, `ok`/`kind` results as the existing modules use
them, `vite-plus/test` rather than `node:test`, and runtime dependencies like zod where the repo
already has them. This comes from the owner's instructions for this run ("follow the TS style
rules when describing code shape, but match the repo's existing conventions where they differ"),
not a guess. Where the repo has no convention, the generic rules apply (readonly fields, explicit
return types, full-word names, `_PATTERN` regexes, JSDoc contracts, "Never throws" noted).

Decision (made without user input): a new self-contained module `src/format/`, because both
`approval` and `notify` need it and it has nothing to do with approvals specifically.

`src/format/types.ts`:

```ts
/** How the caller's text is read: shown as is, or as the markdown subset. */
export type MessageFormat = 'plain' | 'markdown'

/**
 * One formatted range of `FormattedText.text`. Offsets and lengths are UTF-16 code units, the same
 * as JS string indices and Telegram entity offsets.
 */
export type Span =
  | {
      readonly kind: 'bold' | 'italic' | 'strikethrough' | 'code' | 'blockquote'
      readonly offset: number
      readonly length: number
    }
  | {
      readonly kind: 'pre'
      readonly offset: number
      readonly length: number
      readonly language?: string
    }

/**
 * Text as the owner sees it plus its formatting; plain text has no spans. Spans are sorted by
 * offset (outer before inner at the same offset), have length > 0, lie inside `text`, never
 * partially overlap, and nothing is inside `code` or `pre`.
 */
export type FormattedText = { readonly text: string; readonly spans: readonly Span[] }
```

`src/format/constants.ts`: `MESSAGE_FORMATS = ['plain', 'markdown'] as const`,
`DEFAULT_FORMAT = 'plain'`, the line and language patterns (`*_PATTERN`), and the escapable
character set.

Functions (names are suggestions; the builder may adjust within the repo's naming habits):

- `parseMarkdown(source: string): FormattedText`, in `parser.ts`. Never throws.
- `toFormattedText(text: string, format: MessageFormat): FormattedText`. Plain gives
  `{ text, spans: [] }` with `text` untouched (no trim), so plain stays byte-identical.
- `prependText(prefix: string, formatted: FormattedText): FormattedText` and
  `appendText(formatted: FormattedText, suffix: string): FormattedText`; prepend shifts every span.
- `escapeMarkdown(text: string): string`: backslash-escapes every character the subset could
  treat as markup (`` \ ` * ~ # > ``), so `parseMarkdown(escapeMarkdown(s))` is always
  `{ text: s.trim(), spans: [] }` for any `s` without `\r`. Worth a property-style test over random strings.
- `formatCodeBlock(code: string, language?: string): string`: wraps `code` in a backtick fence
  one longer than the longest backtick run at the start of any line in `code` (minimum 3), so a
  diff that itself contains ```` ``` ```` lines still round-trips verbatim.

Decision (made without user input): `escapeMarkdown` and `formatCodeBlock` are exported from the
package (`src/index.ts`) next to `Client`, because "correct escaping" for a Node caller
interpolating untrusted text into markdown means having these two helpers rather than writing
them by hand. They're not exposed over HTTP or MCP.

## How it flows

### Parsing (`approval`, `notify`)

- `createFormatSchema()` next to `createTextSchema()`:
  `z.enum(MESSAGE_FORMATS, { error: 'format must be "plain" or "markdown"' }).optional()`. Used by
  both body schemas.
- In each body schema's transform: `toFormattedText(text, format ?? DEFAULT_FORMAT)`. If the
  rendered text is blank, add the issue `text must not be blank after formatting` (the raw-text
  non-blank check stays as is and runs first).
- `checkProjectText` takes and returns a `FormattedText`. The limit is checked on the rendered
  text including the `[project]` line, exactly as today's combined check. For markdown the error
  reads `text must be at most N characters after formatting`; for plain it stays
  `text must be at most N characters`, unchanged. Decision (made without user input): the suffix
  is there because a caller whose source is 3950 characters with 100 characters of markup would
  otherwise be confused by which length counts.
- The 64 KiB body cap stays; a markdown source may be longer than 3900 as long as the rendered
  text fits.
- `ApprovalRequest.text: string` becomes `message: FormattedText`, and `NotifyRequest.text`
  likewise. Decision (made without user input): rename to `message` so no code mistakes it for a
  string.
- `formatProjectText` keeps the `[project]\n\n` format and becomes `prependText` underneath.
- `formatFinalText(original: FormattedText, settlement, at): FormattedText` appends
  `\n\n<result line>` via `appendText`; the original spans stay as they are and the result line
  has none.

### Provider contract

`Messenger.sendRequest(id, message: FormattedText, options)`,
`Messenger.finalize(reference, message: FormattedText, settlement)`,
`Notifier.sendNotification(id, message: FormattedText)`, and the matching `ProviderRuntime`
members take a `FormattedText` instead of a string. A provider that can't format sends
`message.text` and ignores spans. `test/provider/fake.ts` records the `FormattedText`.

### Telegram adapter

- `toEntities(spans: readonly Span[]): MessageEntity[]` maps `bold`, `italic`, `strikethrough`,
  `code`, `blockquote` to the entity type of the same name and `pre` to `pre` with `language`
  when set. Exported for tests.
- It also enforces Telegram's nesting rules (Bot API "formatting options"): bold, italic and
  strikethrough can't contain or be inside `code` or `pre`, and blockquote can't contain them
  either. So:
  - a bold, italic or strikethrough span that contains a code span is split into the pieces
    before and after the code (the code itself isn't bold);
  - a blockquote that contains a code span is dropped, keeping the code and the inline styles.
  Decision (made without user input): code wins every conflict, because the code is the thing
  being approved. The builder should check these two cases once against the real Bot API; if
  Telegram turns out to accept them, the splitting can go.
- With no spans, the `sendMessage` and `editMessageText` options are exactly today's (no
  `entities` key). With spans, `entities` is added and nothing else changes. No `parse_mode` is
  ever set.
- Fallback: if a send or edit that carried entities fails with a `GrammyError` 400, log one line
  (`telegram rejected formatting, sent as plain text: <description>`) and retry once with the
  same `text` and no entities. Any other failure, or a failure of the retry, behaves as today
  (`SendError`, 502). Decision (made without user input): the retry sends the rendered text, not
  the markdown source, because the rendered text has every content character and reads better
  than raw markers. `createTelegramMessenger` gets an optional `log` parameter defaulting to
  `console.error`, like the other Telegram helpers.
- The final edit re-sends the original entities; since the result line is appended at the end,
  offsets don't move.

### HTTP API

`POST /request` and `POST /notify` gain:

| Field    | Type   | Required | Notes                                                                     |
| -------- | ------ | -------- | ------------------------------------------------------------------------- |
| `format` | string | no       | `plain` (default) or `markdown`. See [Formatting](#formatting) in README. |

The OpenAPI document picks the field up from the zod schemas. Add a `format` entry to
`BODY_DESCRIPTIONS` and extend `TEXT_DESCRIPTION` to say that with `format: markdown` the limit
counts the text after markup is removed. Regenerate `docs/openapi.yaml` (`npm run openapi`).

`toBodySchema` currently puts `maxLength: maxTextLength` on `text`, and `test/server/openapi.test.ts`
asserts it. That would make generated clients reject valid markdown sources longer than 3900.
Decision (made without user input): drop `maxLength` from `text` (keep `minLength: 1`) and state
the limit in `TEXT_DESCRIPTION` instead, for both formats; update the test to assert the
description instead. The server still enforces the limit as before, so plain callers see no
behavior change, only a looser published schema. A conditional `if`/`then` schema on `format`
was considered and rejected as more than generated clients reliably handle.

### MCP tools

Both tools get `format: z.enum(['plain', 'markdown']).optional()`, described as: "markdown shows
**bold**, *italic*, `inline code` and fenced ``` blocks; put commands and diffs in a fenced block
(```diff, ```sh) so the user sees them exactly". It's forwarded only when set. The `text` param
description and both tool descriptions get one sentence pointing at `format: "markdown"` for
commands and diffs.

Decision (made without user input): the MCP default stays plain, as the request asked for
opt-in everywhere, even though agents write markdown naturally. The description nudge is how
agents learn to opt in.

### Node client and CLI

Not in the request, but they mirror the HTTP API and would be odd to leave behind.

Decision (made without user input):

- `AskRequest` and `Notification` get `format?: MessageFormat`, sent only when set. No
  client-wide default (unlike `project`); one more option wasn't worth it.
- `send request` and `send notify` get `--format <format>`, limited to `plain` and `markdown`
  through commander's `choices`, so a bad value exits 2 like other bad arguments.
- `telegram-ask test` stays plain.

### Compatibility

A new client against an older service: the old body schemas strip unknown keys, so `format` is
ignored and the owner sees the raw markdown as plain text. Nothing breaks. README gets a sentence
like the existing one for `project` ("needs a service at least as new as this release; re-run
`init` to upgrade"). Decision (made without user input): no `/status` capability field to detect
this; the failure is cosmetic.

## README

- `/request` and `/notify` field tables get the `format` row; the `/notify` row's "Plain text."
  note changes to point at `format`.
- MCP param tables get `format`.
- `send` usage lines and the Commands list get `--format`.
- The Node section mentions `format` and the two helpers.
- A short "Formatting" section: the subset as a compact table, the example from Intent, the rule
  that unrecognized markup stays literal, `\` to escape, longer fences for text containing
  ```` ``` ````, and that the 3900 limit counts the rendered text.

## Testing

Repo conventions: `vite-plus/test`, tests under `test/<module>/`, importing from
`src/<module>/index.ts`. Verify with `npx tsc -p tsconfig.json`, `npx vp check`, `npx vp test`.

- `test/format/parser.test.ts`: every row of the examples table, plus the anti-goal strings
  (`rm -rf /tmp/*`, `src/**/*.ts`, `a_b_c`, `__init__.py`, `2*3*4`, `x * y * z`) unchanged with no spans; fences
  with tildes, with 4 backticks containing a 3-backtick line, indented 1 to 3 spaces, with an
  invalid language; a heading with closing `#`s; CRLF input; spans' invariants checked on every
  result (sorted, in range, nested, nothing inside code).
- `escapeMarkdown` round-trip over random printable strings; `formatCodeBlock` on code containing
  backtick fences.
- `test/approval/parser.test.ts` and `test/notify/parser.test.ts`: default is plain and unchanged;
  bad `format` value; blank after formatting; the limit counted on rendered text (a source over
  3900 that renders under it passes; a source under 3900 can't render over it, but a rendered
  text one over the limit fails with the "after formatting" message); project shifting spans.
- `test/approval/formatter.test.ts`: `formatFinalText` keeps spans and appends plain text.
- `test/telegram/adapter.test.ts`: plain sends have no `entities` key; markdown sends carry the
  mapped entities; nesting splits; a 400 on a formatted send logs once and retries without
  entities; a 400 on a plain send doesn't retry; finalize carries entities and falls back the
  same way.
- `test/server/server.test.ts`, `test/server/openapi.test.ts`, `test/mcp/server.test.ts`,
  `test/client/client.test.ts`, `test/commands/send.test.ts`, `test/cli.test.ts`: `format` passes
  through end to end and the OpenAPI document lists it.

## Left to the builder

- Exact parser structure (single pass, line splitter plus inline scanner, whatever reads best),
  as long as the rules and examples above hold.
- Exact helper and file names inside `src/format/`.
- Exact MCP and README wording, within the intent above.
- Whether `Span` keeps one union member for the five plain kinds or splits them.

## Unverified, worth one manual check

- Whether Telegram trims leading whitespace inside a `pre` entity at the very start of a message
  (see "Lines are kept"; only matters without `project`).
- Whether URLs in the text still auto-link when `entities` is passed. Cosmetic.

- Telegram's nesting enforcement for bold-around-code and blockquote-around-code (the adapter
  splits or drops them on the documented rules; the 400 fallback covers being wrong the other
  way).
- Whether Telegram caps the number of entities per message. I think there may be a limit around
  100 but couldn't confirm it. If a long message with many spans is rejected, the fallback sends
  it plain; if spans past a cap are silently ignored, that's acceptable.
- `diff` syntax highlighting. The Bot API points at libprisma's language list; I expect `diff` to
  be on it, but monospace alone is the goal.
