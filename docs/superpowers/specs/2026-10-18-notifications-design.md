# Notifications: design

Source: brainstorming conversation on 2026-10-18. Builds on
`2026-10-18-telegram-approval-bot-design.md` and `2026-10-18-provider-seam-design.md`; what those
describe stays as it is unless this doc says otherwise.

## Intent

Today the bot only asks questions: `POST /request` holds the connection until the owner taps an
answer. The owner also wants it to just tell them things. Their example: someone joins their Core
Keeper server, n8n fires an HTTP call, and a message shows up in Telegram. Nobody needs to answer
it, so the caller shouldn't wait, and the chat shouldn't fill up with stale pings.

## Goals

- New endpoint `POST /notify` that sends a plain text message to the owner and returns as soon as
  the message is sent.
- The message has one button, Dismiss. Tapping it deletes the message.
- The message deletes itself 8 hours after it was sent if nobody dismissed it.
- Fits the provider seam: notifications are an optional provider part, Telegram implements them.

## Non-goals

- Telling the caller whether or when the notification was dismissed.
- A per-request expiry, or a configurable one. 8 hours, fixed (owner's decision, "for now").
- Markdown or other formatting. Plain text only.
- Surviving restarts (see "Known issue").
- Changing `POST /request`.

## Anti-goals

- n8n's call hanging or timing out because the bot waits for something after the send.
- A notification tap being taken for an approval answer, or the other way round.
- An auto-delete or dismiss failure crashing the service.

## API

`POST /notify` on the same host and port as `/request`, JSON body:

| Field  | Type   | Required | Notes                                                        |
| ------ | ------ | -------- | ------------------------------------------------------------ |
| `text` | string | yes      | Shown in Telegram. Non-empty (after trim), max 3900 chars.   |

Extra fields are ignored, as with `/request`. On success: `200 { "ok": true }`, returned once the
provider accepted the message.

Errors are JSON `{ "error": "..." }`, same rules as `/request`:

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 400    | Body isn't valid JSON or fails validation. Nothing is sent.             |
| 413    | Body over 64 KiB.                                                       |
| 501    | The selected provider doesn't support notifications.                    |
| 502    | Message couldn't be sent.                                               |
| 503    | Not paired.                                                             |
| 405    | Method isn't POST (with `Allow: POST`).                                 |
| 500    | Internal error.                                                         |

The 502 body is whatever the shared error handler says for `/request` at the time (today "failed
to send Telegram message", "failed to send message" after the seam refactor). My call: one handler,
no separate wording.

Validation error text for `text` matches `/request`'s (`text must be a non-empty string`,
`text must be at most 3900 characters`). The 3900 limit follows the seam doc: it becomes a
per-provider value, the same one `/request` uses.

Example:

```
curl -s -X POST http://127.0.0.1:8787/notify \
  -H 'content-type: application/json' \
  -d '{"text":"alice joined the Core Keeper server"}'
```

## Behavior

1. Request arrives. Checks run in this order (my call): provider supports notifications (else
   501), paired (else 503, same position as in `/request`), body valid (else 400).
2. The core generates a notification id (as it does for request ids) and the provider sends the
   text to the owner with a Dismiss button carrying that id. The core gets back an opaque message
   reference.
3. The HTTP response goes out (`200`).
4. The core starts an 8-hour timer for that notification.
5. Owner taps Dismiss: the message is deleted and the timer cleared.
6. Timer fires first: the message is deleted.

Details:

- Dismiss works after a restart too. The button tap carries the message it's on, so Telegram can
  delete it without the core's in-memory state (my call). A tap on a notification the core no longer
  knows about just deletes the message; nothing to clear.
- A failed delete (owner already deleted the message by hand, Telegram's 48-hour bot delete limit,
  network) is logged as one line and otherwise ignored. A failed delete on Dismiss still answers the
  tap so the button stops spinning (my call: no "Expired" toast; the message either goes or the
  owner can delete it by hand).
- Taps from anyone but the owner are ignored, as today.
- Dismiss taps and approval taps must be told apart by their button payload. Today approval buttons
  use `<id>:<optionIndex>` (`CALLBACK_DATA_PATTERN`). Notification buttons need a payload that can't
  match that pattern and an approval payload must not be read as a dismiss. Exact format left to the
  builder (Telegram caps callback data at 64 bytes).
- Many notifications can be live at once; each has its own timer.
- On shutdown, pending timers are dropped with the process.
- Notifications ping the phone normally (no silent send).

### Known issue: restarts

The 8-hour timers live in memory. If the service restarts (update, reboot, crash) before a
notification's 8 hours are up, that message is never auto-deleted. Dismiss still works. Owner's
decision: accept this for now and revisit when the project gets sqlite. Document it in the README.

## Provider seam

The seam doc lists required and optional provider parts. Notifications add optional parts:

- **Send notification**: core-generated id and text in, opaque reference out. The provider adds a dismiss control if it
  can.
- **Delete message**: reference in. Used by the 8-hour timer.
- **Report dismiss**: the provider tells the core "notification X was dismissed" through a callback
  the core passes in, so the core clears the timer. Whether the provider deletes the message itself
  on dismiss or the core calls delete is left to the builder; the result must be that the message is
  gone and the timer cleared.

The core owns the 8-hour timer, not the provider (my call), so a future provider gets expiry for
free if it can delete.

When parts are missing (my call; no second provider exists yet, so this is only covered by fake
providers in tests):

- No send notification: `/notify` returns `501 { "error": "notifications not supported" }`.
- Send but no delete: message is sent without a dismiss control and no timer is started.

Order relative to the seam refactor: the seam doc isn't implemented yet. If the seam lands first,
add these as optional provider parts. If notifications land first, add them to today's `Messenger`
shape (Telegram adapter + `ApprovalService`-side logic) in a way that maps one-to-one onto those
optional parts, so the seam refactor moves them rather than redesigns them. Builder's choice of
order.

## Tests

- Parser: valid body, missing/empty/whitespace/too-long text, non-object body, extra fields kept out
  of the result.
- Server: `/notify` happy path returns `200 { ok: true }`, 400/413/503/502/501 cases, GET `/notify`
  gives 405 with `Allow: POST`, `/request` unaffected.
- Core with a fake provider and fake timers (the repo uses `vi.useFakeTimers()`): delete called at
  exactly 8 hours and not before; dismiss before 8 hours clears the timer so delete isn't called
  again; delete failure is logged, not thrown; dismiss for an unknown id is harmless.
- Fake provider without notification parts: `/notify` returns 501. Fake provider with send but no
  delete: sends, no timer.
- Telegram: dismiss payload format round-trips; an approval payload isn't routed as a dismiss and a
  dismiss payload isn't routed as an approval; non-owner dismiss is ignored.

## README

Add `/notify` to the API section: body table, response, error table, curl example, the 8-hour
auto-delete, Dismiss, and the restart known issue.

## Left to the builder

- Module layout (a `notify` module vs living next to approval code), type names, constant names.
- Dismiss callback payload format, within the constraints above.
- Whether delete-on-dismiss happens in the provider or via the core.
- Order relative to the seam refactor.

## My calls (not discussed with the owner)

- Core owns the 8-hour timer and generates notification ids.
- Check order: 501, then 503, then 400.
- 502 text shared with `/request`.
- Missing notification support → 501; send without delete → no button, no timer.
- Dismiss deletes from the tapped message itself, so it keeps working after a restart.
- Failed deletes are logged and ignored; no "Expired" toast on a failed dismiss.
- Button label "Dismiss".
- Notifications aren't silent.
