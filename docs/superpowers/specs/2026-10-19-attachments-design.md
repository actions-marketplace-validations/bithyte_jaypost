# Attachments: design

Source: an autonomous brainstorming run on 2026-10-19. Nobody was available to answer questions, so
every choice the owner would normally make is marked "Decision (made without user input)". The
list at the end collects them for review. Builds on the shipped code and README (v0.3.0); what they
describe stays as it is unless this doc says otherwise.

## Intent

Callers can only send text today, capped at 3900 characters (Telegram's 4096 minus headroom). An
agent that wants to force-push can't show the diff that's over the cap, a deploy script can't
include the failing log, and an agent stuck on a UI bug can't show the screenshot. The owner ends up
approving from a summary, or going to the machine to look.

Attachments let a caller add one file to an ask (`POST /request`, `ask_for_permission`, `send
request`, `Client.request`) or a notification (`POST /notify`, `notify_user`, `send notify`,
`Client.notify`). It shows up in Telegram as a document right above the message, so the owner can
open it on the phone before tapping a button.

Success: an agent calls `ask_for_permission` with `attachment: { path: "/tmp/changes.diff" }`, the
owner's phone shows `changes.diff` and under it the question with buttons, and the owner can read
the diff and answer from the phone.

## Goals

- An optional `attachment` field on `/request` and `/notify`: a file name plus either UTF-8 `text`
  or base64 `data`.
- Sent to Telegram as a document (`sendDocument`), never as a compressed photo.
- The question or notification message keeps working exactly as today: same buttons, same final
  edit, same Dismiss, same 8-hour expiry. The attachment's lifetime follows the message.
- Callers that run where the file is (MCP server, CLI, Node `Client`) take a local path and read the
  file themselves, so it works for every install target, including the containers that can't see
  host paths.
- Fits the provider seam: attachment support is an optional provider capability with its own size
  limit.

## Non-goals

- More than one attachment per call. Decision (made without user input): one covers the three cases
  in the request (log, screenshot, diff), and it keeps Dismiss stateless across restarts (see
  Telegram behavior). A later `attachments` array can be added without breaking `attachment`.
- Photo mode (inline image preview via `sendPhoto`). The request says "as a Telegram document", and
  a document keeps screenshots uncompressed.
- Automatically turning a `text` over 3900 characters into an attachment. Over-long `text` stays a
  400, as today. The caller decides what goes in the message and what goes in the file.
- The service reading files by path. It never touches the filesystem for an attachment.
- A caption on the document, a content-type field, or a per-call silent/loud switch.
- Attachments without `text`. `text` stays required on both endpoints.
- `multipart/form-data` uploads. Decision (made without user input): JSON with base64 keeps one
  body format for curl, n8n, MCP and the clients, and the service needs no new dependency. The
  33% base64 overhead is fine on loopback.

## Anti-goals

- An attachment silently going missing. If the caller asked for one and the owner doesn't get it,
  the call must fail. This matters most against an older service that would ignore the field.
- The owner approving a question whose attachment failed to send.
- Attachment bytes (or the raw body carrying them) kept reachable for the life of a pending request
  (up to 300 s, many at once). See "Memory" under Provider seam and core for what that requires.
- A failed attachment delete or upload crashing the service.
- Attachment contents in logs.
- Breaking any existing caller: bodies without `attachment` behave exactly as today.

## Constraints from the current code

- `MAX_BODY_BYTES` is 64 KiB (`src/server/constants.ts`), applied by Fastify to the whole body as a
  string. Base64 of a typical screenshot is already over that, so the limit has to rise.
- Container targets (Quadlet, Compose) run the service in a container with only a `/data` volume.
  Host paths mean nothing there. Even the systemd target shouldn't read paths: the API has no auth,
  and "read any file and send it" is a worse capability than "send these bytes".
- `MessageReference` is opaque to the core; Telegram's is `{ chatId, messageId }`. Finalize edits
  it, expiry and Dismiss delete it.
- Dismiss works after a restart because the tapped message deletes itself, with no core state. That
  property should survive.
- Old services strip unknown body fields (zod object), so a new client sending `attachment` to an
  old service gets the message without the file and a 200. That's the silent drop the anti-goals
  forbid, so clients must check first (see Compatibility).
- Repo conventions where they differ from the global TypeScript style: module-level functions and
  small classes with `#private` fields rather than everything in a `<Module><Role>` class, single
  quotes, no semicolons, zod schemas, Fastify, grammY, vitest (`vite-plus/test`) with `vi` fakes.
  Follow the repo.

## HTTP API

Both `POST /request` and `POST /notify` take an optional `attachment`:

| Field             | Type   | Required        | Notes                                                                 |
| ----------------- | ------ | --------------- | --------------------------------------------------------------------- |
| `attachment.name` | string | yes             | File name shown in Telegram. Its extension decides how Telegram opens it. |
| `attachment.text` | string | one of the two  | File contents as UTF-8 text.                                          |
| `attachment.data` | string | one of the two  | File contents as base64.                                              |

Examples:

```
curl -s -X POST http://127.0.0.1:8787/request \
  -H 'content-type: application/json' \
  -d '{"text":"Push this diff?","options":["Push","Stop"],"timeoutOption":"Stop",
       "attachment":{"name":"changes.diff","text":"diff --git a/x b/x\n..."}}'

jq -n --arg data "$(base64 -w0 screen.png)" \
  '{text:"Login page is blank, see screenshot",attachment:{name:"screen.png",data:$data}}' |
  curl -s -X POST http://127.0.0.1:8787/notify -H 'content-type: application/json' -d @-
```

Validation, in addition to today's rules. Messages follow the existing `<field> must ...` style;
exact wording is the builder's within that pattern, and it becomes part of the API (README):

- `attachment` present but not an object (including `null`): 400 `attachment must be an object`.
  Decision (made without user input): `null` is rejected like it is for `project`, not treated as
  absent.
- `name`: non-empty, at most 255 characters, no `/` or `\`, no control characters (U+0000 to
  U+001F, U+007F), not `.` or `..`. Not trimmed; a name with leading or trailing spaces is
  rejected. Decision (made without user input): reject rather than sanitize, so the caller sees what
  the owner will see.
- Exactly one of `text` and `data`: neither or both is a 400.
- `data`: standard base64 alphabet (RFC 4648 section 4), padding optional, ASCII whitespace ignored
  so plain `base64` output with line wraps works. Anything else (URL-safe alphabet, stray
  characters, bad length) is a 400 `attachment.data must be base64`. Note `Buffer.from(s, 'base64')`
  is lenient and silently drops bad characters; validate before decoding.
- Decoded size (UTF-8 bytes for `text`): at least 1 byte (Telegram rejects empty files), at most the
  provider's `maxAttachmentBytes`. Over it: 400 `attachment must be at most N bytes`.
- When the provider has no attachment support: 501 `attachments not supported`, checked after the
  JSON parse and before field validation, and only when the body has an `attachment` key.

Check order for `/request`: 503 not paired, 400 bad JSON, 501 attachments unsupported, 400
validation. For `/notify`: 501 notifications unsupported, 503, 400 bad JSON, 501 attachments
unsupported, 400 validation. This keeps today's order and slots the new check in. Decision (made
without user input).

Body limit: `MAX_BODY_BYTES` rises from 64 KiB to 14 MiB (14_680_064) for both endpoints. That fits
the base64 of a 10 MiB file (13_981_016 characters) plus the rest of the body. A `text` attachment
near 10 MiB with heavy JSON escaping (many quotes or control characters) can exceed the body limit
and get a 413; the README should say to send big files as `data`. The clients always send files as
`data`. Decision (made without user input): one limit for all bodies instead of a 64 KiB limit for
bodies without attachments; Fastify checks the size before it can see the fields, and the service
is loopback only.

Success responses don't change: `/request` still returns `{ answer, timedOut }` and `/notify`
`{ ok: true }`.

`GET /status` gains `maxAttachmentBytes: number`, the provider's limit, `0` when the provider
doesn't support attachments. Its absence means the service predates attachments. Clients use it to
fail early (see Compatibility). Added to `statusInfoSchema` as optional so old bodies still parse.

Constants: a core cap `MAX_ATTACHMENT_BYTES = 10_485_760` (10 MiB) that no provider may exceed, and
`MAX_BODY_BYTES` derived from it or set alongside it with a comment showing the arithmetic.
Effective limit is `min(provider.maxAttachmentBytes, MAX_ATTACHMENT_BYTES)`. Decision (made without
user input): 10 MiB covers screenshots, logs and diffs; Telegram's own bot upload limit is 50 MB,
but the whole body sits in memory as a string, then as parsed JSON, then as bytes.

## Telegram behavior

For a request or notification with an attachment:

1. Send the document: `sendDocument(owner, new InputFile(bytes, name), { disable_notification:
   true })`. No caption, no buttons.
2. Send the text message as today (buttons for a request, Dismiss for a notification), with
   `reply_parameters: { message_id: <document message id> }`, so Telegram shows it as a reply quoting
   the document. This message pings the phone as today.
3. Return a reference that holds both ids.

Decision (made without user input): document first, then the text as a reply. The buttons stay on
the last message in the chat (nearest the thumb), the existing `finalize` edit (`editMessageText`)
keeps working unchanged, and the text can still be 3900 characters (a document caption is capped at
1024). Only the question pings, so the owner gets one notification, not two.

Failures:

- Document send fails: `SendError`, 502, nothing else is sent.
- Document sent but the text message fails: best-effort delete of the document (failure logged as
  one line), then `SendError`, 502. The owner never sees an orphan file without its question.
  Decision (made without user input).

Lifetime:

- Request settles (answer, timeout, cancel): only the text message is edited, as today. The
  document stays in the chat as the record of what was approved.
- Notification expires after 8 hours: delete both messages (`deleteMessages` with both ids, or two
  deletes; builder's choice). A failure is logged, as today.
- Dismiss: the tapped message deletes itself as today, and also deletes
  `callbackQuery.message.reply_to_message` when that message is from this bot and has a `document`.
  This needs no core state, so Dismiss still cleans up both after a restart. The bot-and-document
  check keeps it from deleting anything the owner wrote. grammY's types say `reply_to_message` is
  present on the callback's message unless the replied-to message is gone; if the owner deleted the
  document by hand, Dismiss just deletes the text.

`TelegramMessageReference` becomes `{ chatId, messageId, documentMessageId }` with
`documentMessageId: number | undefined` (always present, internal). `deleteMessage` deletes the
document too when it's set.

Telegram's provider declares `maxAttachmentBytes: 10_485_760` (`TELEGRAM_MAX_ATTACHMENT_BYTES` in
`src/telegram/constants.ts`).

## Provider seam and core

- `Provider` gains `maxAttachmentBytes?: number`. Absent means no attachment support: `/request` and
  `/notify` answer 501 for a body with `attachment`, and `/status` reports `0`. Like
  `maxTextLength`, it's static provider data so the parser, server and OpenAPI can read it without a
  runtime.
- New core type, in `approval/types.ts` since both endpoints use it: `Attachment = { readonly name:
  string; readonly content: Uint8Array }`. The parser decodes `text` (UTF-8) or `data` (base64) into
  `content`, so nothing past the parser knows which form the caller used.
- `ApprovalRequest` and `NotifyRequest` gain `attachment: Attachment | undefined` (always present).
- `Messenger.sendRequest` and `Notifier.sendNotification` (and the matching `ProviderRuntime`
  fields) take `attachment: Attachment | undefined` as a new last parameter. A provider without
  `maxAttachmentBytes` never receives one.
- The attachment schema lives next to `createTextSchema` and `createProjectSchema` in
  `approval/parser.ts` (`createAttachmentSchema(maxAttachmentBytes)`), shared by both body schemas.
  `createApprovalRequestSchema` and `createNotifyRequestSchema` take the limit as a second argument.
  How the "unsupported" 501 is produced (a pre-check in the server on `Object.hasOwn(json,
  'attachment')`, or a third parse result kind) is the builder's call; the behavior above is fixed.
- `ApiServerOptions` gains `maxAttachmentBytes: number | undefined`; `startService` fills it from
  the provider.
- Memory: once the send resolves, nothing on the `/request` path should keep the attachment
  reachable while it waits (up to 300 s). Without care that's about 35 MiB per pending request: the
  raw body string, the parsed JSON with its base64, and the decoded bytes. Required:
  - `PendingRequests.open` stores the request without the attachment (only what `answer` and the
    timeout need). Today it stores the whole `ApprovalRequest`.
  - `ApprovalService.request` takes what it needs after the wait (`text`, options) into locals
    before awaiting, so the async frame doesn't hold the full request. Today it reads
    `request.text` after `await settled`.
  - The `/request` handler doesn't keep `request.body`, `json` or the parsed value alive across
    `await service.request(...)`: clear `request.body` after parsing and keep only what the call
    needs in scope.
  - `NotificationService` already keeps only the reference; `/notify` returns right after the send.
  Decision (made without user input), settling the builder check's question: this is a
  reachability requirement enforced by code shape and review, not proven by a heap-level test.
  Tests check the pending entry has no `attachment`; no `--expose-gc`/`WeakRef` test, which would
  be flaky and slow for a single-owner tool with a handful of pending requests.
- Never log attachment names or contents. Existing `SendError` logging stays as is.

## Clients

All three host-side callers (MCP server, `send` CLI, Node `Client`) share one helper in
`src/client/` that turns caller input into the wire shape. It never throws and returns a
`{ kind: 'ok', attachment } | { kind: 'failed', message }` result like `postApi`:

- `{ path, name? }`: `stat` first; missing file, a directory, or over `MAX_ATTACHMENT_BYTES` fails
  without reading. Then read and send as `data` (base64). `name` defaults to `basename(path)`.
- `{ name, text }`: sent as `text` as is.
- `{ name, data }` (Node `Client` only): bytes sent as `data`.
- Stdin (CLI only, see below): read to the end, same size cap, sent as `data`.

Failure messages, lowercase, path quoted: `attachment "<path>" not found`, `attachment "<path>" is
not a file`, `attachment "<path>" is over 10485760 bytes`, `couldn't read attachment "<path>":
<reason>`. Exact wording is the builder's.

Relative paths resolve against the caller's working directory (for MCP, the directory the agent
started the server in). Decision (made without user input): no sandboxing of paths. The MCP server
runs as the user, next to an agent that can already read those files, and the only destination is
the owner's own chat.

### Compatibility preflight

When a call has an attachment, the client does `GET /status` first:

- Connection failure: the existing "not reachable" message.
- No `maxAttachmentBytes` field: fail with `telegram-ask service is too old for attachments (run
  telegram-ask init to upgrade)`, like `TOO_OLD_MESSAGE` for notifications.
- `maxAttachmentBytes` is `0`: `attachments not supported by this provider`.
- File bigger than `maxAttachmentBytes`: fail before uploading, same message as the size error.

Then the POST as usual. The service's own checks still apply (curl users don't preflight). Decision
(made without user input): one extra loopback round trip per attachment call is worth never
silently dropping the file against an old service. `postApi` is POST only today, so this needs a
small GET (or a `method` option) in `client/http.ts`; still `node:http`, still never throws.

### Timeouts

Uploading up to 10 MiB to Telegram can take longer than `FETCH_GRACE_MS` (30 s) on a slow uplink,
and the approval timer only starts after the send. Calls with an attachment add
`ATTACHMENT_GRACE_MS = 120_000` to their HTTP timeout (both `/notify` and `/request`). Decision
(made without user input) on the number; grammY's own API timeout is longer than that already.

### MCP

`ask_for_permission` and `notify_user` gain an optional `attachment` parameter:

| Param             | Type   | Required        | Notes                                                                     |
| ----------------- | ------ | --------------- | ------------------------------------------------------------------------- |
| `attachment.path` | string | one of the two  | File to attach, read by the MCP server. Absolute, or relative to its cwd. |
| `attachment.text` | string | one of the two  | Text to attach, e.g. a diff you already have in context.                  |
| `attachment.name` | string | no              | File name in Telegram. Default: the path's basename, or `attachment.txt`. |

Decision (made without user input): no base64 `data` on MCP. Agents have files on disk or text in
context; asking a model to emit base64 wastes tokens and corrupts easily. And the `attachment.txt`
default for `text` so agents don't have to invent names, though the description should suggest a
real extension (`.diff`, `.log`) since Telegram uses it.

Tool descriptions get one sentence each, along the lines of "Attach a file (path) or long text (over
3900 characters, such as a diff or log) to show the user as a document above the message." The zod
input schema enforces exactly one of `path` and `text`. Failures (from the helper, the preflight or
the service) come back as tool errors (`isError: true`), like today.

### CLI

`send request` and `send notify` gain:

```
--attach <file>        attach a file; "-" reads stdin
--attach-name <name>   file name shown in Telegram (default: the file's basename, "attachment.txt" for stdin)
```

```
git diff | telegram-ask send request 'Push this?' -o Push -o Stop --timeout-option Stop \
  --attach - --attach-name changes.diff
```

Helper failures print `telegram-ask: <message>` and exit 1 like other send failures.
`--attach-name` without `--attach` is a usage error (exit 2). Decision (made without user input):
stdin support, because piping a diff or log is the shell's natural way to do this.

### Node Client

`AskRequest` and `Notification` gain `attachment?: AttachmentInput`, exported from the package:

```ts
type AttachmentInput =
  | { readonly path: string; readonly name?: string }
  | { readonly name: string; readonly text: string }
  | { readonly name: string; readonly data: Uint8Array }
```

Helper and preflight failures throw `TelegramAskError` with the same messages. Decision (made
without user input): the union is told apart by which key is present, mirroring the wire shape,
rather than by a `kind` field; it reads better at call sites and matches the JSON body.

## Docs

- README: the `attachment` rows in both body tables, the 501 row on `/request`, the 413 row's new
  size, the curl and `jq` examples, the "document above the message, kept after the answer, deleted
  with the notification" behavior, the escaping note, the MCP params, the CLI flags, the `Client`
  field, and a line that attachments need a service at least this new (clients say so if not).
- OpenAPI (`src/server/openapi.ts`): an `Attachment` component generated from the zod schema, the
  field on both bodies, 501 on `/request`, the new body size in `PayloadTooLarge`, and
  `maxAttachmentBytes` in `Status`. `OpenApiOptions` gains `maxAttachmentBytes` so the served spec
  shows the provider's limit. Regenerate `docs/openapi.yaml` with `npm run openapi`.

## Tests

Following the existing files and fakes (`test/provider/fake.ts`, `vi.fn` bot API stubs):

- Parser: text and data forms; line-wrapped base64 accepted; URL-safe and garbage base64 rejected;
  empty content; exactly at and one over the limit; neither or both of `text`/`data`; `null`; each
  name rule; decoded `content` bytes match; body without `attachment` gives `attachment: undefined`.
- Server: a body over 64 KiB with an attachment is accepted; 413 just over 14 MiB; 501 for a fake
  provider without `maxAttachmentBytes` only when `attachment` is present; check order; `/status`
  includes `maxAttachmentBytes` (and `0` without support).
- Approval and notification services with a fake messenger: the attachment reaches
  `sendRequest`/`sendNotification`; the pending entry doesn't hold it after the send.
- Telegram adapter: `sendDocument` called before `sendMessage` with `disable_notification` and the
  reply id; reference holds both ids; text send failure deletes the document and throws; expiry
  deletes both; Dismiss deletes the replied-to document only when it's the bot's and a document;
  no attachment behaves exactly as today (no `sendDocument` call).
- Client helper: path read, basename default, missing file, directory, over cap (via `stat`, without
  reading), stdin.
- Preflight against a `node:http` server on port 0: old status body without the field, `0`, too
  large, then the normal POST.
- MCP: schema rejects both or neither of `path`/`text`; a path attachment reaches the fake service
  as base64; helper failures are tool errors.
- CLI: `--attach file`, `--attach -`, `--attach-name` alone exits 2.
- OpenAPI: `Attachment` present on both bodies; limit reflects the options.

## Left to the builder

- File and function names within the module layout above, and whether the attachment helper is one
  file or two.
- How the 501 "attachments unsupported" is produced (server pre-check or parse result kind).
- Exact error wording, within the patterns above.
- `deleteMessages` vs two `deleteMessage` calls.
- Whether `MAX_BODY_BYTES` is computed from `MAX_ATTACHMENT_BYTES` or written as a literal with the
  arithmetic in a comment.
- How the base64 check is written (regex plus `Buffer.from`, or a round-trip comparison).

## Decisions (made without user input)

1. One attachment per call (`attachment`, not `attachments`).
2. Always sent as a Telegram document, never a photo.
3. No automatic overflow of long `text` into an attachment; `text` stays required.
4. JSON with base64 (`data`) or UTF-8 (`text`), no multipart.
5. `name` required on the HTTP API; invalid names rejected, not sanitized; no content-type field.
6. `null` attachment is a 400.
7. Base64 accepts line wraps, rejects the URL-safe alphabet and anything else.
8. 10 MiB attachment cap; body limit raised to 14 MiB for every body.
9. Check order: 501 for unsupported attachments after the JSON parse, before validation.
10. Document first, then the text as a reply to it; only the text pings; no caption.
11. Document sent but text failed: delete the document, return 502.
12. Request documents stay after settlement; notification documents are deleted with the
    notification (expiry and Dismiss).
13. Dismiss deletes the replied-to document statelessly, only when it's the bot's own document.
14. `Provider.maxAttachmentBytes` as the optional capability; `/status` reports it, `0` when
    unsupported.
15. Clients preflight `GET /status` for attachment calls so an old service can't silently drop the
    file.
16. Attachment calls get an extra 120 s of HTTP timeout.
17. Paths are read by the MCP server, CLI and `Client`, never the service; relative to the caller's
    cwd; no path sandboxing.
18. MCP takes `path` or `text` (no base64); `name` defaults to the basename or `attachment.txt`.
19. CLI `--attach FILE|-` and `--attach-name`; stdin supported.
20. Node `Client` input union told apart by key, not a `kind` field.
21. Memory anti-goal is end-to-end reachability on the `/request` path (pending map, service frame,
    handler locals and `request.body`), enforced by code shape; no heap-level test.
