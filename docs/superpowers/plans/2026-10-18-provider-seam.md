# Provider Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything Telegram-specific lives behind one `Provider` contract, Telegram is the only registered provider, and its user-visible behavior is unchanged apart from the two wording changes the spec allows.

**Architecture:** New `src/provider/` holds the contract types, the registry (`PROVIDERS`) and generic settings helpers; new `src/pairing/` holds the provider-independent pairing code. `src/telegram/` becomes the Telegram provider: settings declaration, setup half (credential check, prompt text) and runtime half (grammY bot, taps, pairing, notifications). Config, install targets, commands and the daemon work from the provider's declared settings and never name `botToken`/`ownerId`. The daemon splits into a testable `startService` (wires a provider runtime to `ApprovalService`, `NotificationService` and the API) and the thin `runService` shell.

**Tech Stack:** Node 24, TypeScript, fastify, grammY, zod, commander, @clack/prompts, vite-plus (`vp test`, `vp check`, `vp fmt`).

**Spec:** `docs/superpowers/specs/2026-10-18-provider-seam-design.md`. Also read `docs/superpowers/specs/2026-10-18-notifications-design.md` ("Provider seam" section): notifications already shipped against `Messenger`/`Notifier` and move into the provider's optional parts unchanged.

## Global Constraints

- Work on branch `main` in place. No new branches or worktrees.
- The package and binary are `telegram-ask` (renamed after the spec was written). Wherever the spec says `telegram-approval-bot`, use `telegram-ask`. No renames.
- Follow the repo's existing idiom (exported functions, classes with `#private` fields, `vite-plus/test` with `vi.fn`, short test names), not a different style. Cross-module imports go through `../<module>/index.ts`; tests import from `src/<module>/index.ts`.
- Outside `src/telegram/`, nothing imports `grammy` or names `botToken`, `ownerId`, `BOT_TOKEN`, `OWNER_ID`, `/start` or `t.me`. Exceptions: `src/commands` may call the Telegram-exported `formatLegacyInstructions` for old `/status` bodies (Task 5), and test fixtures.
- Telegram strings stay byte-identical, except: uninstall prompt becomes `Also delete the saved credentials and paired owner?`, and the 502 body becomes `{ "error": "failed to send message" }`.
- Missing `provider` (config.json, env, `.env`, install.json) means `telegram`. Unknown name error, exactly: `` unknown provider "<name>"; run `telegram-ask init` `` (name via `JSON.stringify`).
- New env files always contain `PROVIDER=<name>`; new systemd `config.json` always contains `"provider"`; new install.json records `provider`.
- Telegram config keys stay top-level in `config.json`. No migration, no file rewritten just because it's old.
- Every value of a setting marked `secret` is masked in init error output and only ever written to `0o600` files.
- Telegram text limit is `3900`, now Telegram's `maxTextLength`, not a core constant.
- Verify with: `npx tsc -p tsconfig.json && npx vp check && npx vp test`. Each task's commit leaves all three passing.
- Format with `npx vp fmt` before committing.
- No em-dashes anywhere. Commits conventional, lowercase summary, no `Co-Authored-By` trailer, no Claude attribution.

## Review Focus

- Existing installs from 0.1.x: `.env` without `PROVIDER`, `config.json` without `provider`, install.json without `provider`. All read as Telegram, owner kept, no re-pair. (Task 3 `old config without provider loads as telegram`; Task 6 `readSecrets on an old env file reads as telegram`, `old install.json without provider resolves to telegram`.)
- A newer CLI talking to an older pinned container: `/status` returns `{ paired, bot }` / `{ paired, code, bot }`. `status` prints today's text and `reset-owner` doesn't time out as `notStarted`. (Task 5 `waitForPairing accepts the old status shape`, `status prints old-shape pairing text`.)
- SIGTERM while polling: grammY's polling promise settles after `stop()`; that must not be reported as fatal or exit 1. (Task 4 `polling ending after stop is not fatal`.)
- Pairing succeeds but the config file can't be written: one log line, the owner works in memory, `/status` says paired. (Task 4 `owner save failure is logged and pairing still completes`.)
- A setting value containing a newline would inject lines into `.env`. `formatEnvFile` throws `RangeError` instead of writing it. (Task 6 `formatEnvFile rejects a value with a newline`.)

---

### Task 1: generic pairing module

**Files:**
- Create: `src/pairing/constants.ts`, `src/pairing/pairing.ts`, `src/pairing/types.ts`, `src/pairing/index.ts`
- Delete: `src/telegram/pairing.ts`; move `PAIRING_ALPHABET`, `PAIRING_CODE_LENGTH`, `DEFAULT_MAX_FAILURES`, `CODE_SEPARATOR_PATTERN` out of `src/telegram/constants.ts`
- Modify: `src/telegram/adapter.ts`, `src/telegram/types.ts`, `src/telegram/index.ts`, `src/daemon/service.ts`
- Test: move `test/telegram/pairing.test.ts` to `test/pairing/pairing.test.ts`; `test/telegram/adapter.test.ts`

**Interfaces:**
- Produces (`src/pairing/index.ts`):
  - `generateCode(random?: (max: number) => number): string`, `formatCode(code: string): string` (unchanged behavior).
  - `class Pairing { constructor(code: string, maxFailures?: number); get code(): string | undefined; get paired(): boolean; attempt(senderId: string, text: string): PairResult }`. Normalizing is trim, uppercase, strip `CODE_SEPARATOR_PATTERN`; no `/start` handling. Failure map keyed on `string`.
  - `type PairResult = 'paired' | 'wrong' | 'blocked' | 'notPairing'` (moved from telegram).
- Telegram: `START_COMMAND_PATTERN` stays in `src/telegram/constants.ts`. `handlePairingMessage` strips it (`text.trim().replace(START_COMMAND_PATTERN, '')`) and passes `String(message.fromId)` to `pairing.attempt`. `createOnPaired` and `onPaired` callbacks still take `number` in this task.

- [ ] **Step 1: Move and adapt tests.** `test/pairing/pairing.test.ts` imports from `src/pairing/index.ts`; sender ids become strings (`attempt('1', ...)`). Replace the `/start` cases in `accepts %s` with `['K7QM-4XPD', 'k7qm4xpd', 'K7QM 4XPD', '  k7qm-4xpd ']`, and add `'/start K7QM-4XPD' is wrong without telegram stripping`: `new Pairing('K7QM4XPD').attempt('1', '/start K7QM-4XPD')` is `'wrong'`. In `test/telegram/adapter.test.ts` add `handlePairingMessage strips /start and /start@bot`: for `'/start K7QM-4XPD'` and `'/start@my_bot k7qm4xpd'` the reply is `'Paired. Approval requests will appear here.'` and `onPaired` gets `42`.
- [ ] **Step 2: Run** `npx vp test test/pairing test/telegram`. Expected: FAIL, `src/pairing/index.ts` missing.
- [ ] **Step 3: Implement** per Interfaces; update `src/daemon/service.ts` imports.
- [ ] **Step 4: Run** full verification. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: move pairing code out of the telegram module`.

### Task 2: provider contract, registry and Telegram declaration

**Files:**
- Create: `src/provider/types.ts`, `src/provider/constants.ts`, `src/provider/settings.ts`, `src/provider/registry.ts`, `src/provider/index.ts`
- Create: `src/telegram/setup.ts`, `src/telegram/provider.ts`
- Modify: `src/telegram/constants.ts`, `src/telegram/index.ts`, `src/system/host.ts`, `src/system/constants.ts`, `src/system/index.ts`, `src/cli.ts` (import `validateToken` from telegram for now)
- Test: `test/provider/registry.test.ts`, `test/provider/settings.test.ts`, `test/provider/fake.ts` (shared fake), move `validateToken` tests from `test/system/host.test.ts` to `test/telegram/setup.test.ts`

**Interfaces:**
- Produces `src/provider/types.ts` (all exported via `index.ts`):
  ```ts
  export type SettingValue = string | number
  /** Provider settings by config key; only valid values, absent when unknown. */
  export type SettingValues = Readonly<Record<string, SettingValue>>
  export type ProviderSetting = {
    readonly configKey: string
    readonly envVar: string
    /** Lowercase noun for errors: `missing bot token`. */
    readonly description: string
    readonly secret: boolean
    /** Set by pairing, cleared by reset-owner. At most one per provider. */
    readonly owner: boolean
    readonly required: boolean
    /** Prompt label at init; settings without one are never asked for. */
    readonly prompt?: string
    /** Converts an env string or config value; undefined when invalid. Never throws. */
    readonly parse: (raw: unknown) => SettingValue | undefined
  }
  export type CredentialCheck =
    | { readonly ok: true; readonly displayName: string }
    | { readonly ok: false; readonly reason: string }
  export type SetupText = {
    readonly leftoverFound: string
    readonly reusing: (displayName: string) => string
    readonly rejected: string
    /** Present iff the provider has an owner setting. */
    readonly resetOwnerWarning?: string
  }
  export type ProviderSetup = {
    /** Never puts secret values in `reason`. */
    readonly checkCredentials: (settings: SettingValues) => Promise<CredentialCheck>
    readonly text: SetupText
  }
  export type RuntimeHandlers = {
    readonly answer: (id: string, optionIndex: number) => 'accepted' | 'expired'
    readonly dismiss: (id: string) => boolean
    /** Present only while pairing. */
    readonly pair?: (senderId: string, text: string) => PairResult
    /** The provider can't continue; the daemon logs `message` and exits 1. */
    readonly fatal: (message: string) => void
  }
  export type ProviderRuntime = {
    readonly checkCredentials: () => Promise<CredentialCheck>
    readonly sendRequest: (id: string, text: string, options: readonly string[]) => Promise<MessageReference>
    /** Request ended; called once per settled request. Absent means skipped. */
    readonly finalize?: (reference: MessageReference, text: string, settlement: Settlement) => Promise<void>
    readonly sendNotification?: (id: string, text: string) => Promise<MessageReference>
    readonly deleteMessage?: (reference: MessageReference) => Promise<void>
    /** Present iff the provider pairs; `code` is raw (no dash). */
    readonly pairingInstructions?: (code: string) => string
    /** Extra /status fields kept for old CLIs (Telegram: `bot`). */
    readonly statusFields?: () => Readonly<Record<string, string>>
    readonly start: (handlers: RuntimeHandlers) => void
    readonly stop: () => Promise<void>
  }
  export type Provider = {
    readonly name: string
    readonly label: string
    readonly maxTextLength: number
    readonly settings: readonly ProviderSetting[]
    readonly setup: ProviderSetup
    readonly createRuntime: (settings: SettingValues, log: (line: string) => void) => ProviderRuntime
  }
  ```
  `MessageReference` and `Settlement` come from `../approval/index.ts` (`import type`), `PairResult` from `../pairing/index.ts`.
- `src/provider/constants.ts`: `DEFAULT_PROVIDER = 'telegram'`; `RESERVED_CONFIG_KEYS = ['provider', 'port']`; `RESERVED_ENV_VARS = ['PROVIDER', 'PORT', 'HOST', 'TELEGRAM_ASK_CONFIG']`.
- `src/provider/registry.ts`: `export const PROVIDERS: readonly Provider[] = [telegramProvider]`.
- `src/provider/settings.ts`:
  - `findProvider(providers: readonly Provider[], name: string): Provider | undefined`
  - `requireProvider(providers, name): Provider`, throws `Error` with the unknown-provider message from Global Constraints.
  - `findOwnerSetting(provider: Provider): ProviderSetting | undefined`
  - `collectSettings(provider: Provider, readRaw: (setting: ProviderSetting) => unknown): SettingValues`: keeps only values `parse` accepts; never throws.
  - `hasRequiredSecrets(provider, settings): boolean`: every `required && secret` setting present.
  - `listSecretValues(provider, settings): readonly string[]`: `String(value)` of each secret setting present.
- Telegram (`src/telegram/provider.ts`): `export const telegramProvider: Provider` with `name 'telegram'`, `label 'Telegram'`, `maxTextLength: TELEGRAM_MAX_TEXT_LENGTH` (3900, in `src/telegram/constants.ts`), settings in this order:
  - `{ configKey: 'botToken', envVar: 'BOT_TOKEN', description: 'bot token', secret: true, owner: false, required: true, prompt: 'Bot token', parse: non-empty string as is, else undefined }`
  - `{ configKey: 'ownerId', envVar: 'OWNER_ID', description: 'owner id', secret: false, owner: true, required: false, parse: safe integer number, or string matching `/^-?\d+$/` after trim converted to number, else undefined }`
  - `setup.text`: `leftoverFound: 'Found a bot token kept from an earlier install.'`, `reusing: (name) => \`Reusing the saved bot token (${name}).\``, `rejected: 'Telegram rejected that token (or could not be reached). Try again.'`, `resetOwnerWarning: 'This unlinks your Telegram account.'`.
  - `setup.checkCredentials(settings)`: `validateToken(String(settings.botToken))`; ok gives `displayName: '@<username>'`; failure gives `reason: 'Telegram rejected that token (or could not be reached)'`.
  - `createRuntime`: stub that throws `Error('not implemented')` until Task 4.
- `validateToken(token, apiRoot?)` moves unchanged to `src/telegram/setup.ts` with `TOKEN_CHECK_TIMEOUT_SECONDS`; exported from `src/telegram/index.ts` along with `telegramProvider`. `grammy` import leaves `src/system/`.
- `test/provider/fake.ts`: `createFakeProvider(overrides?: Partial<Provider> & { readonly runtime?: Partial<ProviderRuntime> }): Provider & { readonly runtimes: FakeRuntime[] }`. Defaults: `name 'fake'`, `label 'Fake'`, `maxTextLength 100`, settings `[{ configKey: 'fakeKey', envVar: 'FAKE_KEY', description: 'fake key', secret: true, owner: false, required: true, prompt: 'Fake key', parse: non-empty string }]`, `checkCredentials` ok with `displayName 'fake'`, no `resetOwnerWarning`. The runtime records `sent` requests, returns reference `{ n: <counter> }`, keeps the `handlers` passed to `start`, and has no optional parts unless given. Export also `createPairingFakeProvider()`: `name 'fakepair'`, `label 'Fake pair'`, the same `fakeKey` setting plus `{ configKey: 'fakeOwner', envVar: 'FAKE_OWNER', description: 'fake owner', secret: false, owner: true, required: false, parse: non-empty string }`, `resetOwnerWarning: 'This unlinks your Fake account.'` and runtime `pairingInstructions: (code) => \`Say ${code} to fake\``.

- [ ] **Step 1: Write failing tests.**
  - registry: `no two providers share a config key or env var` (over `PROVIDERS`; the fakes are never registered together with each other); `no provider uses a reserved key or env var`; `each provider has at most one owner setting, and an owner setting iff resetOwnerWarning`; `telegram is registered and is the default` (`findProvider(PROVIDERS, DEFAULT_PROVIDER)?.name === 'telegram'`).
  - settings: `requireProvider rejects an unknown name` (message exactly `` unknown provider "slack"; run `telegram-ask init` ``); `collectSettings skips invalid values` (telegram, `{ botToken: '', ownerId: 'x' }` gives `{}`; `{ botToken: 't', ownerId: '42' }` gives `{ botToken: 't', ownerId: 42 }`); `listSecretValues returns only secret values` (`['t']`); `hasRequiredSecrets`.
  - telegram setup: moved `validateToken` tests, unchanged. Telegram's `checkCredentials` is a two-line mapping over `validateToken`; init tests (Task 6) cover the mapping through their fake.
- [ ] **Step 2: Run** `npx vp test test/provider test/telegram`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** full verification. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: add provider contract and declare telegram as a provider`.

### Task 3: per-provider text limit and generic config

**Files:**
- Modify: `src/approval/constants.ts`, `src/approval/parser.ts`, `src/approval/index.ts`, `src/notify/parser.ts`, `src/server/server.ts`, `src/server/types.ts`, `src/server/index.ts`
- Modify: `src/config/schema.ts`, `src/config/types.ts`, `src/config/store.ts`, `src/config/index.ts`, `src/commands/owner.ts`, `src/cli.ts`, `src/daemon/service.ts`
- Test: `test/approval/parser.test.ts`, `test/notify/parser.test.ts`, `test/server/server.test.ts`, `test/config/store.test.ts`, `test/commands/owner.test.ts`

**Interfaces:**
- `MAX_TEXT_LENGTH` is removed from approval. `createTextSchema(maxTextLength: number)` replaces `requestTextSchema` (same messages, limit interpolated). `parseApprovalRequest(body: unknown, maxTextLength: number): ParseResult`; `parseNotifyRequest(body: unknown, maxTextLength: number): NotifyParseResult`.
- `createApiServer(service, status, options: ApiServerOptions)`; `export type ApiServerOptions = { readonly maxTextLength: number; readonly providerName: string; readonly notifications?: Pick<NotificationService, 'notify'> }`. On `SendError` it logs `` `${error.message} via ${providerName}` `` with `console.error` (no cause text; it can hold provider internals) and answers 502 `{ error: 'failed to send message' }`.
- Config:
  - `fileConfigSchema = z.looseObject({ provider: z.string().optional(), port: z.number().optional() })`.
  - `type Config = { readonly provider: Provider; readonly settings: SettingValues; readonly port: number; readonly host: string }`.
  - `type ConfigPatch = Readonly<Record<string, unknown>>` (`null` deletes, `undefined` skipped, as today).
  - `loadConfig(env = process.env, providers: readonly Provider[] = PROVIDERS): Config`. Provider name: `PROVIDER` env, else `file.provider`, else `DEFAULT_PROVIDER`; `requireProvider`. Per setting in order: raw is the env var (empty counts as unset) else `file[configKey]`; absent and `required` throws `` `missing ${description}; ${INIT_HINT} (or set ${envVar})` ``; present but `parse` gives undefined throws `` `invalid ${description}; ${INIT_HINT} (or set ${envVar})` ``. Port and host unchanged.
- `runOwner(args, env = process.env, providers = PROVIDERS): number`: provider from `PROVIDER` env, else the file's `provider`, else default; unknown provider prints the message to stderr and returns 1. `get` prints `String(file[owner.configKey])` when the owner setting exists and the value parses; `clear` patches `{ [owner.configKey]: null }`. No owner setting: `get` prints nothing, `clear` does nothing, both return 0.
- Daemon, temporary until Task 4: `new Bot(String(config.settings.botToken))`, owner from `config.settings.ownerId`; `createApiServer(service, status, { maxTextLength: config.provider.maxTextLength, providerName: config.provider.name, notifications })`.

- [ ] **Step 1: Write failing tests.**
  - parsers: existing tests pass `3900`; add `text limit comes from the caller` (`parseApprovalRequest({ ...valid, text: 'x'.repeat(11) }, 10)` gives `{ ok: false, error: 'text must be at most 10 characters' }`; same for `parseNotifyRequest`).
  - server: `start` helper passes `{ maxTextLength: 3900, providerName: 'test', notifications }`; `502 on SendError` now expects body `{ error: 'failed to send message' }`; add `server uses the provider text limit` (`maxTextLength: 10`, 11-char text gives 400 `text must be at most 10 characters`).
  - config: existing tests now read `config.settings.botToken` / `config.settings.ownerId`; error texts identical (`missing bot token; run \`telegram-ask init\` to set up the bot (or set BOT_TOKEN)`, `invalid owner id; ... (or set OWNER_ID)`). Add `old config without provider loads as telegram` (file `{ botToken: 't', ownerId: 42 }` gives `provider.name 'telegram'`, settings `{ botToken: 't', ownerId: 42 }`); `PROVIDER env overrides the file provider` (with fake provider registry); `unknown provider fails with the init hint`; `fake provider settings load from env and file` (`FAKE_KEY` env wins over `fakeKey` in file).
  - owner: existing tests unchanged; add `owner clear with a fake provider clears its owner key` (`{ provider: 'fakepair', fakeOwner: 'u1', fakeKey: 'k' }` becomes `{ provider: 'fakepair', fakeKey: 'k' }`; use `createPairingFakeProvider()`); `owner get without an owner setting prints nothing`.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** full verification. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: load provider settings generically and make the text limit per provider`.

### Task 4: Telegram runtime and provider-driven daemon

**Files:**
- Create: `src/telegram/runtime.ts`
- Modify: `src/telegram/adapter.ts`, `src/telegram/types.ts`, `src/telegram/provider.ts`, `src/telegram/index.ts`
- Modify: `src/approval/types.ts`, `src/approval/service.ts`, `src/notify/types.ts`, `src/notify/service.ts`, `src/server/schema.ts`
- Modify: `src/daemon/service.ts`, `src/daemon/index.ts`
- Test: `test/telegram/adapter.test.ts`, `test/telegram/runtime.test.ts`, `test/approval/service.test.ts`, `test/daemon/service.test.ts`

**Interfaces:**
- Approval: `MessageReference = unknown` (doc: opaque; the core only hands it back). `Messenger = { sendRequest; finalize?: (reference, text, settlement: Settlement) => Promise<void> }`. `ApprovalService.request` skips finalize when absent. `Notifier` keeps its shape, using the opaque reference.
- Status schema (`src/server/schema.ts`): `z.discriminatedUnion('paired', [z.looseObject({ paired: z.literal(true), provider: z.string().optional(), displayName: z.string().optional(), bot: z.string().optional() }), z.looseObject({ paired: z.literal(false), code: z.string(), provider: z.string().optional(), displayName: z.string().optional(), instructions: z.string().optional(), bot: z.string().optional() })])`.
- Telegram:
  - `TelegramMessageReference = { readonly chatId: number; readonly messageId: number }` in `src/telegram/types.ts`; the messenger casts at its edge.
  - `formatPairingInstructions(code: string, bot: string): string` returns `` `Send "/start ${formatCode(code)}" to @${bot}, or open https://t.me/${bot}?start=${code}` ``. `formatLegacyInstructions(displayCode: string, bot: string): string` strips dashes and calls it (used by Task 5).
  - `handlePairingMessage(message, pair: (senderId: string, text: string) => PairResult, onPaired: (id: number) => void)`: same replies as today.
  - `createTelegramRuntime(settings: SettingValues, log: (line: string) => void, createBot?: (token: string) => Bot): ProviderRuntime`. Holds the `Owner` cell (from `settings.ownerId`). `checkCredentials` runs `bot.init()`; ok gives `displayName '@<username>'`; `GrammyError` gives reason `` `Telegram rejected the bot token (${code}); check it with \`telegram-ask init\`` ``; anything else `could not reach Telegram to verify the bot token` (never the error text). `finalize` edits and clears buttons (ignores settlement). `sendNotification`/`deleteMessage` as today. `pairingInstructions(code)` uses the bot username. `statusFields` returns `{ bot: username }`. `start(handlers)` registers `bot.catch` (logs `bot error: <message>`), the tap handler (`handlers.answer`, `handlers.dismiss`), the pairing handler only when `handlers.pair` is set (on `'paired'` it sets the owner cell to the numeric id), then starts polling with `onStart` logging `` `bot @${username} polling` ``. A polling rejection after `stop()` is ignored; 409 calls `handlers.fatal('another instance is already polling with this bot token; exiting')`; other errors `handlers.fatal(\`bot stopped: ${message}\`)`. `stop()` stops the bot and never rejects.
  - `telegramProvider.createRuntime = (settings, log) => createTelegramRuntime(settings, log)`. `createOnPaired`, `registerPairingHandler`, `registerTapHandler`, `createTelegramMessenger` become internal to the provider (keep exported from `adapter.ts` for tests, drop from `index.ts` except what tests use).
- Daemon:
  ```ts
  export type ServiceOptions = {
    readonly config: Config
    readonly configPath: string
    readonly fatal: (message: string) => void
    readonly log?: (line: string) => void
    readonly generateCode?: () => string
  }
  export type RunningService = { readonly server: FastifyInstance; readonly stop: () => Promise<void> }
  /** Throws an Error with the provider's reason when credentials are rejected. Doesn't listen. */
  export function startService(options: ServiceOptions): Promise<RunningService>
  export function runService(env?: NodeJS.ProcessEnv): Promise<void>
  ```
  `startService`: create runtime, `checkCredentials` (failure throws `Error(reason)`), `ApprovalService(runtime)`, `NotificationService` only when `runtime.sendNotification` exists, owner setting via `findOwnerSetting`. Pairing starts when the owner setting exists and `config.settings[key]` is absent; throw `Error('provider "<name>" has an owner setting but no pairing support')` if `pairingInstructions` is missing. Log `` `Not paired. ${instructions}` ``. `pair` handler: `pairing.attempt`; on `'paired'` patch `{ [key]: owner.parse(senderId) }` into `configPath`, logging `` `paired with ${senderId} but couldn't save the owner to ${configPath}; it'll be lost on restart` `` on failure. Status: paired gives `{ paired: true, provider, displayName, ...statusFields }`; unpaired gives `{ paired: false, provider, displayName, code: formatCode(code), instructions, ...statusFields }`. Then `runtime.start(handlers)`. `stop` closes the server and the runtime. `runService` keeps today's shell: config error, credential error and server error log and exit 1; `fatal` logs and exits 1 unless stopping; SIGTERM/SIGINT with the 5 s fallback; logs `listening on <host>:<port>`.

- [ ] **Step 1: Write failing tests.**
  - approval service: existing finalize assertions get the settlement as third argument; add `no finalize part: request still settles` (messenger without `finalize`, tap settles to `{ kind: 'completed', ... }`, no throw, nothing logged).
  - telegram runtime (fake `Bot` via `createBot`, same casting style as `adapter.test.ts`): `checkCredentials reports @username`; `rejected token reason has the code and no token` (init rejects `GrammyError` 401; reason doesn't contain the token string); `unreachable reason`; `pairingInstructions text is unchanged` (`createTelegramRuntime(...).pairingInstructions('K7QM4XPD')` after init with username `mybot` is `Send "/start K7QM-4XPD" to @mybot, or open https://t.me/mybot?start=K7QM4XPD`); `409 calls fatal with the old message`; `polling ending after stop is not fatal`; `pairing handler is not registered without pair`.
  - daemon (`test/daemon/service.test.ts`, fake providers, real server on port 0, `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` where timeouts matter):
    - `fake without optional parts: request is sent and an answer settles it` (POST `/request`, then `runtime.handlers.answer(sent[0].id, 1)`, response `{ answer: 'Decline', timedOut: false }`).
    - `fake without optional parts: timeout and cancel settle, no finalize attempted` (timeout `1`, advance 1000 ms, `{ answer: 'Decline', timedOut: true }`; abort a second request with `AbortController`, `answer` afterwards gives `'expired'`).
    - `fake without pairing is paired from start` (`/status` body `{ paired: true, provider: 'fake', displayName: 'fake' }`, POST `/request` not 503).
    - `fake without notifications gets 501 on /notify`.
    - `pairing fake: unpaired status, pair, then paired and saved` (`generateCode: () => 'K7QM4XPD'`; status `{ paired: false, provider: 'fakepair', displayName: 'fake', code: 'K7QM-4XPD', instructions: 'Say K7QM4XPD to fake' }`; `handlers.pair('u1', 'k7qm-4xpd')` is `'paired'`; status paired; config file has `fakeOwner: 'u1'`).
    - `owner save failure is logged and pairing still completes` (configPath under a file, not a directory; log called with the `paired with u1 but couldn't save...` line; status paired).
    - `rejected credentials throw with the provider reason`.
    - `owner setting without pairing support is refused at start`.
- [ ] **Step 2: Run** the touched test files. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. `src/daemon/` no longer imports `grammy` or anything Telegram.
- [ ] **Step 4: Run** full verification, then a manual smoke check: `TELEGRAM_ASK_CONFIG=$(mktemp -d)/c.json BOT_TOKEN=bad node src/cli.ts start` prints `Telegram rejected the bot token (401); check it with \`telegram-ask init\`` (or the unreachable line offline) and exits 1.
- [ ] **Step 5: Commit** `refactor: run the daemon through the provider runtime`.

### Task 5: CLI pairing text from `/status`, both shapes

**Files:**
- Create: `src/commands/pairing-text.ts`
- Modify: `src/commands/status.ts`, `src/commands/pairing-wait.ts`, `src/commands/constants.ts` (drop `CODE_DASH_PATTERN`)
- Test: `test/commands/manage.test.ts`, `test/commands/pairing-wait.test.ts`

**Interfaces:**
- `formatPairingText(status: Extract<StatusInfo, { paired: false }>): string` returns `` `Pairing code: ${status.code}` `` plus `\n<instructions>` when `status.instructions` is set, else `\n${formatLegacyInstructions(status.code, status.bot)}` when `status.bot` is set (old containers are always Telegram), else nothing more.
- `waitForPairing` prints `formatPairingText(status)`; `runStatus` prints `` `Pairing: not paired\n${formatPairingText(status)}` ``. Output for Telegram is byte-identical in both shapes.

- [ ] **Step 1: Write failing tests.**
  - `status prints old-shape pairing text`: `{ paired: false, code: 'ABCD-EFGH', bot: 'mybot' }` prints exactly `Pairing: not paired\nPairing code: ABCD-EFGH\nSend "/start ABCD-EFGH" to @mybot, or open https://t.me/mybot?start=ABCDEFGH`.
  - `status prints provider instructions as is`: `{ paired: false, provider: 'fake', displayName: 'fake', code: 'ABCD-EFGH', instructions: 'Say ABCDEFGH to fake' }` prints `Pairing: not paired\nPairing code: ABCD-EFGH\nSay ABCDEFGH to fake`.
  - `waitForPairing accepts the old status shape`: use the real `defaultFetchStatus` against a `node:http` server on port 0 that answers `{"paired":false,"code":"K7QM-4XPD","bot":"b"}` then `{"paired":true,"bot":"b"}`; result `'paired'`, printed `https://t.me/b?start=K7QM4XPD`.
  - `waitForPairing accepts the new status shape` (same server answering new-shape bodies; prints the instructions line).
- [ ] **Step 2: Run** `npx vp test test/commands`. Expected: FAIL on the instructions test.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** full verification. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: print pairing instructions from the service`.

### Task 6: install targets, reset-owner and uninstall work from provider settings

**Files:**
- Modify: `src/install/types.ts`, `src/install/schema.ts`, `src/install/templates.ts`, `src/install/compose.ts`, `src/install/quadlet.ts`, `src/install/systemd.ts`, `src/install/registry.ts`, `src/install/constants.ts` (drop `INTEGER_PATTERN` if unused), `src/install/index.ts`
- Modify: `src/commands/types.ts`, `src/commands/init.ts` (mechanical only), `src/commands/reset-owner.ts`, `src/commands/uninstall.ts`, `src/cli.ts`
- Test: `test/install/*.test.ts`, `test/commands/init.test.ts`, `test/commands/manage.test.ts`

**Interfaces:**
- `installRecordSchema` gains `provider: z.string().optional()`. `resolveRecordProvider(record: InstallRecord): string` returns `record.provider ?? DEFAULT_PROVIDER`.
- `type Secrets = { readonly provider: string; readonly settings: SettingValues }`.
- `type InstallOptions = { version; port; provider: Provider; settings: SettingValues; tarball?; print }`. Every target's returned record includes `provider: options.provider.name`.
- `TargetDeps` gains `readonly providers: readonly Provider[]`; `createRealTargets` in `cli.ts` passes `PROVIDERS`.
- `formatEnvFile(options: { readonly provider: Provider; readonly port: number; readonly settings: SettingValues }): string`: lines `PROVIDER=<name>`, then each provider setting present in declaration order as `<envVar>=<value>`, with `PORT=<port>` right after the first setting line (keeps Telegram's `BOT_TOKEN`, `PORT`, `OWNER_ID` order). Telegram output: `PROVIDER=telegram\nBOT_TOKEN=t\nPORT=8787\nOWNER_ID=42\n`. Throws `RangeError(\`setting ${JSON.stringify(configKey)} contains a line break\`)` for a value with `\n` or `\r`.
- Env-file targets (`compose`, `quadlet`): `readSecrets(record)` reads `.env`; provider from `PROVIDER`, else `DEFAULT_PROVIDER`; unknown provider returns `{ provider: name, settings: {} }`; settings via `collectSettings(provider, (s) => values[s.envVar])`. When the provider has an owner setting not found in `.env`, run `owner get` in the container as today and keep the output if `owner.parse` accepts it. `clearOwner(record)`: provider from `resolveRecordProvider`; `removeEnvKey(envPath, owner.envVar)` then the container `owner clear` as today; throws `Error('provider "<name>" has no owner setting')` when there is none.
- systemd: `install` patches `{ provider: name, port, ...settings }` plus `null` for every config key of every other registered provider (this drops a previous provider's settings when switching); it still leaves the current provider's owner key alone when `settings` has no owner value. `readSecrets` reads `provider` from the file (default telegram) and `collectSettings` over the file. `clearOwner` patches `{ [owner.configKey]: null }`.
- `findLeftoverSecrets(paths, env = process.env, providers = PROVIDERS): Secrets | undefined`: same three sources in the same order; each source resolves its provider (default telegram, unknown skipped); first source where `hasRequiredSecrets` holds wins; `undefined` when none.
- `runResetOwner`: `ResetOwnerDeps` gains `providers`. Provider from the record. No owner setting: print `` `${provider.label} doesn't support re-pairing.` `` and return 1 before any prompt. Confirm text `` `${text.resetOwnerWarning} Continue?` ``.
- `runUninstall`: prompt `Also delete the saved credentials and paired owner?`.
- `runInit`, mechanical: `InitDeps` replaces `validateToken` with `providers: readonly Provider[]`; init uses `providers[0]` (Telegram) and maps `secrets.settings` / `setup.checkCredentials` / `setup.text` so all current init tests pass with only fixture changes (Task 7 makes it generic). `findBotUsername` becomes a `checkCredentials` call; its displayName already has the `@`.

- [ ] **Step 1: Write failing tests.**
  - templates: `formatEnvFile` exact Telegram output above, with and without owner; `formatEnvFile rejects a value with a newline` (`botToken: 'a\nOWNER_ID=1'` throws `RangeError`); fake provider output `PROVIDER=fake\nFAKE_KEY=k\nPORT=1\n`.
  - compose/quadlet: install writes the new `.env` (mode `0o600`, assert via `statSync(...).mode & 0o777`); `readSecrets on an old env file reads as telegram` (`BOT_TOKEN=t\nPORT=1\nOWNER_ID=8\n` gives `{ provider: 'telegram', settings: { botToken: 't', ownerId: 8 } }`); container `owner get` fallback unchanged; `clearOwner removes the owner env var of the record's provider`; returned record has `provider`.
  - systemd: install writes `"provider": "telegram"` with `botToken`, `port`, `ownerId`; `install drops another provider's keys` (seed config with `fakeKey`, registry includes fake, install Telegram, `fakeKey` gone); install without owner keeps an existing `ownerId`; `readSecrets` on an old config without `provider` gives telegram.
  - registry: leftover tests updated to the new `Secrets` shape; `leftover with an unknown provider is skipped`; `leftover needs every required secret` (fake provider config without `fakeKey` is skipped, next source wins).
  - state: `old install.json without provider resolves to telegram` (`resolveRecordProvider(readInstall(...))` is `'telegram'`).
  - manage: `reset-owner without an owner setting returns 1 before prompting` (record `provider: 'fake'`, prints `Fake doesn't support re-pairing.`, `confirm` not called); `reset-owner confirm text comes from the provider` (`This unlinks your Telegram account. Continue?`); uninstall prompt text exactly `Also delete the saved credentials and paired owner?`.
  - init: fixtures switch from `validateToken` to a Telegram-shaped provider whose `checkCredentials` is a `vi.fn`; `secrets` fixtures become `{ provider: 'telegram', settings: { botToken: 't', ownerId: 42 } }`; install assertions become `expect.objectContaining({ settings: { botToken: 't', ownerId: 42 } })`. Every existing printed string assertion stays as is.
- [ ] **Step 2: Run** `npx vp test test/install test/commands`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** full verification. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: store and read install secrets per provider`.

### Task 7: init picks the provider, prompts from its settings, and handles switching

**Files:**
- Modify: `src/commands/init.ts`, `src/commands/types.ts`, `src/commands/prompts.ts`, `src/cli.ts`
- Test: `test/commands/init.test.ts`, `test/cli.test.ts`

**Interfaces:**
- `InitArgs` gains `provider?: string`. `cli.ts` adds `.addOption(new Option('--provider <name>', 'chat app to use').choices(PROVIDERS.map((provider) => provider.name)))`.
- `Prompts` gains `text: (message: string) => Promise<string>` (clack `text`, trimmed, same abort handling as `password`).
- Flow in `runInitInner`, after the target is chosen:
  1. Provider: `args.provider` (unknown in `deps.providers` prints `` `Unknown provider "<name>".` `` and returns 1); else the only registered one, silently; else `select('Which chat app should the bot use?', providers as { value: name, label }, <existing install's provider or first>)`.
  2. Existing install: after `Replace it?`, when `resolveRecordProvider(record) !== provider.name`, confirm `` `This deletes the saved ${oldLabel} settings and paired owner. Continue?` `` (default `false`; `oldLabel` is the registered label or the raw name); declined returns 0 with nothing changed. On yes, call `old.clearOwner(record)` when the old provider is registered and has an owner setting, then discard the old settings. Same provider: read secrets as today.
  3. Leftovers: only reused when `secrets.provider === provider.name`; print `text.leftoverFound` then.
  4. Reuse: when saved settings pass `hasRequiredSecrets` and `setup.checkCredentials` is ok, print `text.reusing(displayName)` and skip prompting.
  5. Otherwise loop: prompt each setting with a `prompt` (secret uses `password`, else `text`), check credentials; on failure print `text.rejected` and re-prompt all of them. Abort checks as today.
  6. Owner setting value from the saved settings carries over when the provider is unchanged.
- Masking: `seen` gets `listSecretValues(provider, settings)` for every reused, leftover and prompted settings bag.

- [ ] **Step 1: Write failing tests.**
  - `single provider: no provider prompt and unchanged output` (Telegram-shaped provider only; `select` called once, for the target; output lines identical to today's fresh-install test).
  - `--provider unknown returns 1`.
  - `provider prompt when several are registered` (Telegram-shaped plus fake; `select` second call message `Which chat app should the bot use?`; picking `fake` prompts `Fake key` via `password` and installs with `provider` fake and `settings: { fakeKey: <answer> }`).
  - `switching provider asks, clears the old owner and drops old settings` (existing install record `provider: 'telegram'`, old secrets with token and owner; `--provider fakepair`; confirm text exactly `This deletes the saved Telegram settings and paired owner. Continue?`; `old.clearOwner` called; install `settings` has no `botToken`/`ownerId`).
  - `declining the switch changes nothing` (no `remove`, no `install`, install.json unchanged, returns 0).
  - `leftover secrets of another provider are not reused` (leftover telegram token, `--provider fake`; no `leftoverFound` line; prompted).
  - `every secret setting value is masked in errors` (provider with two secret settings; `install` rejects with a message containing both values; output shows `***` for both).
  - `non-secret prompted setting uses the text prompt`.
  - cli: `init --help lists --provider`.
- [ ] **Step 2: Run** `npx vp test test/commands/init.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** full verification. Expected: PASS.
- [ ] **Step 5: Commit** `feat: choose the chat provider at init`.

### Task 8: README and leftover cleanup

**Files:**
- Modify: `README.md`, `src/telegram/index.ts` (trim unused exports), any file still matching the grep below

- [ ] **Step 1: Check the seam.** Run `grep -rnE "grammy|botToken|ownerId|BOT_TOKEN|OWNER_ID|/start|t\.me" src --include=*.ts | grep -v '^src/telegram/'`. Expected: only `formatLegacyInstructions` imports in `src/commands`. Fix anything else.
- [ ] **Step 2: README.** Config paragraph: add `PROVIDER` to the env vars (defaults to `telegram`; the only provider for now). `/status` section, if documented: new fields `provider`, `displayName`, `instructions`, and `bot` kept. `init`: mention `--provider`. 502 rows: "Message couldn't be sent." `uninstall`: "the saved credentials and paired owner". Keep the README voice; no em-dashes.
- [ ] **Step 3: Run** full verification. Expected: PASS.
- [ ] **Step 4: Commit** `docs: describe the provider setting`.
