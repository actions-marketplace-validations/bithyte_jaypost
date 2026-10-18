# Telegram Approval Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local HTTP API (`POST /request`) that posts a question with buttons to the owner's Telegram chat and blocks until the owner taps an option or the request times out.

**Architecture:** Pure core (validation, pending-request registry with timers, result formatting) behind a small `ApprovalService` that talks to a `Messenger` interface. A grammY implementation of `Messenger` handles Telegram (long polling); a `node:http` server exposes the API. TypeScript runs directly on Node 24 (native type stripping), so there's no build step; Vite+ provides test, lint, format and typecheck.

**Tech Stack:** Node 24, TypeScript, Vite+ (`vp`), grammY, `node:http`.

**Spec:** `docs/superpowers/specs/2026-10-18-telegram-approval-bot-design.md`

## Global Constraints

- Node 24 (installed v24.21.0). TypeScript. Vite+ toolchain, version pinned (pre-1.0).
- Erasable TS syntax only (no enums, namespaces, parameter properties), relative imports use `.ts` extensions, `"type": "module"`.
- API binds `127.0.0.1` by default; only Docker sets `HOST=0.0.0.0`, published as `-p 127.0.0.1:PORT:PORT`.
- Only the owner's Telegram user id may answer. Every other user/chat is ignored.
- `timeout` in seconds, default 300, values above 300 clamped to 300, non-positive or non-number → 400.
- `timeoutOption` required and must be one of `options`.
- Response: `200 { "answer": string, "timedOut": boolean }`. Errors: `{ "error": string }`.
- Result lines: `✅ <answer>, HH:MM`, `⏱ Timed out, <answer>, HH:MM`, `🚫 Cancelled, HH:MM` (24h local time, zero-padded).
- Default port 8787.
- Runtime dependency: `grammy` only.
- Commit messages: no Co-Authored-By or Claude attribution. No em-dashes anywhere.

## Review Focus

- A non-owner taps a button (bot added to a group, message forwarded): ignored, request stays pending. Test in Task 7.
- Double tap, or tap racing the timeout: first settlement wins, HTTP response sent once, later tap gets "expired". Test in Task 3.
- Owner deleted the Telegram message before answer/timeout, so the final edit fails: caller still gets its answer. Test in Task 4.
- Body isn't JSON, is JSON `null`/array, or is huge: 400 (413 over 64 KB), no Telegram message sent. Test in Task 5.
- `text` longer than Telegram allows (4096) or duplicate option labels: 400 up front instead of a 502 from Telegram or ambiguous buttons. Test in Task 2.

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts   (from Vite+ scaffold)
src/types.ts          shared types
src/format.ts         result line formatting
src/validate.ts       request body validation
src/pending.ts        pending registry + timers
src/messenger.ts      Messenger interface
src/approvals.ts      ApprovalService (orchestration)
src/http.ts           node:http API server
src/config.ts         config load/save
src/telegram.ts       grammY Messenger + tap routing
src/main.ts           entry point
scripts/onboard.ts    interactive onboarding
scripts/test-request.ts
deploy/telegram-approval-bot.service
deploy/install-service.sh
Dockerfile, .dockerignore, README.md
tests/*.test.ts
```

---

### Task 1: Scaffold, toolchain, types, result formatting

**Files:**
- Create: project scaffold, `src/types.ts`, `src/format.ts`
- Test: `tests/format.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/types.ts
  export interface ApprovalRequest { text: string; options: string[]; timeoutOption: string; timeoutSeconds: number }
  export interface Outcome { answer: string; timedOut: boolean }
  export type Settlement =
    | { kind: 'answered'; answer: string }
    | { kind: 'timedOut'; answer: string }
    | { kind: 'cancelled' }
  // src/format.ts
  export function resultLine(s: Settlement, at: Date): string
  export function finalText(original: string, s: Settlement, at: Date): string // `${original}\n\n${resultLine(s, at)}`
  ```

- [ ] **Step 1: Install Vite+ and scaffold**

Install the `vp` CLI per https://viteplus.dev (VoidZero docs). Scaffold a plain Node/TS project in the repo root (not a frontend app), keep `docs/`. Pin the `vite-plus` version in `package.json` (exact, no `^`). Set `"type": "module"`, `"engines": { "node": ">=24" }`. Add `grammy` as a dependency.

tsconfig must include: `"module": "nodenext"`, `"noEmit": true`, `"allowImportingTsExtensions": true`, `"erasableSyntaxOnly": true`, `"verbatimModuleSyntax": true`, `"strict": true`.

package.json scripts: `"start": "node src/main.ts"`, `"onboard": "node scripts/onboard.ts"`, `"test-request": "node scripts/test-request.ts"`, `"test": "vp test"`, `"check": "vp check"`. Confirm the exact `vp` subcommands for test and lint/format/typecheck against the docs and adjust these two scripts if they differ. Confirm the test import path the scaffold uses (expected `vite-plus/test`); every test in this plan imports from it.

- [ ] **Step 2: Write failing test `tests/format.test.ts`**

```ts
const at = new Date(2026, 9, 18, 9, 5)
test('answered', () => expect(resultLine({ kind: 'answered', answer: 'Approve' }, at)).toBe('✅ Approve, 09:05'))
test('timed out', () => expect(resultLine({ kind: 'timedOut', answer: 'Decline' }, at)).toBe('⏱ Timed out, Decline, 09:05'))
test('cancelled', () => expect(resultLine({ kind: 'cancelled' }, at)).toBe('🚫 Cancelled, 09:05'))
test('finalText appends line', () =>
  expect(finalText('Deploy?', { kind: 'answered', answer: 'Yes' }, at)).toBe('Deploy?\n\n✅ Yes, 09:05'))
```

- [ ] **Step 3: Run `npm test`, expect FAIL (module not found)**
- [ ] **Step 4: Implement `src/types.ts` and `src/format.ts`**
- [ ] **Step 5: Run `npm test` and `npm run check`, expect PASS / no errors**
- [ ] **Step 6: Commit** (include `docs/`): `git commit -m "Scaffold project with Vite+, add result formatting"`

---

### Task 2: Request validation

**Files:**
- Create: `src/validate.ts`
- Test: `tests/validate.test.ts`

**Interfaces:**
- Consumes: `ApprovalRequest` (Task 1)
- Produces:
  ```ts
  export const MAX_TIMEOUT_SECONDS = 300
  export const MAX_TEXT_LENGTH = 3900 // leaves room for the appended result line under Telegram's 4096
  export type ParseResult = { ok: true; value: ApprovalRequest } | { ok: false; error: string }
  export function parseApprovalRequest(body: unknown): ParseResult
  ```

- [ ] **Step 1: Write failing tests**

```ts
const base = { text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }
test('valid, default timeout', () =>
  expect(parseApprovalRequest(base)).toEqual({ ok: true, value: { ...base, timeoutSeconds: 300 } }))
test('custom timeout', () => expect(parseApprovalRequest({ ...base, timeout: 30 })).toMatchObject({ ok: true, value: { timeoutSeconds: 30 } }))
test('timeout clamped', () => expect(parseApprovalRequest({ ...base, timeout: 900 })).toMatchObject({ ok: true, value: { timeoutSeconds: 300 } }))
test.each([0, -5, '30', null, Number.NaN, Infinity])('bad timeout %s', t =>
  expect(parseApprovalRequest({ ...base, timeout: t }).ok).toBe(false))
test.each([
  ['not object', 'hi'], ['null', null], ['array', []],
  ['missing text', { ...base, text: undefined }], ['empty text', { ...base, text: '' }],
  ['text too long', { ...base, text: 'x'.repeat(3901) }],
  ['options not array', { ...base, options: 'Approve' }], ['empty options', { ...base, options: [], timeoutOption: 'x' }],
  ['non-string option', { ...base, options: ['Approve', 1] }], ['empty option label', { ...base, options: ['Approve', ''] }],
  ['duplicate options', { ...base, options: ['Approve', 'Approve'], timeoutOption: 'Approve' }],
  ['missing timeoutOption', { ...base, timeoutOption: undefined }],
  ['timeoutOption not in options', { ...base, timeoutOption: 'Maybe' }],
])('%s rejected', (_n, body) => {
  const r = parseApprovalRequest(body)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement `parseApprovalRequest`.** Error strings name the offending field (e.g. `"timeoutOption must be one of options"`).
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `"Add request validation"`

---

### Task 3: Pending request registry

**Files:**
- Create: `src/pending.ts`
- Test: `tests/pending.test.ts`

**Interfaces:**
- Consumes: `ApprovalRequest`, `Settlement` (Task 1)
- Produces:
  ```ts
  export class PendingRequests {
    open(id: string, req: ApprovalRequest): Promise<Settlement> // starts timer of req.timeoutSeconds
    answer(id: string, optionIndex: number): boolean // false if unknown/settled id or index out of range
    cancel(id: string): boolean                       // false if unknown/settled
    get size(): number
  }
  ```
  Settling (any path) clears the timer and removes the id. Timeout settles `{ kind: 'timedOut', answer: req.timeoutOption }`.

- [ ] **Step 1: Write failing tests** (use fake timers: `vi.useFakeTimers()` from the test import)

```ts
const req = { text: 't', options: ['Approve', 'Decline'], timeoutOption: 'Decline', timeoutSeconds: 10 }
test('answer settles with option label', async () => {
  const p = new PendingRequests(); const s = p.open('a', req)
  expect(p.answer('a', 0)).toBe(true)
  await expect(s).resolves.toEqual({ kind: 'answered', answer: 'Approve' }); expect(p.size).toBe(0)
})
test('timeout settles with timeoutOption', async () => {
  const p = new PendingRequests(); const s = p.open('a', req)
  vi.advanceTimersByTime(9999); expect(p.size).toBe(1)
  vi.advanceTimersByTime(1)
  await expect(s).resolves.toEqual({ kind: 'timedOut', answer: 'Decline' })
})
test('second answer and answer after timeout return false', async () => {
  const p = new PendingRequests(); p.open('a', req); p.answer('a', 1)
  expect(p.answer('a', 0)).toBe(false)
  p.open('b', req); vi.advanceTimersByTime(10_000); expect(p.answer('b', 0)).toBe(false)
})
test('out of range index returns false and keeps pending', () => {
  const p = new PendingRequests(); p.open('a', req)
  expect(p.answer('a', 2)).toBe(false); expect(p.answer('a', -1)).toBe(false); expect(p.size).toBe(1)
})
test('cancel settles cancelled, then answer is false', async () => {
  const p = new PendingRequests(); const s = p.open('a', req)
  expect(p.cancel('a')).toBe(true); await expect(s).resolves.toEqual({ kind: 'cancelled' })
  expect(p.answer('a', 0)).toBe(false)
})
test('independent concurrent requests', async () => {
  const p = new PendingRequests(); const a = p.open('a', req); const b = p.open('b', { ...req, timeoutSeconds: 5 })
  vi.advanceTimersByTime(5000); p.answer('a', 0)
  await expect(b).resolves.toMatchObject({ kind: 'timedOut' }); await expect(a).resolves.toMatchObject({ kind: 'answered' })
})
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** with a `Map<string, { req, timer, resolve }>`.
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `"Add pending request registry"`

---

### Task 4: Messenger interface and ApprovalService

**Files:**
- Create: `src/messenger.ts`, `src/approvals.ts`
- Test: `tests/approvals.test.ts`

**Interfaces:**
- Consumes: `PendingRequests` (Task 3), `finalText` (Task 1), types (Task 1)
- Produces:
  ```ts
  // src/messenger.ts
  export interface MessageRef { chatId: number; messageId: number }
  export interface Messenger {
    sendRequest(id: string, text: string, options: string[]): Promise<MessageRef>
    finalize(ref: MessageRef, text: string): Promise<void> // replace text, remove buttons
  }
  // src/approvals.ts
  export class SendError extends Error {}
  export class ApprovalService {
    constructor(messenger: Messenger, now?: () => Date, newId?: () => string) // defaults: new Date(), crypto.randomUUID
    request(req: ApprovalRequest, signal?: AbortSignal): Promise<Outcome | null> // null = cancelled; throws SendError if sendRequest rejects
    tap(id: string, optionIndex: number): 'accepted' | 'expired'
  }
  ```
  `request` flow: sendRequest (on rejection throw `SendError`, nothing left pending) → `pending.open` → if `signal` aborts, `pending.cancel(id)` → on settlement call `messenger.finalize(ref, finalText(req.text, settlement, now()))`, catching and logging (`console.error`) any finalize error → return Outcome (`timedOut: settlement.kind === 'timedOut'`) or `null`. If `signal` is already aborted after send, cancel immediately.

- [ ] **Step 1: Write failing tests** with a `FakeMessenger` recording `sent` and `finalized` calls (`finalize` can be made to reject).

```ts
test('tap resolves request and finalizes message', async () => {
  const m = new FakeMessenger(); const svc = new ApprovalService(m, () => at, () => 'id1')
  const r = svc.request(req); await flush()
  expect(m.sent).toEqual([{ id: 'id1', text: 'Deploy?', options: ['Approve', 'Decline'] }])
  expect(svc.tap('id1', 0)).toBe('accepted')
  await expect(r).resolves.toEqual({ answer: 'Approve', timedOut: false })
  expect(m.finalized).toEqual([{ ref: m.ref, text: 'Deploy?\n\n✅ Approve, 09:05' }])
})
test('timeout returns timeoutOption, timedOut true')        // fake timers; finalize text has '⏱ Timed out, Decline, 09:05'
test('tap on unknown or settled id returns expired')
test('send failure throws SendError and leaves nothing pending') // sendRequest rejects; expect(r).rejects.toBeInstanceOf(SendError)
test('abort cancels: returns null, finalizes with Cancelled, later tap expired')
test('finalize failure still returns the answer')          // finalize rejects; outcome still { answer: 'Approve', timedOut: false }
```

`flush` = `await new Promise(r => setImmediate(r))` (or the fake-timer equivalent) so `sendRequest` has resolved before tapping.

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `"Add approval service"`

---

### Task 5: HTTP API server

**Files:**
- Create: `src/http.ts`
- Test: `tests/http.test.ts`

**Interfaces:**
- Consumes: `ApprovalService`, `SendError` (Task 4), `parseApprovalRequest` (Task 2)
- Produces: `export function createApiServer(service: Pick<ApprovalService, 'request'>): http.Server`

Routes and statuses:
- `POST /request` valid → wait → `200 { answer, timedOut }`.
- Invalid JSON or validation failure → `400 { error }`, `service.request` not called.
- Body over 65536 bytes → `413 { error }`.
- `SendError` → `502 { error: "failed to send Telegram message" }`. Other errors → `500`.
- Other method on `/request` → `405`; other path → `404`.
- Client disconnects before the response is written (`res.on('close')` with `!res.writableEnded`) → abort the `AbortSignal` passed to `service.request`.
- All responses `Content-Type: application/json`.

- [ ] **Step 1: Write failing tests.** Start the server on port 0 at `127.0.0.1`, use `fetch`. Use a stub service whose `request` is a `vi.fn()`.

```ts
test('200 with outcome')               // stub resolves { answer: 'Approve', timedOut: false }; body equals it
test('400 on non-JSON body, service not called')
test('400 on JSON null and on validation failure, error message present')
test('413 on 70 KB body')
test('502 on SendError')
test('404 on GET /other, 405 on GET /request')
test('client abort triggers signal')   // stub returns a never-resolving promise and records the signal;
                                       // fetch with AbortController, abort after 50 ms; expect signal.aborted true (poll briefly)
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `"Add HTTP API"`

---

### Task 6: Config

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Config { botToken: string; ownerId: number; port: number; host: string }
  export const DEFAULT_PORT = 8787
  export function configPath(env?: NodeJS.ProcessEnv): string
  // APPROVAL_BOT_CONFIG, else $XDG_CONFIG_HOME/telegram-approval-bot/config.json, else ~/.config/telegram-approval-bot/config.json
  export function loadConfig(env?: NodeJS.ProcessEnv): Config
  // reads file if it exists ({ botToken, ownerId, port }), then env overrides BOT_TOKEN, OWNER_ID, PORT, HOST.
  // host defaults to '127.0.0.1', port to 8787. Throws Error mentioning `npm run onboard` if botToken or ownerId missing/invalid.
  export function saveConfig(path: string, c: Omit<Config, 'host'>): void // mkdir -p, write JSON, mode 0o600
  ```

- [ ] **Step 1: Write failing tests** using a temp dir (`fs.mkdtempSync`).

```ts
test('configPath precedence: APPROVAL_BOT_CONFIG > XDG_CONFIG_HOME > HOME')
test('save then load roundtrip, host defaults to 127.0.0.1')
test('saved file has mode 0o600')
test('env overrides file values; env-only config works with no file')  // BOT_TOKEN, OWNER_ID='42' -> ownerId 42, PORT, HOST
test('missing token or non-numeric OWNER_ID throws mentioning onboard')
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `"Add config loading"`

---

### Task 7: Telegram adapter and entry point

**Files:**
- Create: `src/telegram.ts`, `src/main.ts`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: `Messenger`, `MessageRef` (Task 4), `ApprovalService.tap` (Task 4), `loadConfig` (Task 6), `createApiServer` (Task 5)
- Produces:
  ```ts
  export function callbackData(id: string, optionIndex: number): string // `${id}:${optionIndex}` (UUID + index fits Telegram's 64-byte limit)
  export type TapRoute = 'ignored' | 'accepted' | 'expired'
  export function routeTap(fromId: number, data: string | undefined, ownerId: number,
    tap: (id: string, optionIndex: number) => 'accepted' | 'expired'): TapRoute
  // 'ignored' if fromId !== ownerId; 'expired' if data malformed; else tap(...)
  export function createTelegramMessenger(bot: Bot, ownerId: number): Messenger
  // sendRequest: bot.api.sendMessage(ownerId, text, { reply_markup: inline keyboard, one button per row })
  // finalize: bot.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } })
  export function registerTapHandler(bot: Bot, ownerId: number, tap: ...): void
  // on callback_query:data → routeTap → 'accepted': answerCallbackQuery(); 'expired': answerCallbackQuery({ text: 'Expired' }); 'ignored': answerCallbackQuery()
  ```
  Messages are plain text (no `parse_mode`) so request text is shown verbatim. The bot ignores all non-owner messages; no other commands needed.

- [ ] **Step 1: Write failing tests for the pure parts**

```ts
test('callbackData format', () => expect(callbackData('abc', 1)).toBe('abc:1'))
test('non-owner tap ignored, tap not called', () => {
  const tap = vi.fn(); expect(routeTap(7, 'abc:0', 42, tap)).toBe('ignored'); expect(tap).not.toHaveBeenCalled()
})
test('owner tap routed', () => {
  const tap = vi.fn(() => 'accepted' as const)
  expect(routeTap(42, 'abc:1', 42, tap)).toBe('accepted'); expect(tap).toHaveBeenCalledWith('abc', 1)
})
test.each([undefined, '', 'abc', 'abc:', 'abc:x', ':1'])('malformed data %s → expired', d =>
  expect(routeTap(42, d, 42, vi.fn())).toBe('expired'))
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement `src/telegram.ts`**
- [ ] **Step 4: Implement `src/main.ts`:** `loadConfig()` (print error and exit 1 on failure), create `Bot`, messenger, `ApprovalService`, register tap handler, `createApiServer(service).listen(port, host)`, `bot.start()` (long polling). Log `listening on host:port` and bot username. On `SIGTERM`/`SIGINT`: `bot.stop()`, `server.close()`, exit. If `bot.start()` fails with a 409, log that another instance is polling with this token and exit 1.
- [ ] **Step 5: Run `npm test` and `npm run check`, expect PASS**
- [ ] **Step 6: Commit** `"Add Telegram adapter and entry point"`

---

### Task 8: Onboarding and test script

**Files:**
- Create: `scripts/onboard.ts`, `scripts/test-request.ts`

**Interfaces:**
- Consumes: `saveConfig`, `configPath`, `loadConfig`, `DEFAULT_PORT` (Task 6)

`scripts/onboard.ts` (interactive, `node:readline/promises`):
1. If a config exists, say it will be overwritten and ask to confirm.
2. Prompt for bot token; validate with `new Bot(token).api.getMe()`; re-prompt on failure.
3. Print `Send /start to @<username> from your Telegram account.` Poll `bot.api.getUpdates({ offset, timeout: 30 })` until a private-chat message with text `/start` arrives; take `from.id`. Ask `Use account <first_name> (@username, id <id>)? [Y/n]`.
4. Send that user `Linked. Approval requests will appear here.`
5. Prompt for port, default 8787.
6. `saveConfig(configPath(), …)`, print the path and `npm start` next step.
Warn up front that the service must be stopped during onboarding (a running poller gets updates first).

`scripts/test-request.ts`: port from `loadConfig()` if it loads, else `PORT` env, else 8787. POST `{ text: 'This is a test', options: ['Approve', 'Decline'], timeoutOption: 'Decline' }` to `http://127.0.0.1:<port>/request`; print HTTP status and the JSON body; exit 1 on non-200 or connection error with a readable message.

- [ ] **Step 1: Implement both scripts**
- [ ] **Step 2: `npm run check`, expect no errors**
- [ ] **Step 3: Manual end-to-end (needs the owner's bot token and phone).** Run `npm run onboard`, then `npm start`, then in another shell:
  - `npm run test-request`, tap Approve → prints `200 { answer: 'Approve', timedOut: false }`; message shows `✅ Approve, HH:MM`, no buttons.
  - Run again, wait 5 min → `{ answer: 'Decline', timedOut: true }`, message shows `⏱ Timed out, Decline, HH:MM`.
  - Run again, Ctrl-C the script → message shows `🚫 Cancelled, HH:MM`. Tap any old button → "Expired" popup.
  - Two test-requests at once, answer in either order → each gets its own answer.
  If the executor can't do this (no token/phone), stop and hand these steps to the owner.
- [ ] **Step 4: Commit** `"Add onboarding and test request scripts"`

---

### Task 9: systemd service, Docker, README

**Files:**
- Create: `deploy/telegram-approval-bot.service`, `deploy/install-service.sh`, `Dockerfile`, `.dockerignore`, `README.md`

systemd (user service, so config lives in the owner's home and no root is needed):
- Unit template with `WorkingDirectory=@REPO@`, `ExecStart=@NODE@ src/main.ts`, `Restart=on-failure`, `RestartSec=5`, `WantedBy=default.target`.
- `install-service.sh`: refuses to run if no config file exists (point to `npm run onboard`); substitutes `@REPO@` (repo absolute path) and `@NODE@` (`command -v node`, must be v24+); writes `~/.config/systemd/user/telegram-approval-bot.service`; `systemctl --user daemon-reload && systemctl --user enable --now telegram-approval-bot`. Prints, does not run, `loginctl enable-linger $USER` with a note that it keeps the service up while logged out.

Docker:
- `node:24-slim`, install production deps only, copy `src/`, `ENV HOST=0.0.0.0`, `EXPOSE 8787`, `CMD ["node", "src/main.ts"]`, run as the `node` user.
- Config via env (`BOT_TOKEN`, `OWNER_ID`, `PORT`) or a mounted file with `APPROVAL_BOT_CONFIG`.

README: what it is, onboarding, `npm start`, `npm run test-request`, API contract (fields, statuses, response), systemd install, Docker run (`docker run -d --env-file .env -p 127.0.0.1:8787:8787 telegram-approval-bot`), and that only one instance (systemd or Docker) may run per bot token.

- [ ] **Step 1: Write the files**
- [ ] **Step 2: Verify systemd:** `bash -n deploy/install-service.sh`; if a config exists, run it and check `systemctl --user status telegram-approval-bot` is active and `npm run test-request` works against it. Otherwise report it as untested.
- [ ] **Step 3: Verify Docker:** `docker build -t telegram-approval-bot .` succeeds. If a token is available, run with `-p 127.0.0.1:8787:8787` and repeat the test request (stop the systemd service first). Otherwise report as untested.
- [ ] **Step 4: Run `npm test` and `npm run check`, expect PASS**
- [ ] **Step 5: Commit** `"Add systemd service, Dockerfile and README"`
