# Free-text replies: design

Source: request on 2026-10-19 (no live conversation; every call below that isn't in the request
is marked "Decision (made without user input)"). Builds on the existing `/request`, MCP server,
provider seam and `Client`; what those do stays as it is unless this doc says otherwise.

## Intent

Today a question can only be answered by tapping one of its buttons, so callers are stuck with
yes/no or a fixed menu. An agent that wants to ask "which branch should I push to?" or "what should
the release be called?" can't. The request: an `allowText` flag on `POST /request` and on the MCP
`ask_for_permission` tool. With it set, the owner replies to the Telegram message and the text they
type becomes the answer.

## Goals

- `POST /request` accepts `allowText: boolean`. With it true, a text reply from the owner settles
  the question and its text is the `answer`.
- `ask_for_permission` accepts `allow_text: boolean` and forwards it.
- Buttons and text can be combined: an agent can offer `main` / `develop` as buttons and still let
  the owner type `feature/x`.
- A text-only question (no buttons) is possible.
- The response shape doesn't change: `{ "answer": "...", "timedOut": false }`.

## Non-goals

- Non-text replies (photos, voice, files, stickers). Ignored, with a hint (see Behavior).
- Multi-turn conversations; one question gets one answer.
- Telling the caller whether the answer was typed or tapped. Decision (made without user input):
  no new response field. A typed `Approve` and a tapped `Approve` mean the same thing, and adding a
  field means touching `isOutcome`, the MCP output schema, the Client's `Answer` and `--json`. Easy
  to add later as an extra field without breaking anyone.
- Answering across restarts. Since restart-safe pending state, open questions are saved to
  `state.json` and finalized as `⌛ Expired (service restarted)` on the next start; they can't be
  answered after that. The reply routing map is in memory only, so a reply to a pre-restart
  question lands in step 3 of Routing. That's the intended behavior, nothing extra to persist
  beyond the `hasButtons` flag in the message reference (see Sending).
- Using Telegram's `force_reply` markup. Decision (made without user input): it can't be combined
  with an inline keyboard in one message, `editMessageText` can't clear it, and with several open
  questions it pops the reply UI for the latest one only. A hint line does the job.
- Changing `/notify`.

## Anti-goals

- A reply landing on the wrong question. With several questions open, the owner's text must only
  ever settle the one they replied to, or none.
- A reply to a buttons-only question being taken as an answer. Existing API callers must see
  exactly the behavior they see today.
- The bot chattering at an owner who doesn't use text questions. Today the bot never answers plain
  chat messages from the owner. It may only start answering when the owner replies to one of its
  messages, or when an `allowText` question is open (see Routing).
- Someone other than the owner answering.
- A long reply breaking the final message edit (Telegram's 4096-char limit) and leaving buttons live.
- Pairing breaking because the new text handler swallows `/start CODE` messages.

## API

### `POST /request`

New field, and two changed rules:

| Field           | Type     | Required             | Notes                                                                                                   |
| --------------- | -------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `allowText`     | boolean  | no                   | Default `false`. When true, a text reply from the owner answers the question.                           |
| `options`       | string[] | unless `allowText`   | As today. With `allowText`, may be omitted or `[]` for a text-only question; if given, same rules.     |
| `timeoutOption` | string   | yes                  | Without `allowText`, must be one of `options` (as today). With it, any label-sized string (see below). |

Decision (made without user input): `options` becomes optional only when `allowText` is true.
"Which branch?" often has no sensible buttons, and forcing callers to invent a dummy button would
be worse than a conditional rule.

Decision (made without user input): with `allowText`, `timeoutOption` still has to be given (the
caller picks the safe default, same idea as today), but it no longer has to be one of `options`. It
follows the option label rules: non-empty, at most `MAX_OPTION_LENGTH` (64) characters. Today it's
indirectly capped by being an option; keeping a cap keeps the timeout result line short.

Validation messages (part of the API, like the existing ones; first issue wins):

- `allowText must be a boolean`
- Without `allowText`, missing or empty `options`: unchanged, `options must be a non-empty array`.
- With `allowText`, `options` present but not an array: `options must be an array`. Element rules and
  `options must be unique` unchanged.
- With `allowText`, bad `timeoutOption`: `timeoutOption must be a non-empty string of at most 64
  characters` (use the constant in the message, like `OPTION_ERROR` does).
- Without `allowText`, `timeoutOption must be one of options` unchanged.

Decision (made without user input, raised by the builder check): any body with a single problem gets
the same message as today. For bodies with several problems, which one is reported first may change:
the conditional `options` rule becomes an object-level check, and zod skips those while any field
fails, so e.g. no `options` plus a bad `timeout` now reports the `timeout` error first. That's fine;
"first issue wins" never promised an order across fields, and keeping it would mean a union schema
that turns the OpenAPI body into a `oneOf`. Keep one object schema. If existing tests pin a
multi-problem order, update them and say so in the commit.

Response: unchanged. `answer` is the tapped label, the typed text, or `timeoutOption` on timeout.
All existing status codes and their meanings are unchanged.

Old service, new caller: the body schema strips unknown keys, so an older service ignores
`allowText`. With buttons it sends a buttons-only question; without buttons it returns 400
`options must be a non-empty array`. Document this the same way the README documents `project`
("needs a service at least as new as this release; re-run `init`"). Decision (made without user
input): no version negotiation.

### MCP `ask_for_permission`

| Param            | Type     | Required           | Notes                                                                         |
| ---------------- | -------- | ------------------ | ----------------------------------------------------------------------------- |
| `allow_text`     | boolean  | no                 | Let the user type an answer by replying. Default false.                       |
| `options`        | string[] | unless `allow_text`| Button labels. May be omitted or empty with `allow_text`.                     |
| `timeout_option` | string   | yes                | One of `options`, or with `allow_text` any short answer (max 64 chars).       |

The MCP input schema loosens `options` to optional with no `min(1)`; the cross-field rules are left
to the service, whose 400 message comes back as the tool error (it already works that way for
`timeout_option must be one of options`). Decision (made without user input): forward `allowText`
only when `allow_text` is given, like `timeout`, so an MCP server talking to an old service sends
the same body it sends today for callers that don't use the flag.

The tool description's "wait for them to tap one of the options" becomes "wait for their answer",
and it gets one more sentence, roughly: "Set allow_text to also let the user type a
free-form answer (for questions like which branch or what name); options can then be empty." The
tool keeps its name. Output (text and `structuredContent`) unchanged.

### Client and CLI

Not in the request, but both wrap `/request` and the README promises the Client takes the `/request`
fields. Decision (made without user input): include them, thinly.

- `AskRequest` gets `allowText?: boolean`; `options` becomes optional with JSDoc "required unless
  `allowText`". The Client sends `allowText` and `options` only when defined. Validation stays in the
  service.
- `telegram-ask send request` gets `--allow-text`. `-o` stops being a commander `requiredOption`;
  the command checks it itself and exits 2 with a usage error when there's no `-o` and no
  `--allow-text` (matching how bad arguments exit today). Output unchanged: the answer on stdout,
  or `--json`.

### OpenAPI

`allowText` flows into the generated schema from the zod schema. Add a `BODY_DESCRIPTIONS` entry for
it, update the `options` and `timeoutOption` descriptions for the conditional rules, and the
`Outcome.answer` description to "The tapped option, the typed reply, or `timeoutOption`."
Regenerate `docs/openapi.yaml` with `npm run openapi`.

## Behavior

### Sending

The message is the question text as today. When `allowText` is set, the Telegram adapter appends a
blank line and a hint:

- with buttons: `Tap a button or reply to this message to type an answer.`
- without buttons: `Reply to this message with your answer.`

Decision (made without user input): wording above, as constants in `src/telegram/constants.ts`. The
hint isn't counted toward `maxTextLength`: 3900 leaves 196 characters of Telegram's 4096 for it, and
counting it would change the limit callers see. The core's `request.text` doesn't include it, so the
final edit drops it along with the buttons.

With no buttons, the message is sent without `reply_markup`.

`TelegramMessageReference` gets `hasButtons: boolean`, and finalize sends
`reply_markup: { inline_keyboard: [] }` only when it's true. Decision (made without user input):
the flag lives in the reference, not the in-memory map, because `expireOrphans` finalizes saved
requests after a restart, when the map is empty; the reference is the only thing saved to
`state.json` that the adapter owns. A reference without the field (state file from an older
version) counts as `hasButtons: true`, which is what every older message had. Whether Telegram
would accept an empty keyboard on a message that never had one doesn't matter then; nobody sends
it.

### Routing a text message

Owner messages are routed by a pure function in the adapter (alongside `routeTap`), fed by a new
`message` handler (not `message:text`: the non-text branch below needs photos, stickers and voice
too). In order:

1. Not from the owner in a private chat (`isOwnerCommand` already encodes this), or no owner yet:
   not ours, pass to the next handler (pairing). Silent.
2. A reply (`reply_to_message` set) to a message that is an open question:
   - question has `allowText`: settle it with the text. No chat reply; the edit is the feedback.
   - buttons-only question: reply `Tap one of the buttons to answer this question.`
3. A reply to any other message sent by the bot (a settled question, a question from before a
   restart, a notification, a `/pending` or `/history` reply): reply
   `That message isn't waiting for an answer.` The check is `reply_to_message.from.id` against the
   bot's own id (`bot.botInfo.id`). Decision (made without user input): the wording covers all of
   those, not only questions, since the adapter can't tell a settled question from any other old
   bot message once the map entry is gone.
4. A reply to a message the bot didn't send (e.g. the owner quoting their own message): treated as
   not a reply, steps 5 and 6.
5. Not a reply and starts with `/`: pass through. Silent. Registered commands (`/pending`,
   `/cancel`, `/history`) never get here, see handler order below; this catches things like a
   repeat `/start`. Replies are routed before this check on purpose: an answer like `/var/www` to
   "which path?" must count.
6. Not a reply, anything else:
   - exactly one open question with `allowText`: settle that one with the text.
   - more than one: reply `Several questions are open; reply to the one you're answering.`
   - none: pass through. Silent. Decision (made without user input): today the bot never answers
     plain chat messages after pairing, and an owner who only uses buttons shouldn't start getting
     "no question is waiting" replies to whatever they type. With no text question open there's
     nothing they could have meant to answer.

Decision (made without user input): the "not a reply, exactly one open text question" shortcut in
step 6. On a phone it's natural to open the chat and just type, and with one open text question
there's nothing to confuse it with. The race where a second question arrives while the owner types
lands in the "several" branch, never on the wrong question. Buttons-only questions don't count
toward "exactly one".

Decision (made without user input): bot replies in steps 2, 3 and 6 are sent as replies to the
owner's message, so it's clear what they refer to. Exact wording is the builder's to tweak; the
behavior isn't.

Handler order: tap handler, command handler, reply handler, pairing handler. Decision (made without
user input): the reply handler goes after `registerCommandHandler`. The command handler stops the
update for every registered command, owner or not, so `/pending` sent as a reply to a text question
runs `/pending` instead of becoming the answer `"/pending"`. The cost: a registered command name
can't be typed as an answer. Unregistered slash text (`/var/www`) still reaches the reply handler.

Settling details:

- The answer is the message text trimmed of surrounding whitespace. Decision (made without user
  input): phone keyboards add trailing spaces and a branch name with one is useless. Nothing else is
  changed; no length cap beyond Telegram's own 4096.
- First answer wins. A tap after a reply, or a second reply, gets the usual "expired" treatment
  (tap: `Expired` toast; reply: step 3 message, because by then the question is settled; a
  non-reply typed after the only text question settled falls under step 6 and is silent).
- A typed text equal to an option label is still a typed reply (shown with the reply marker below);
  the caller gets the same `answer` either way.
- Non-text messages from the owner (photo, sticker, voice) that reply to an open `allowText`
  question get `Only text replies count as an answer.`; anything else non-text is ignored.
  Decision (made without user input). A photo caption isn't taken as an answer.
- Edited messages are ignored; the first version is what counted.

### Final edit

The settled message becomes the original text, a blank line and a result line, as today. A typed
reply gets its own marker: `💬 <answer>, HH:MM`. Decision (made without user input): a new marker so
the chat history shows the answer was typed. The answer in the result line is cut to 200 characters
with a trailing `…` when longer; the caller still gets the full text. This keeps original (max 3900)
plus result line under 4096.

Timeout with `allowText` shows `⏱ Timed out, <timeoutOption>, HH:MM`, as today. `/cancel`
(`rejectAll`) works unchanged: `⛔ Rejected, <timeoutOption>, HH:MM`, and the caller gets
`timeoutOption`, which with `allowText` may be any short string.

### Owner commands

`/history` goes through `formatResultLine`, so typed answers show with the `💬` line (already
truncated to 200).

`/pending` lists each request's options, which is empty for a text-only question (today's
formatter would print `. 2 min left, then main`). The options part becomes:

- buttons only: `main, develop` (as today)
- buttons and text: `main, develop, or a typed reply`
- text only: `Typed reply`

Decision (made without user input): wording above; the joined options are truncated as today and
the suffix is appended after truncation so it never gets cut.

## Code shape

Match the repo's conventions where they differ from the global TS style (the repo uses exported
functions, `#private` fields, single quotes, no semicolons, `ok`/`kind` unions as they exist now).
Names below are suggestions; the builder can rename.

### Core (`src/approval/`)

- `ApprovalRequest` gets `readonly allowText: boolean`, always present (the parser fills `false`).
- `Settlement` gets a variant `{ readonly kind: 'replied'; readonly answer: string }`.
  `formatResultLine` handles it (`💬`, truncated). Exhaustive switches elsewhere must handle it;
  `ApprovalService.request` maps it to `timedOut: false`.
- `PendingRequests.reply(id, text): boolean`: false when the id is unknown, settled, or the request
  doesn't allow text; otherwise settles as `replied`. The core enforces `allowText` itself even
  though the adapter already checks, so a provider bug can't answer a buttons-only question.
- `ApprovalService.reply(id, text): 'accepted' | 'expired'`, the twin of `tap`.
- Parser: `createApprovalRequestSchema` gains `allowText`, the conditional `options` and
  `timeoutOption` rules, and passes `allowText` through the transform. `options` defaults to `[]`
  in the parsed value when omitted. The limit constants for the truncated answer (200) go in
  `constants.ts`.
- `Messenger.sendRequest` gets the flag so the adapter can add the hint and track the question.
  Decision (made without user input): a fourth positional parameter `allowText: boolean`, matching
  the existing positional style, rather than switching to an object and churning every fake.
- `formatPendingReply` handles empty options and `allowText` (see Owner commands).
- Fix JSDoc that stops being true: `ApprovalRequest` ("`timeoutOption` is in `options`"),
  `ApprovalService` ("waits for a tap"), `Settlement` ("`answer` is the chosen option"), the
  Client's `ask` and `Answer` ("the tapped option").

### Provider seam (`src/provider/types.ts`, `src/daemon/service.ts`)

- `ProviderRuntime.sendRequest` gets the same fourth parameter.
- `RuntimeHandlers` gets `reply: (id: string, text: string) => 'accepted' | 'expired'`, wired in
  `startService` to `service.reply`.
- Decision (made without user input): text replies are a required part of the contract, not an
  optional one with a 501 like notifications. Telegram is the only provider, and a future one
  without replies can still accept the flag and never call `reply`. Revisit if a second provider
  shows up that can't do it.

### Telegram (`src/telegram/`)

- The messenger keeps an in-memory map from Telegram message id to `{ id, allowText }` for every
  open question: set right after `sendMessage` resolves, deleted in `finalize`. Telegram message ids
  are only unique per chat; there's only the owner's chat, but key on `chatId` and `messageId`
  together anyway, it's cheap. The map lives in the runtime
  closure next to `owner`, and the routing function reads it.
- Between settle and `finalize` the map still holds the entry; the core returns `expired` and the
  adapter sends the step 3 message. That's correct, no extra sync needed.
- `TelegramMessageReference` gets `hasButtons: boolean` (optional when read back from state, see
  Sending). `finalize` reads it, and deletes the map entry.
- A new `registerReplyHandler(bot, owner, openQuestions, reply, log)` registers `message` handling.
  In `createTelegramRuntime.start` it's called after `registerCommandHandler` and before
  `registerPairingHandler` (see handler order in Routing). It calls `next()` for anything it passes
  through (steps 1, 5 and the silent branch of 6), so pairing keeps working. Failed bot replies are
  logged, not thrown (as for Dismiss deletes).
- The pure routing function (inputs: sender id, chat type, owner id, bot id, text or its absence,
  reply-to message key and sender id, the open questions, the `reply` callback) returns a route the
  handler turns into a chat reply or nothing. Suggested route kinds: `ignored`, `accepted`,
  `expired`, `buttonsOnly`, `notOpen`, `ambiguous`, `notText`. Plain text with no text question
  open is `ignored`.
- New reply types (`Reply`, the route union) go in `src/telegram/types.ts` next to `Tap` and
  `TapRoute`.

### MCP, Client, CLI, server

- MCP: schema and forwarding as above.
- Client: `AskRequest` and `#post` body as above.
- CLI: `--allow-text`, own `-o` check.
- Server: nothing besides what the parser change brings.

## Docs

README: the "How it works" paragraph mentions replies; the `ask_for_permission` table and
`POST /request` table get the new and changed rows; a short paragraph under "Ask a question" with
the text-only example:

```
curl -s -X POST http://127.0.0.1:8787/request \
  -H 'content-type: application/json' \
  -d '{"text":"Which branch?","allowText":true,"timeoutOption":"main","timeout":120}'
```

plus the reply rules from Behavior in a few sentences (reply to the message, or just type when it's
the only open question), the old-service note, and `--allow-text` in the commands list and "From the
shell". `docs/openapi.yaml` regenerated.

## Tests

Same style as the existing suites (`vite-plus/test`, fake timers, `FakeMessenger`, fake provider).

- Parser: `allowText` true with no `options`, with `[]`, with options; `allowText` false or absent
  with no `options` keeps today's error; `allowText` non-boolean; `timeoutOption` not in options is
  fine with `allowText` and still rejected without; empty and 65-char `timeoutOption` with
  `allowText`; parsed value has `allowText: false` and `options: []` defaults.
- Pending and service: reply settles an `allowText` request with `replied`; reply to a buttons-only
  request is `expired` and doesn't settle it; reply after a tap, tap after a reply, reply after
  timeout and after cancel are `expired`; the result is `{ answer, timedOut: false }`; finalize gets
  the `💬` line.
- Formatter: `replied` line; truncation at exactly 200 and 201 characters.
- Telegram adapter: hint appended only with `allowText`, both wordings; no `reply_markup` without
  buttons; reference carries `hasButtons`; finalize skips `reply_markup` for `hasButtons: false`
  and sends it for `true` and for a reference without the field; map entry added on send and
  removed on finalize; every routing branch in Behavior, including non-owner and group-chat
  passthrough, `/` passthrough for non-replies, a reply starting with `/` (e.g. `/var/www`)
  settling an `allowText` question, a reply to a non-question bot message (notification) getting
  the step 3 reply, a reply to the owner's own message routed as a non-reply, the single-open
  shortcut ignoring buttons-only questions, "several open", and plain text with no text question
  open staying silent; `/pending` sent as a reply to an open text question runs the command and
  leaves the question open; pairing still works with the reply handler registered (a
  `/start CODE` from a non-owner reaches the pairing handler).
- Formatter: `/pending` lines for buttons only, buttons and text, text only.
- Restart: `expireOrphans` on a saved text-only request finalizes without `reply_markup`.
- Daemon: `reply` handler wired to the service (fake provider calls `handlers.reply`).
- Server: `/request` with `allowText` end to end through a fake provider, answered by
  `handlers.reply`.
- MCP: `allow_text` forwarded; omitted when not given; empty `options` allowed through to the
  service; service 400 comes back as a tool error.
- Client and CLI: `allowText` sent; `send request --allow-text` without `-o` works; no `-o` and no
  `--allow-text` exits 2.
- OpenAPI: the snapshot or assertions in `test/server/openapi.test.ts` updated for the new field.

## Left to the builder

- Exact bot reply wording and the hint wording, within the behavior above.
- Route kind names, helper names, and where the open-question map type lives.
- Order of commits.
