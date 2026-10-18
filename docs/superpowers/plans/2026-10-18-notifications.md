# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /notify` sends a plain text message with a Dismiss button to the owner, returns once sent, and the message is deleted on Dismiss or after 8 hours.

**Architecture:** New `src/notify/` module holds the body parser and `NotificationService`, which sends via a `Notifier` (the optional provider part), owns one 8-hour timer per notification and clears it on dismiss. The Telegram messenger implements `Notifier`; the existing callback handler routes `dismiss/<id>` payloads to a delete-from-context plus `NotificationService.dismiss`. The server gets an optional notifications dependency; absent means 501. Built before the seam refactor, shaped so the seam moves `Notifier` into the provider's optional parts unchanged.

**Tech Stack:** Node 24, TypeScript, fastify, grammY, zod, vite-plus (`vp test`, `vp check`, `vp fmt`).

**Spec:** `docs/superpowers/specs/2026-10-18-notifications-design.md`

## Global Constraints

- Work on branch `main` in place. No new branches or worktrees.
- Follow the repo's existing idiom (functions plus `#private` classes, `vite-plus/test`, short test names like `svc`, `req`), not a different style.
- Cross-module imports go through `../<module>/index.ts`. Tests import from `src/<module>/index.ts`.
- Expiry is exactly 8 hours: `NOTIFICATION_TTL_MS = 8 * 60 * 60 * 1000` (`28_800_000`).
- Button label exactly `Dismiss`.
- Text limit is `MAX_TEXT_LENGTH` (3900); error texts `text must be a non-empty string` and `text must be at most 3900 characters`, identical to `/request`.
- Success body exactly `{ "ok": true }`. 501 body exactly `{ "error": "notifications not supported" }`.
- Check order in `/notify`: 501, then 503 (`{ error: 'not paired' }`), then 400.
- Failed deletes are logged as one line with `console.error` and never thrown.
- Verify with: `npx tsc -p tsconfig.json`, `npx vp check`, `npx vp test`.
- Format with `npx vp fmt` before committing.
- No em-dashes anywhere. Commits conventional, lowercase summary, no `Co-Authored-By` trailer, no Claude attribution.

## Review Focus

- Owner deleted the message by hand, then the 8h timer fires: delete fails, one log line, service keeps running, entry gone. (Task 1 test `expiry delete failure is logged and not thrown`.)
- Dismiss tapped on a notification the service doesn't know (after a restart): message still deleted, tap answered. (Task 2 test `handler: dismiss for unknown id still deletes the message`.)
- Dismiss double-tapped or message already gone: `deleteMessage` throws, tap still answered, nothing thrown. (Task 2 test `handler: failed dismiss delete is logged and the tap answered`.)
- Several live notifications: dismissing one leaves the others' timers. (Task 1 test `dismissing one notification leaves the others`.)
- Unpaired with an invalid body gets 503, not 400; no notifications support gets 501 even when unpaired. (Task 3 tests `POST /notify is 503 while unpaired, before validation` and `POST /notify is 501 without notifications, before pairing check`.)

---

### Task 1: notify module (parser and service)

**Files:**
- Modify: `src/approval/parser.ts` (extract the `text` schema)
- Modify: `src/approval/index.ts`
- Create: `src/notify/constants.ts`, `src/notify/types.ts`, `src/notify/parser.ts`, `src/notify/service.ts`, `src/notify/index.ts`
- Test: `test/notify/parser.test.ts`, `test/notify/service.test.ts`

**Interfaces:**
- Consumes: `MessageReference`, `SendError`, `MAX_TEXT_LENGTH` from `../approval/index.ts`.
- Produces:
  - `src/approval/parser.ts`: `export const requestTextSchema` (the existing `text` zod schema, moved out of `approvalRequestSchema` and reused by it). Re-exported from `src/approval/index.ts`.
  - `src/notify/constants.ts`: `export const NOTIFICATION_TTL_MS = 28_800_000`.
  - `src/notify/types.ts`:
    ```ts
    /** As produced by `parseNotifyRequest`. */
    export type NotifyRequest = { readonly text: string }
    /** Outcome of validating a /notify body; `error` is the client-facing message. */
    export type NotifyParseResult =
      | { readonly ok: true; readonly value: NotifyRequest }
      | { readonly ok: false; readonly error: string }
    /** Optional provider part for notifications. Without `deleteMessage` there's no dismiss button and no expiry. */
    export type Notifier = {
      readonly sendNotification: (id: string, text: string) => Promise<MessageReference>
      readonly deleteMessage?: (reference: MessageReference) => Promise<void>
    }
    ```
  - `src/notify/parser.ts`: `export function parseNotifyRequest(body: unknown): NotifyParseResult`. Never throws; first issue as `error`; non-object body gives `body must be a JSON object`; extra fields dropped.
  - `src/notify/service.ts`:
    ```ts
    export class NotificationService {
      constructor(notifier: Notifier, newId?: () => string, log?: (line: string) => void)
      /** Resolves once sent and the expiry timer is started. Throws `SendError` if sending fails. */
      notify(request: NotifyRequest): Promise<void>
      /** Clears the expiry timer; false when the id is unknown or already expired. */
      dismiss(id: string): boolean
      /** Live notifications with a pending expiry. */
      get size(): number
    }
    ```
    Defaults: `newId = () => crypto.randomUUID()`, `log = console.error`.
  - `src/notify/index.ts` re-exports `NOTIFICATION_TTL_MS`, `parseNotifyRequest`, `NotificationService`, and types `Notifier`, `NotifyRequest`, `NotifyParseResult`.

- [ ] **Step 1: Write failing parser tests** in `test/notify/parser.test.ts`:
  - `valid body`: `parseNotifyRequest({ text: 'hi' })` equals `{ ok: true, value: { text: 'hi' } }`.
  - `extra fields are dropped`: `{ text: 'hi', foo: 1 }` gives `{ ok: true, value: { text: 'hi' } }`.
  - `text at the limit is accepted`: `'a'.repeat(3900)` is ok.
  - `text over the limit`: `'a'.repeat(3901)` gives `{ ok: false, error: 'text must be at most 3900 characters' }`.
  - `test.each([undefined, '', '   ', 5])('bad text %s', ...)`: `{ text: value }` gives `{ ok: false, error: 'text must be a non-empty string' }`.
  - `test.each([null, [], 'x'])('non-object body %s', ...)`: gives `{ ok: false, error: 'body must be a JSON object' }`.

- [ ] **Step 2: Write failing service tests** in `test/notify/service.test.ts`, with `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`, and a `FakeNotifier` class (records `sent: { id, text }[]` and `deleted: MessageReference[]`, optional `sendError` / `deleteError`, returns `{ chatId: 1, messageId: <n> }` with `n` incrementing from 1). `setup()` builds `new NotificationService(m, () => \`id${++count}\`, log)` with `log = vi.fn()`.
  - `notify sends and starts the expiry`: after `await svc.notify({ text: 'hi' })`, `m.sent` equals `[{ id: 'id1', text: 'hi' }]`, `svc.size` is 1, `m.deleted` is `[]`.
  - `deletes at exactly 8 hours`: advance `NOTIFICATION_TTL_MS - 1`, `m.deleted` is `[]`; advance 1 more (use `vi.advanceTimersByTimeAsync`), `m.deleted` equals `[{ chatId: 1, messageId: 1 }]`, `svc.size` is 0.
  - `dismiss clears the expiry`: `svc.dismiss('id1')` is `true`; advance `NOTIFICATION_TTL_MS`; `m.deleted` is `[]`; `svc.size` is 0.
  - `dismissing one notification leaves the others`: notify twice, dismiss `id1`, advance `NOTIFICATION_TTL_MS`, `m.deleted` equals `[{ chatId: 1, messageId: 2 }]`.
  - `dismiss for an unknown or expired id returns false`: `svc.dismiss('nope')` is `false`; after expiry of `id1`, `svc.dismiss('id1')` is `false`.
  - `expiry delete failure is logged and not thrown`: `m.deleteError = new Error('message to delete not found')`; advance `NOTIFICATION_TTL_MS`; `log` called once with `'failed to delete notification: message to delete not found'`; `svc.size` is 0.
  - `send failure throws SendError with cause and starts no timer`: `m.sendError = new Error('boom')`; `svc.notify(...)` rejects with an instance of `SendError` whose `cause` is that error; `svc.size` is 0.
  - `without deleteMessage no timer is started`: notifier object with only `sendNotification`; after notify, `svc.size` is 0.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vp test test/notify`
Expected: FAIL, cannot resolve `src/notify/index.ts`.

- [ ] **Step 4: Implement** the files listed in Interfaces. `requestTextSchema` is the current `text:` chain from `approvalRequestSchema`, moved verbatim (keep `TEXT_ERROR` in `src/approval/parser.ts`). `parseNotifyRequest` uses `z.object({ text: requestTextSchema }, { error: 'body must be a JSON object' })` and the same `safeParse` / first-issue pattern as `parseApprovalRequest`. `NotificationService` keeps `#timers = new Map<string, ReturnType<typeof setTimeout>>()`; `notify` wraps only the send in `try/catch` and throws `new SendError('failed to send notification', { cause })`; the timer callback removes the entry first, then awaits `deleteMessage` and logs `failed to delete notification: <message>` on failure (`error instanceof Error ? error.message : String(error)`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vp test test/notify test/approval`
Expected: PASS (approval tests prove the schema move changed nothing).

- [ ] **Step 6: Commit**

```bash
npx vp fmt
git add src/approval src/notify test/notify
git commit -m "feat: add notification service with 8 hour expiry"
```

### Task 2: Telegram notifications and dismiss

**Files:**
- Modify: `src/telegram/constants.ts`, `src/telegram/adapter.ts`, `src/telegram/types.ts`, `src/telegram/index.ts`
- Test: `test/telegram/adapter.test.ts`

**Interfaces:**
- Consumes: `Notifier` from `../notify/index.ts`; `Messenger`, `MessageReference` from `../approval/index.ts`.
- Produces:
  - `src/telegram/constants.ts`: `DISMISS_LABEL = 'Dismiss'`; `DISMISS_DATA_PATTERN = /^dismiss\/([^:]+)$/` (no `:` allowed, so it can never match `CALLBACK_DATA_PATTERN`, and approval payloads, which always contain `:`, can never match it).
  - `src/telegram/types.ts`: `export type Dismiss = (id: string) => boolean`.
  - `src/telegram/adapter.ts`:
    - `export function formatDismissData(id: string): string` returns `` `dismiss/${id}` ``.
    - `export function parseDismissData(data: string | undefined): string | undefined` returns the id or `undefined`.
    - `createTelegramMessenger(bot, owner): Messenger & Notifier`, adding `sendNotification(id, text)` (throws `bot is not paired yet` when `owner.id` is undefined, like `sendRequest`; sends with `reply_markup: { inline_keyboard: [[{ text: DISMISS_LABEL, callback_data: formatDismissData(id) }]] }`) and `deleteMessage(reference)` (`bot.api.deleteMessage(reference.chatId, reference.messageId)`).
    - `registerTapHandler(bot, owner, tap, dismiss: Dismiss, log: (line: string) => void = console.error): void`. In the existing `callback_query:data` handler, check `parseDismissData` first. Dismiss payload from the owner: call `dismiss(id)`, then `await context.deleteMessage()` in its own `try/catch` that logs `failed to delete notification: <message>`, then `answerCallbackQuery()` with no text. Dismiss payload from anyone else: `answerCallbackQuery()` only. Other payloads: unchanged `routeTap` path.
  - `src/telegram/index.ts` also exports `formatDismissData`, `parseDismissData`, and type `Dismiss`.

- [ ] **Step 1: Write failing tests** in `test/telegram/adapter.test.ts`. Extend `fakeBot().run` so the context also has `deleteMessage` (a `vi.fn(async () => true)`, overridable via a third `deleteMessage` argument) and return it. Add `vi.fn()` as the 4th argument to the three existing `registerTapHandler` calls.
  - `formatDismissData format`: `formatDismissData('abc')` is `'dismiss/abc'`.
  - `formatDismissData fits 64 bytes with a UUID`: `Buffer.byteLength(formatDismissData(crypto.randomUUID()))` is `<= 64`.
  - `dismiss and approval payloads don't overlap`: `parseDismissData(formatDismissData('abc'))` is `'abc'`; `parseDismissData('abc:0')` and `parseDismissData('dismiss/abc:0')` are `undefined`; `routeTap(42, formatDismissData('abc'), 42, tap)` is `'expired'` with `tap` not called.
  - `sendNotification sends text with one Dismiss button`: `sendMessage` called with `(42, 'hi', { reply_markup: { inline_keyboard: [[{ text: 'Dismiss', callback_data: 'dismiss/id1' }]] } })`, result `{ chatId: 42, messageId: 5 }`.
  - `sendNotification throws when unpaired`: owner `{ id: undefined }`, rejects, `sendMessage` not called.
  - `deleteMessage deletes by reference`: `bot.api.deleteMessage` called with `(42, 5)`.
  - `handler: owner dismiss deletes the message and calls dismiss`: `dismiss` called with `'id1'`, `deleteMessage` called once, `answerCallbackQuery` called with no arguments, `tap` not called.
  - `handler: dismiss for unknown id still deletes the message`: `dismiss = vi.fn(() => false)`; `deleteMessage` still called once; `answerCallbackQuery` with no arguments.
  - `handler: failed dismiss delete is logged and the tap answered`: `deleteMessage` rejects `new Error('message to delete not found')`; handler promise resolves; `log` called with `'failed to delete notification: message to delete not found'`; `answerCallbackQuery` called.
  - `handler: non-owner dismiss is ignored`: from id 7; `dismiss` and `deleteMessage` not called; `answerCallbackQuery` called with no arguments.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vp test test/telegram/adapter.test.ts`
Expected: FAIL, `formatDismissData` not exported.

- [ ] **Step 3: Implement** per Interfaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vp test test/telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx vp fmt
git add src/telegram test/telegram
git commit -m "feat: send notifications with a dismiss button on telegram"
```

Note: `src/daemon/service.ts` won't type-check after this task (missing 4th `registerTapHandler` argument) until Task 3. If the reviewer gates on `tsc`, pass `() => false` there temporarily in this task and replace it in Task 3.

### Task 3: `/notify` endpoint, daemon wiring, README

**Files:**
- Modify: `src/server/server.ts`, `src/daemon/service.ts`, `README.md`
- Test: `test/server/server.test.ts`

**Interfaces:**
- Consumes: `NotificationService`, `parseNotifyRequest` from `../notify/index.ts`; `createTelegramMessenger`, `registerTapHandler` from Task 2.
- Produces: `createApiServer(service, status, notifications?: Pick<NotificationService, 'notify'>): FastifyInstance`. Omitted means notifications unsupported (501).

- [ ] **Step 1: Write failing tests** in `test/server/server.test.ts`. Give `start` an optional third parameter `notifications` passed through to `createApiServer`, and add `postNotify(url, body)` mirroring `post` for `/notify`. `NotifyFn = (req: NotifyRequest) => Promise<void>`.
  - `POST /notify returns ok once sent`: status 200, JSON `{ ok: true }`, `notify` called with `{ text: 'hi' }`.
  - `POST /notify 400 on bad JSON and bad text, notify not called`: bodies `'{not json'`, `JSON.stringify({ text: '' })`, `'null'` each give 400 with a non-empty `error`; `notify` not called.
  - `POST /notify 502 on SendError`: `notify` rejects `new SendError('x')`, status 502.
  - `POST /notify 413 on 70 KB body`: same body construction as the existing 413 test, status 413.
  - `POST /notify is 503 while unpaired, before validation`: status `{ paired: false, code: 'ABCD-EFGH', bot: 'b' }`; body `'{not json'` gives 503 with `{ error: 'not paired' }`; `notify` not called.
  - `POST /notify is 501 without notifications, before pairing check`: no third argument, unpaired status; status 501, JSON `{ error: 'notifications not supported' }`.
  - `GET /notify is 405 with Allow: POST`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vp test test/server`
Expected: FAIL, `/notify` returns 404.

- [ ] **Step 3: Implement** the route in `src/server/server.ts`: add `/notify` to the not-found handler's 405 branch alongside `/request`; `app.post<{ Body: string | undefined }>('/notify', ...)` with checks in Global Constraints order, same JSON parse as `/request`, then `await notifications.notify(parsed.value)` and return `{ ok: true }`. `SendError` already maps to 502 through the shared error handler. Update the `createApiServer` JSDoc to mention `POST /notify`.

- [ ] **Step 4: Wire the daemon** in `src/daemon/service.ts`: keep the messenger in a `const messenger = createTelegramMessenger(bot, owner)`, build `const notifications = new NotificationService(messenger)`, pass `(id) => notifications.dismiss(id)` as `registerTapHandler`'s 4th argument, and `notifications` as `createApiServer`'s 3rd.

- [ ] **Step 5: README**: in the API section, after the `/request` errors and before Security, add a `POST /notify` subsection: body table (`text` only), `200 { "ok": true }` returned as soon as Telegram accepts the message, the Dismiss button deletes it, it's deleted automatically after 8 hours, error table (400, 413, 501, 502, 503, 405, 500), the curl example from the spec, and a known-issue line: expiry timers live in memory, so a restart within 8 hours leaves that message in the chat (Dismiss still works). Also change the `/request` error table's 404 row from "Path isn't `/request`" to cover both paths. Match the existing README voice; no em-dashes.

- [ ] **Step 6: Run the full verification**

Run: `npx tsc -p tsconfig.json && npx vp check && npx vp test`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
npx vp fmt
git add src/server src/daemon README.md test/server
git commit -m "feat: add POST /notify"
```
