# Easy Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the bot as an npm package whose `telegram-approval-bot init` installs and starts it as a systemd user service, a Docker compose stack, or a Podman quadlet, and waits until the owner pairs via a code sent to the bot.

**Architecture:** The service gains a pairing mode (no owner yet: log a code, accept `/start <code>`, persist the owner) and a `GET /status` endpoint. A single CLI entry (`src/cli.ts`) dispatches subcommands. Install logic lives in `src/install/`: each target implements one `Target` interface over an injectable `Exec`, so targets are unit-tested by asserting commands and written files; `init` orchestrates detect, replace, install, then polls `/status` until paired. TS is compiled to `dist/` only for packing; dev still runs `.ts` directly.

**Tech Stack:** Node 24, TypeScript 7 (`tsc` with `rewriteRelativeImportExtensions`), Vite+ (`vp test`, `vp check`), grammY, Fastify, systemd user units, Docker compose v2, Podman quadlet (4.4+).

**Spec:** `docs/superpowers/specs/2026-10-18-easy-install-design.md`

## Global Constraints

- Node `>=24`. Erasable TS syntax only, relative imports with `.ts` extensions (existing rules).
- Never run `sudo` or anything as root, for any target.
- API binds/publishes on `127.0.0.1` only. Containers set `HOST=0.0.0.0` inside and publish `127.0.0.1:<port>:<port>`.
- Bot token never printed, logged, or put in a file with mode other than 0600. Never include grammY/Telegram error text when the token was involved.
- Pairing code: 8 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, displayed `XXXX-XXXX`, matched case-insensitively with dashes/spaces ignored, new code each start. 5 wrong codes from one sender: ignore that sender until restart.
- While unpaired, `POST /request` returns `503 {"error":"not paired"}`.
- `GET /status`: `{"paired":false,"code":"K7QM-4XPD","bot":"my_bot"}` or `{"paired":true,"bot":"my_bot"}`.
- Default port 8787, override `--port`, no prompt.
- Files: config `~/.config/telegram-approval-bot/config.json` (existing precedence), install state `<configDir>/install.json`, compose files `<configDir>/compose/`, quadlet build context `<configDir>/quadlet/`, quadlet unit `~/.config/containers/systemd/telegram-approval-bot.container`, systemd unit `~/.config/systemd/user/telegram-approval-bot.service`. `<configDir>` is the dir of the default config path (respects `XDG_CONFIG_HOME`).
- Image tag `localhost/telegram-approval-bot:<version>`; Dockerfile installs `telegram-approval-bot@<version>` (the running CLI's version).
- Package version bumps to `0.1.0`; `private` removed.
- Commit messages: no Co-Authored-By or Claude attribution. No em-dashes anywhere.

## Review Focus

- Pairing succeeds but the config file can't be written (read-only mount, wrong owner): service stays paired in memory, logs one line saying the owner wasn't saved. Test in Task 3.
- After pairing, a stranger messages the bot or sends an old code: no reply at all (don't confirm the bot exists to them). Test in Task 3.
- Re-running `init` while the old target holds the port: the port check runs after the old target is removed, not before. Test in Task 12.
- Home dir or config path containing spaces: systemd `ExecStart=`/`Environment=` and quadlet `EnvironmentFile=` stay valid (quoted). Test in Task 8.
- Ctrl-C during the pairing wait: service left running, message says `telegram-approval-bot status` shows the code, exit code 130. Test in Task 7.

---

### Task 1: Config allows a missing owner and partial file updates

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `interface Config { botToken: string; ownerId: number | undefined; port: number; host: string }`
  - `interface FileConfig { botToken?: string; ownerId?: number; port?: number }`
  - `updateConfigFile(path: string, patch: { [K in keyof FileConfig]?: FileConfig[K] | null }): void` reads the existing JSON object (or `{}`), applies the patch (`null` deletes a key), writes 0600, creates parent dirs. Replaces `saveConfig`.
  - `readConfigFile(path: string): FileConfig` (exported version of today's `readFile`, typed).
  - `configDir(env?): string` = `dirname(configPath(env))` for the non-`APPROVAL_BOT_CONFIG` case (XDG or `~/.config` + `/telegram-approval-bot`).

- [ ] **Step 1: Update tests.** Replace `saveConfig` uses with `updateConfigFile`. Change "missing token or non-numeric OWNER_ID throws mentioning onboard" so hints match `/telegram-approval-bot init/`, and missing owner no longer throws:

```ts
test('missing owner is undefined, not an error', () => {
  const none = join(dir, 'none.json')
  expect(loadConfig({ APPROVAL_BOT_CONFIG: none, BOT_TOKEN: 't' }).ownerId).toBeUndefined()
})

test('updateConfigFile merges, null deletes, keeps 0600', () => {
  updateConfigFile(file, { botToken: 'tok', port: 9000 })
  updateConfigFile(file, { ownerId: 42 })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ botToken: 'tok', port: 9000, ownerId: 42 })
  updateConfigFile(file, { ownerId: null })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ botToken: 'tok', port: 9000 })
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('updateConfigFile does not copy env values into the file', () => {
  updateConfigFile(file, { ownerId: 1 })
  loadConfig({ APPROVAL_BOT_CONFIG: file, BOT_TOKEN: 'envtok' })
  expect(readConfigFile(file)).toEqual({ ownerId: 1 })
})
```

Invalid (non-integer) `OWNER_ID` still throws.

- [ ] **Step 2: Run** `npx vp test tests/config.test.ts`. Expected: FAIL (`updateConfigFile` not exported).
- [ ] **Step 3: Implement** in `src/config.ts`. Hint text becomes ``run `telegram-approval-bot init` to set up the bot``. Callers of `saveConfig` (`scripts/onboard.ts`) are deleted in Task 5; leave it compiling until then by keeping `saveConfig` as a thin wrapper, or delete onboard now. Builder's choice.
- [ ] **Step 4: Run** `npx vp test tests/config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Allow config without owner, add partial config updates"`

### Task 2: Pairing state

**Files:**
- Create: `src/pairing.ts`
- Test: `tests/pairing.test.ts`

**Interfaces:**
- Produces:
  - `PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'`
  - `generateCode(randomInt?: (max: number) => number): string` returns 8 raw chars (no dash). Default uses `crypto.randomInt`.
  - `formatCode(code: string): string` returns `XXXX-XXXX`.
  - `type PairResult = 'paired' | 'wrong' | 'blocked' | 'not-pairing'`
  - `class Pairing { constructor(code: string, maxFailures = 5); get code(): string | undefined; get paired(): boolean; attempt(fromId: number, text: string): PairResult }`. `attempt` accepts `/start <code>` and bare `<code>`; after success `code` is `undefined` and every later call returns `'not-pairing'`.

- [ ] **Step 1: Write tests**

```ts
test('generateCode uses the alphabet, 8 chars', () => {
  const c = generateCode()
  expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)
})
test('formatCode', () => expect(formatCode('K7QM4XPD')).toBe('K7QM-4XPD'))
test.each(['/start K7QM-4XPD', '/start k7qm4xpd', 'K7QM 4XPD', '/start@my_bot K7QM-4XPD'])(
  'accepts %s', (t) => expect(new Pairing('K7QM4XPD').attempt(1, t)).toBe('paired'),
)
test('wrong code, then blocked after 5 failures per sender', () => {
  const p = new Pairing('K7QM4XPD')
  for (let i = 0; i < 5; i++) expect(p.attempt(1, '/start AAAA-AAAA')).toBe('wrong')
  expect(p.attempt(1, '/start K7QM-4XPD')).toBe('blocked')
  expect(p.attempt(2, '/start K7QM-4XPD')).toBe('paired')
})
test('after pairing everything is not-pairing', () => {
  const p = new Pairing('K7QM4XPD')
  p.attempt(1, 'K7QM4XPD')
  expect(p.paired).toBe(true)
  expect(p.code).toBeUndefined()
  expect(p.attempt(3, 'K7QM4XPD')).toBe('not-pairing')
})
test('bare /start counts as wrong', () => expect(new Pairing('K7QM4XPD').attempt(1, '/start')).toBe('wrong'))
```

- [ ] **Step 2: Run** `npx vp test tests/pairing.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/pairing.ts`. Normalize: strip leading `/start` (with optional `@botname`), uppercase, remove `-` and whitespace.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/pairing.ts tests/pairing.test.ts && git commit -m "Add pairing code state"`

### Task 3: Telegram side reads owner dynamically and handles pairing

**Files:**
- Modify: `src/telegram.ts`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: `Pairing` (Task 2), `updateConfigFile` (Task 1).
- Produces:
  - `interface Owner { id: number | undefined }` (mutable holder shared by messenger, tap handler, HTTP status).
  - `routeTap(fromId, data, ownerId: number | undefined, tap)`: `undefined` owner returns `'ignored'`.
  - `createTelegramMessenger(bot: Bot, owner: Owner): Messenger` sends to `owner.id` at call time; throws if undefined.
  - `registerTapHandler(bot: Bot, owner: Owner, tap: Tap): void`
  - `handlePairingMessage(msg: { fromId: number; chatType: string; text: string }, pairing: Pairing, onPaired: (id: number) => void): string | undefined` returns the reply text, or `undefined` for no reply. Pure, tested directly.
  - `registerPairingHandler(bot: Bot, pairing: Pairing, onPaired: (id: number) => void): void` wires `message:text` to `handlePairingMessage` and `ctx.reply`.
  - Reply strings: paired `Paired. Approval requests will appear here.`; wrong `This bot isn't paired. Check the service logs for the pairing code.`; blocked, not-pairing, non-private chat: no reply.

- [ ] **Step 1: Write tests** (update existing `routeTap`/messenger tests to the `Owner` holder, add):

```ts
test('pairing: right code replies and calls onPaired', () => {
  const onPaired = vi.fn()
  const reply = handlePairingMessage({ fromId: 9, chatType: 'private', text: '/start K7QM-4XPD' }, new Pairing('K7QM4XPD'), onPaired)
  expect(reply).toBe('Paired. Approval requests will appear here.')
  expect(onPaired).toHaveBeenCalledWith(9)
})
test('pairing: group chat ignored', () => {
  expect(handlePairingMessage({ fromId: 9, chatType: 'group', text: 'K7QM4XPD' }, new Pairing('K7QM4XPD'), vi.fn())).toBeUndefined()
})
test('after pairing, strangers get no reply', () => {
  const p = new Pairing('K7QM4XPD')
  p.attempt(1, 'K7QM4XPD')
  expect(handlePairingMessage({ fromId: 2, chatType: 'private', text: '/start' }, p, vi.fn())).toBeUndefined()
})
test('tap with no owner is ignored', () => {
  const tap = vi.fn()
  expect(routeTap(1, 'abc:0', undefined, tap)).toBe('ignored')
})
```

- [ ] **Step 2: Run** `npx vp test tests/telegram.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `onPaired` is supplied by the service runner (Task 5); it sets `owner.id` first, then calls `updateConfigFile(path, { ownerId })` inside try/catch, logging `paired with <id> but couldn't save the owner to <path>; it'll be lost on restart` on failure (never rethrow). Put that function in `src/telegram.ts` as `makeOnPaired(owner: Owner, path: string, log = console.error): (id: number) => void` and test it:

```ts
test('onPaired keeps owner in memory when the file is unwritable', () => {
  const owner: Owner = { id: undefined }
  const log = vi.fn()
  makeOnPaired(owner, '/proc/nope/config.json', log)(42)
  expect(owner.id).toBe(42)
  expect(log.mock.calls[0]?.[0]).toMatch(/couldn't save/)
})
```

- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Pairing handler and dynamic owner in Telegram adapter"`

### Task 4: HTTP status endpoint and 503 while unpaired

**Files:**
- Modify: `src/http.ts`
- Test: `tests/http.test.ts`

**Interfaces:**
- Produces:
  - `type StatusInfo = { paired: true; bot: string } | { paired: false; code: string; bot: string }`
  - `createApiServer(service: Pick<ApprovalService, 'request'>, status: () => StatusInfo): FastifyInstance`

- [ ] **Step 1: Write tests.** Existing tests pass `() => ({ paired: true, bot: 'b' })`. Add:

```ts
test('GET /status reports pairing', async () => {
  const url = await start(okRequest, () => ({ paired: false, code: 'K7QM-4XPD', bot: 'b' }))
  const res = await fetch(`${url}/status`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ paired: false, code: 'K7QM-4XPD', bot: 'b' })
})
test('POST /request is 503 while unpaired, service not called', async () => {
  const request = vi.fn<RequestFn>()
  const url = await start(request, () => ({ paired: false, code: 'X', bot: 'b' }))
  const res = await post(url, JSON.stringify(valid))
  expect(res.status).toBe(503)
  expect(await res.json()).toEqual({ error: 'not paired' })
  expect(request).not.toHaveBeenCalled()
})
test('POST /status is 405', async () => { /* expect 405 with Allow: GET */ })
```

- [ ] **Step 2: Run** `npx vp test tests/http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** 503 check happens before body validation. Extend the not-found handler so `/status` with a non-GET method returns 405 `Allow: GET`.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Add GET /status and 503 while unpaired"`

### Task 5: CLI entry, `start` and `test` subcommands; remove old scripts

**Files:**
- Create: `src/cli.ts`, `src/service.ts`, `src/commands/test.ts`, `src/version.ts`
- Delete: `src/main.ts`, `scripts/onboard.ts`, `scripts/test-request.ts`, `deploy/`, `Dockerfile`, `.dockerignore`
- Modify: `package.json` (scripts), `tsconfig.json` (drop `scripts` from include)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:
  - `src/version.ts`: `export const VERSION: string` read from `../package.json` via `import pkg from '../package.json' with { type: 'json' }` (works from both `src/` and `dist/`).
  - `src/service.ts`: `runService(env?: NodeJS.ProcessEnv): Promise<void>`: today's `main.ts` logic plus: `await bot.init()` before listening (for `bot.botInfo.username`); if `config.ownerId` undefined, create `Pairing(generateCode())`, log `Not paired. Send "/start <XXXX-XXXX>" to @<bot>, or open https://t.me/<bot>?start=<RAWCODE>`; register pairing handler; status callback built from `owner` + `pairing`.
  - `src/cli.ts`: shebang `#!/usr/bin/env node`; `main(argv: string[]): Promise<number>` dispatching `init`, `start`, `status`, `test`, `reset-owner`, `uninstall`, `owner` (hidden, Task 10), `--version`, `--help`/no args (usage). Unknown command: usage to stderr, return 2. Subcommands not yet built print `not implemented` and return 1 until their task lands.
  - `src/commands/test.ts`: `runTest(port: number): Promise<number>` (today's `test-request` body, hint says `telegram-approval-bot status`). Port from `install.json` (Task 7) once it exists; for now from `loadConfig`, else `DEFAULT_PORT`.
  - `package.json` scripts: `"start": "node src/cli.ts start"`, `"cli": "node src/cli.ts"`; remove `onboard`, `test-request`.

- [ ] **Step 1: Write tests**

```ts
test('unknown command returns 2', async () => expect(await main(['nope'])).toBe(2))
test('--version prints VERSION', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await main(['--version'])).toBe(0)
  expect(log).toHaveBeenCalledWith(VERSION)
})
```

- [ ] **Step 2: Run** `npx vp test tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, delete old files. `cli.ts` only calls `process.exit(await main(process.argv.slice(2)))` when it's the entry module (`import.meta.main`).
- [ ] **Step 4: Run** `npx vp test && npx vp check`. Expected: PASS, no type errors.
- [ ] **Step 5: Manual check.** With a real token in a temp config without `ownerId`: `APPROVAL_BOT_CONFIG=/tmp/x.json npm start` logs the pairing line; `curl -s 127.0.0.1:8787/status` shows the code; send it from Telegram; `/status` flips to paired and the file now has `ownerId`. Stop the existing systemd service first (one poller per token).
- [ ] **Step 6: Commit** `git add -A && git commit -m "Add CLI with start and test, drop onboard and deploy scripts"`

### Task 6: Build and package

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Produces: `npm pack` tarball containing `dist/**`, `package.json`, `README.md`; `bin.telegram-approval-bot = "dist/cli.js"`.

- [ ] **Step 1: Configure.** `tsconfig.build.json` extends `tsconfig.json` with `noEmit: false`, `rootDir: "src"`, `outDir: "dist"`, `rewriteRelativeImportExtensions: true`, `include: ["src"]`, `resolveJsonModule: true` (for the package.json import; adjust `rootDir` to `.` and `outDir` so the output is `dist/src/...` if tsc refuses the out-of-root JSON, then point `bin` at `dist/src/cli.js` and check `VERSION` still resolves). Verified on this machine: TS 7.0.2 rewrites `./b.ts` to `./b.js`. `package.json`: `"version": "0.1.0"`, drop `private`, add `bin`, `"files": ["dist"]`, `"build": "tsc -p tsconfig.build.json"`, `"prepack": "npm run build"`. Add `dist/` to `.gitignore`.
- [ ] **Step 2: Verify** `npm pack --dry-run` lists only `dist/`, `package.json`, `README.md` (and LICENSE if present).
- [ ] **Step 3: Verify install from tarball** into a scratch prefix: `npm pack && npm i -g --prefix "$SCRATCH/p" ./telegram-approval-bot-0.1.0.tgz && "$SCRATCH/p/bin/telegram-approval-bot" --version`. Expected: `0.1.0`. (This is the case that fails today: type stripping under `node_modules`.)
- [ ] **Step 4: Commit** `git add -A && git commit -m "Build to dist and make the package publishable"`

### Task 7: Install plumbing: exec, paths, state, prompts, waiting

**Files:**
- Create: `src/install/exec.ts`, `src/install/paths.ts`, `src/install/state.ts`, `src/install/prompt.ts`, `src/install/wait.ts`, `src/install/system.ts`
- Test: `tests/install/state.test.ts`, `tests/install/wait.test.ts`, `tests/install/system.test.ts`

**Interfaces:**
- Produces:
  - `exec.ts`: `type ExecResult = { code: number; stdout: string; stderr: string }`; `type Exec = (cmd: string, args: string[], opts?: { inherit?: boolean; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>`; `realExec: Exec` (spawn; `inherit` streams output to the terminal for builds). Never throws on non-zero exit; throws only if the binary is missing (`ENOENT`) as `MissingCommandError`.
  - `paths.ts`: `installPaths(env?) => { configDir, configFile, installFile, composeDir, quadletDir, systemdUnit, quadletUnit, userNpmPrefix }` per Global Constraints; `userNpmPrefix` = `${XDG_DATA_HOME:-~/.local/share}/telegram-approval-bot/npm`.
  - `state.ts`: `type TargetName = 'systemd' | 'compose' | 'quadlet'`; `interface InstallRecord { target: TargetName; port: number; version: string; cliPath?: string }`; `readInstall(file): InstallRecord | undefined`; `writeInstall(file, rec): void` (0600); `removeInstall(file): void`.
  - `prompt.ts`: `askSecret(q): Promise<string>`, `ask(q): Promise<string>`, `choose<T extends string>(q, options: { value: T; label: string; disabled?: string }[], def: T): Promise<T>` (moved from `onboard.ts`'s muted-output readline).
  - `wait.ts`: `waitForPairing(opts: { port: number; isRunning: () => Promise<boolean>; logsHint: string; signal?: AbortSignal; fetchStatus?: (port: number) => Promise<StatusInfo | undefined>; sleep?: (ms: number) => Promise<void>; startTimeoutMs?: number; print?: (s: string) => void }): Promise<'paired' | 'interrupted' | 'not-started' | 'stopped'>`. Polls every 1s; prints the pairing line plus the `https://t.me/<bot>?start=<raw>` link once when first seen; `'not-started'` after `startTimeoutMs` (default 60000) without an answer; `'stopped'` if `isRunning()` turns false; `'interrupted'` on abort, after printing `Service is still running and waiting for pairing. Run "telegram-approval-bot status" to see the code again.`
  - `system.ts`: `portFree(port: number): Promise<boolean>` (bind 127.0.0.1, close); `ensureLinger(exec, user, print): Promise<void>` (`loginctl show-user <user> -p Linger`; if `Linger=no`, `loginctl enable-linger <user>`; on failure print `Run "loginctl enable-linger <user>" so it keeps running after logout.`); `validateToken(token): Promise<string | undefined>` returns the bot username or `undefined` (catch-all, no error text).

- [ ] **Step 1: Write tests**

```ts
// wait.test.ts
test('prints code once, resolves paired', async () => {
  const seq: (StatusInfo | undefined)[] = [undefined, { paired: false, code: 'K7QM-4XPD', bot: 'b' }, { paired: false, code: 'K7QM-4XPD', bot: 'b' }, { paired: true, bot: 'b' }]
  const print = vi.fn()
  const r = await waitForPairing({ port: 1, isRunning: async () => true, logsHint: 'L', fetchStatus: async () => seq.shift(), sleep: async () => {}, print })
  expect(r).toBe('paired')
  expect(print.mock.calls.filter(([s]) => s.includes('K7QM-4XPD'))).toHaveLength(1)
})
test('abort returns interrupted and says the service is still running', async () => {
  const ac = new AbortController(); ac.abort()
  const print = vi.fn()
  expect(await waitForPairing({ port: 1, isRunning: async () => true, logsHint: 'L', signal: ac.signal, fetchStatus: async () => undefined, sleep: async () => {}, print })).toBe('interrupted')
  expect(print.mock.calls.flat().join('\n')).toMatch(/telegram-approval-bot status/)
})
test('service died returns stopped', async () => { /* isRunning false -> 'stopped' */ })
test('never answers returns not-started', async () => { /* startTimeoutMs: 0 */ })

// state.test.ts: write/read roundtrip, mode 0600, readInstall on missing file is undefined, on garbage JSON is undefined.
// system.test.ts: portFree false while a net.Server holds the port; ensureLinger calls enable-linger only when Linger=no, prints the fallback when it fails (fake Exec).
```

- [ ] **Step 2: Run** `npx vp test tests/install`. Expected: FAIL.
- [ ] **Step 3: Implement.** The CLI (Task 12) maps `'interrupted'` to exit 130 via SIGINT -> AbortController.
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Install plumbing: exec, paths, state, prompts, pairing wait"`

### Task 8: Templates

**Files:**
- Create: `src/install/templates.ts`
- Test: `tests/install/templates.test.ts`

**Interfaces:**
- Produces (all return file contents as strings):
  - `dockerfile(opts: { version: string; tarball?: string }): string`: `FROM node:24-slim`, `ENV NODE_ENV=production APPROVAL_BOT_CONFIG=/data/config.json HOST=0.0.0.0`, `RUN npm i -g telegram-approval-bot@<version>` (or `COPY <basename(tarball)> /tmp/pkg.tgz` + `RUN npm i -g /tmp/pkg.tgz && rm /tmp/pkg.tgz` when `tarball` is set), `RUN mkdir /data && chown node:node /data`, `VOLUME /data`, `USER node`, `CMD ["telegram-approval-bot","start"]`.
  - `composeYaml(port: number): string`: project `name: telegram-approval-bot`, service `bot`, `build: .`, `restart: unless-stopped`, `env_file: .env`, `ports: ["127.0.0.1:<port>:<port>"]`, volume `data:/data`, top-level `volumes: { data: {} }`.
  - `envFile(opts: { token: string; port: number; ownerId?: number }): string`: `BOT_TOKEN=`, `PORT=`, optional `OWNER_ID=`.
  - `quadletContainer(opts: { version: string; port: number; envFile: string }): string`: `[Unit] Description=Telegram approval bot`; `[Container] Image=localhost/telegram-approval-bot:<version>`, `ContainerName=telegram-approval-bot`, `Volume=telegram-approval-bot-data:/data`, `EnvironmentFile=<quoted path>`, `PublishPort=127.0.0.1:<port>:<port>`; `[Service] Restart=on-failure`; `[Install] WantedBy=default.target`.
  - `systemdUnit(opts: { node: string; cli: string; configEnv?: string }): string`: today's unit with `ExecStart="<node>" "<cli>" start`, optional `Environment="APPROVAL_BOT_CONFIG=<path>"`, no `WorkingDirectory`.
  - Quoting helper `systemdQuote(s: string): string`: wraps in double quotes, escapes `\` and `"`, and `%` as `%%`.

- [ ] **Step 1: Write tests**

```ts
test('dockerfile pins version', () => expect(dockerfile({ version: '0.1.0' })).toContain('npm i -g telegram-approval-bot@0.1.0'))
test('dockerfile from tarball', () => expect(dockerfile({ version: '0.1.0', tarball: '/a/b/pkg.tgz' })).toContain('COPY pkg.tgz /tmp/pkg.tgz'))
test('compose publishes on localhost only, restarts', () => {
  const y = composeYaml(9000)
  expect(y).toContain('"127.0.0.1:9000:9000"')
  expect(y).toContain('restart: unless-stopped')
})
test('quadlet publishes on localhost and quotes the env file path', () => {
  const q = quadletContainer({ version: '0.1.0', port: 8787, envFile: '/home/a b/.env' })
  expect(q).toContain('PublishPort=127.0.0.1:8787:8787')
  expect(q).toContain('EnvironmentFile="/home/a b/.env"')
})
test('systemd unit quotes paths with spaces and percent', () => {
  const u = systemdUnit({ node: '/opt/node 24/bin/node', cli: '/x/cli.js', configEnv: '/h/50%/c.json' })
  expect(u).toContain('ExecStart="/opt/node 24/bin/node" "/x/cli.js" start')
  expect(u).toContain('Environment="APPROVAL_BOT_CONFIG=/h/50%%/c.json"')
})
test('envFile omits OWNER_ID when unknown', () => expect(envFile({ token: 't', port: 1 })).not.toContain('OWNER_ID'))
```

- [ ] **Step 2: Run** `npx vp test tests/install/templates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Add install templates"`

### Task 9: Target interface and systemd target

**Files:**
- Create: `src/install/target.ts`, `src/install/systemd.ts`
- Test: `tests/install/systemd.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 7, 8.
- Produces in `target.ts`:

```ts
export interface Secrets { token?: string; ownerId?: number }
export interface InstallOptions { version: string; port: number; token: string; ownerId?: number; tarball?: string; print: (s: string) => void }
export interface Target {
  name: TargetName
  available(): Promise<{ ok: true } | { ok: false; reason: string }>
  install(opts: InstallOptions): Promise<InstallRecord> // writes files, builds if needed, starts
  readSecrets(rec: InstallRecord): Promise<Secrets>
  remove(rec: InstallRecord, purge: boolean): Promise<void> // stop + delete files; purge also deletes token/owner storage
  restart(rec: InstallRecord): Promise<void>
  clearOwner(rec: InstallRecord): Promise<void>
  isRunning(rec: InstallRecord): Promise<boolean>
  logsHint(rec: InstallRecord): string
}
export interface TargetDeps { exec: Exec; paths: ReturnType<typeof installPaths>; env: NodeJS.ProcessEnv; user: string }
```

- `systemd.ts`: `systemdTarget(deps: TargetDeps, cli: { selfPath: string; nodePath: string }): Target`.
  - `available`: `systemctl --user show-environment` exit 0, else reason `systemd user session not available`.
  - `install`: resolve a stable CLI path: if `selfPath` is under `npm root -g` (or the fallback prefix), use it; else install `telegram-approval-bot@<version>` (or `tarball`) with `npm i -g`, or with `--prefix <paths.userNpmPrefix>` when `npm prefix -g` isn't writable (`fs.accessSync(W_OK)`); print which. `cliPath` = `<root>/telegram-approval-bot/dist/cli.js` (match Task 6's bin path). Write token (+ ownerId if given, else `ownerId: null`) and port into `configFile` via `updateConfigFile`; write unit (with `configEnv` if `APPROVAL_BOT_CONFIG` is set); `daemon-reload`; `enable --now telegram-approval-bot`; `ensureLinger`.
  - `readSecrets`: from `readConfigFile(configFile)`.
  - `remove`: `disable --now`, delete unit, `daemon-reload`; purge deletes `configFile`. Does not uninstall the npm package (print `npm rm -g telegram-approval-bot` hint when purging).
  - `clearOwner`: `updateConfigFile(configFile, { ownerId: null })`. `restart`: `systemctl --user restart`. `isRunning`: `systemctl --user is-active --quiet` exit 0. `logsHint`: `journalctl --user -u telegram-approval-bot -f`.

- [ ] **Step 1: Write tests** with a fake `Exec` recording calls (returns `{code:0,...}` and canned stdout for `npm root -g` / `npm prefix -g`) and temp dirs for paths:

```ts
test('installs from npm into a user prefix when global prefix is not writable', async () => { /* npm prefix -g -> '/usr'; expect npm i -g --prefix <tmp>/.local/share/telegram-approval-bot/npm telegram-approval-bot@0.1.0 */ })
test('install writes unit, config 0600, enables', async () => {
  // expect calls include ['systemctl', ['--user','daemon-reload']] and ['systemctl', ['--user','enable','--now','telegram-approval-bot']]
  // readConfigFile(configFile) toEqual { botToken: 't', port: 8787 }
})
test('install keeps a reused owner id', async () => { /* ownerId: 42 -> file has ownerId 42 */ })
test('remove without purge keeps config; with purge deletes it', async () => {})
test('already global: no npm install', async () => { /* selfPath under npm root -g output */ })
```

- [ ] **Step 2: Run** `npx vp test tests/install/systemd.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Add systemd install target"`

### Task 10: Container targets (compose and quadlet) and the `owner` helper

**Files:**
- Create: `src/install/compose.ts`, `src/install/quadlet.ts`, `src/install/envfile.ts`, `src/commands/owner.ts`
- Modify: `src/cli.ts` (wire hidden `owner`)
- Test: `tests/install/compose.test.ts`, `tests/install/quadlet.test.ts`, `tests/install/envfile.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 7, 8, 9 (`Target`, `TargetDeps`).
- Produces:
  - `src/commands/owner.ts`: `runOwner(args: string[], env?): number`: `owner get` prints the `ownerId` from `configPath(env)` or nothing; `owner clear` sets it to null. Hidden from usage. Runs inside containers.
  - `envfile.ts`: `readEnvFile(path): Record<string, string>`, `writeEnvFile(path, contents: string): void` (0600), `removeEnvKey(path, key): void`.
  - `composeTarget(deps: TargetDeps): Target`:
    - `available`: `docker compose version` ok and `docker info` ok; reason `docker not installed`, `docker compose v2 not available`, or `can't talk to docker (not in the docker group?)`.
    - `install`: write `Dockerfile` (copy tarball into `composeDir` if given), `compose.yaml`, `.env` (0600, `OWNER_ID` when reused), run `docker compose -f <composeDir>/compose.yaml up -d --build` with `inherit: true`.
    - `readSecrets`: token from `.env`; owner from `.env` `OWNER_ID`, else `docker compose run --rm --no-deps bot telegram-approval-bot owner get`.
    - `remove`: `docker compose down` (purge: `down -v`, delete `composeDir`); without purge keep `.env` and volume.
    - `clearOwner`: `removeEnvKey(.env, 'OWNER_ID')` and `docker compose run --rm --no-deps bot telegram-approval-bot owner clear`. `restart`: `up -d --force-recreate` (so env changes apply). `isRunning`: `docker compose ps --status running -q bot` non-empty. `logsHint`: `docker compose -f <path> logs -f`.
  - `quadletTarget(deps: TargetDeps): Target`:
    - `available`: `podman --version` >= 4.4, else reason with the found version.
    - `install`: write `Dockerfile` (+ tarball) and `.env` in `quadletDir`, `podman build -t localhost/telegram-approval-bot:<version> <quadletDir>` with `inherit: true`, write `quadletUnit`, `systemctl --user daemon-reload`, `systemctl --user start telegram-approval-bot` (quadlet units can't be `enable`d; `WantedBy` handles boot), `ensureLinger`.
    - `readSecrets`: token from `.env`; owner from `.env`, else `podman run --rm -v telegram-approval-bot-data:/data localhost/telegram-approval-bot:<rec.version> telegram-approval-bot owner get`.
    - `remove`: `systemctl --user stop`, delete unit, `daemon-reload`; purge also `podman volume rm telegram-approval-bot-data`, `podman rmi` the tag, delete `quadletDir`.
    - `clearOwner`: like compose but via `podman exec telegram-approval-bot telegram-approval-bot owner clear` (service is running). `restart`: `systemctl --user restart`. `isRunning`: `systemctl --user is-active --quiet`. `logsHint`: `journalctl --user -u telegram-approval-bot -f`.

- [ ] **Step 1: Write tests** (fake `Exec`, temp dirs):

```ts
test('quadlet unavailable on podman 4.3', async () => { /* podman --version -> 'podman version 4.3.1' -> { ok:false, reason: /4.3.1/ } */ })
test('quadlet install builds tagged image then starts', async () => {
  // calls in order: podman build -t localhost/telegram-approval-bot:0.1.0 <quadletDir>, systemctl --user daemon-reload, systemctl --user start telegram-approval-bot
  // .env mode 0600 contains BOT_TOKEN=t
})
test('compose unavailable when docker info fails', async () => {})
test('compose install writes files and runs up -d --build', async () => {})
test('readSecrets prefers OWNER_ID in .env, falls back to owner get in container', async () => {})
test('remove without purge keeps .env and volume', async () => { /* no 'down -v', no volume rm */ })
// envfile.test.ts: roundtrip, removeEnvKey keeps other lines, mode 0600.
// owner command: get prints id, clear removes it (temp APPROVAL_BOT_CONFIG).
```

- [ ] **Step 2: Run** `npx vp test tests/install`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Add compose and quadlet install targets"`

### Task 11: Target registry and detection

**Files:**
- Create: `src/install/targets.ts`
- Test: `tests/install/targets.test.ts`

**Interfaces:**
- Produces:
  - `TARGET_ORDER: TargetName[] = ['quadlet', 'compose', 'systemd']`
  - `makeTargets(deps: TargetDeps, cli: { selfPath: string; nodePath: string }): Record<TargetName, Target>`
  - `detect(targets): Promise<{ name: TargetName; ok: boolean; reason?: string }[]>` in `TARGET_ORDER`.
  - `defaultTarget(detected): TargetName | undefined` = first ok.
  - `findExisting(paths, targets): { rec: InstallRecord; legacy: boolean } | undefined`: install.json if present; else if `paths.systemdUnit` exists, `{ rec: { target: 'systemd', port: <from config or 8787>, version: 'legacy' }, legacy: true }`.

- [ ] **Step 1: Write tests**: default is quadlet when all ok; compose when podman missing; undefined when none; legacy detection with unit file present and no install.json; install.json wins over legacy unit.
- [ ] **Step 2: Run** `npx vp test tests/install/targets.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Target detection and legacy install lookup"`

### Task 12: `init`

**Files:**
- Create: `src/commands/init.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/init.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 9-11.
- Produces: `runInit(args: { target?: TargetName; port?: number; tarball?: string }, deps: InitDeps): Promise<number>` where `InitDeps = { targets: Record<TargetName, Target>; paths; prompt: { ask; askSecret; choose }; validateToken; portFree; wait: typeof waitForPairing; print; signal?: AbortSignal; version: string }`. CLI parses `init [systemd|compose|quadlet] [--port N] [--tarball PATH]` (`--tarball` hidden, for testing unpublished builds).

Flow, in this order:
1. `detect`; if `args.target` given and unavailable, print reason, return 1. Else `choose` with disabled entries showing reasons, default `defaultTarget`. None available: print reasons, return 1.
2. `findExisting`. If found: print what (and `legacy` note), `ask` `Replace it? [Y/n]`; no -> return 0. Read `secrets = old.readSecrets(rec)`, then `old.remove(rec, false)`, `removeInstall`.
3. Token: if `secrets.token` and `validateToken` returns a username, reuse it and say so. Else loop `askSecret('Bot token (input hidden): ')` until valid; on failure print `Telegram rejected that token (or could not be reached). Try again.`
4. Port: `args.port ?? rec?.port ?? 8787`. `portFree` false: print `Port <n> is in use. Pick another with --port.`, return 1. (Runs after step 2's remove.)
5. `target.install({ version, port, token, ownerId: secrets.ownerId, tarball, print })`; `writeInstall`.
6. `wait({ port, isRunning, logsHint, signal })`: `'paired'` -> print `Done. Try it: telegram-approval-bot test`, plus status and logs commands, return 0. `'interrupted'` -> 130. `'not-started'`/`'stopped'` -> print logs hint, return 1. If an owner was reused the wait returns `'paired'` on the first answer with no code printed.

- [ ] **Step 1: Write tests** with fake targets (vi.fn methods) and fake deps:

```ts
test('replace: reads secrets, removes old without purge, checks port after removal, reuses token and owner', async () => {
  const order: string[] = []
  // old.readSecrets -> { token: 't', ownerId: 42 }; old.remove pushes 'remove'; portFree pushes 'port'
  // expect(order).toEqual(['remove', 'port']); new.install called with { token: 't', ownerId: 42 }
  // askSecret not called
})
test('declining replace changes nothing', async () => {})
test('requested target unavailable returns 1 with the reason', async () => {})
test('invalid token reprompts without echoing Telegram errors', async () => {})
test('port in use returns 1 before install', async () => {})
test('interrupted wait returns 130 and leaves the service', async () => { /* remove not called after install */ })
test('legacy systemd unit is replaced and its config reused', async () => {})
```

- [ ] **Step 2: Run** `npx vp test tests/commands/init.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, wire into `cli.ts` with real deps and a SIGINT -> `AbortController`.
- [ ] **Step 4: Run** `npx vp test && npx vp check`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Add init command"`

### Task 13: `status`, `reset-owner`, `uninstall`

**Files:**
- Create: `src/commands/status.ts`, `src/commands/reset-owner.ts`, `src/commands/uninstall.ts`
- Modify: `src/cli.ts`, `src/commands/test.ts` (port from install.json first)
- Test: `tests/commands/manage.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 9-12.
- Produces:
  - `runStatus(deps): Promise<number>`: nothing installed -> `Not installed. Run "telegram-approval-bot init".`, return 1. Else print target, version, port, running yes/no, then paired or the pairing line from `/status`. Return 0 if running, else 1.
  - `runResetOwner(deps): Promise<number>`: `ask` `This unlinks your Telegram account. Continue? [y/N]`; `clearOwner`, `restart`, then the same `wait` as `init` with the same exit codes.
  - `runUninstall(deps): Promise<number>`: `ask` `Also delete the bot token and paired owner? [y/N]`; `remove(rec, purge)`; `removeInstall`; works on legacy installs too. Not installed: print and return 0.

- [ ] **Step 1: Write tests** with fake targets: status not installed -> 1; reset-owner declines -> no `clearOwner`; reset-owner yes -> `clearOwner` then `restart` then wait; uninstall purge answer is passed through; uninstall removes install.json.
- [ ] **Step 2: Run** `npx vp test tests/commands/manage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, wire into `cli.ts`, update usage text.
- [ ] **Step 4: Run** `npx vp test && npx vp check`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Add status, reset-owner and uninstall"`

### Task 14: README and end-to-end check on this machine

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite README.** Lead with `npx telegram-approval-bot init`. Keep the API and error tables. Sections: what `init` asks and does, pairing (code, link, `reset-owner`), one short section per target (what gets written where, logs command, Podman 4.4+ requirement, docker group note), `status`/`test`/`uninstall`, "one instance per token", upgrading from the old `onboard`/`install-service.sh` setup (init picks it up; stop any hand-run container first), no auth so localhost only.
- [ ] **Step 2: End-to-end, quadlet** (this machine: Podman 4.9.3, linger already on). Stop the existing `telegram-approval-bot` service first. `npm pack`, then `node src/cli.ts init quadlet --tarball ./telegram-approval-bot-0.1.0.tgz`. Expected: legacy systemd install detected and replaced, token and owner reused, no pairing step, `Done`. `node src/cli.ts test`, tap Approve, expect `200 {"answer":"Approve","timedOut":false}`. `node src/cli.ts reset-owner`, expect a pairing code; pair from Telegram.
- [ ] **Step 3: End-to-end, systemd.** `node src/cli.ts init systemd --tarball ./telegram-approval-bot-0.1.0.tgz`. Expected: quadlet removed, package installed under the npm prefix (or the user fallback), unit running, owner reused. `test` works. Reboot not required; `systemctl --user cat telegram-approval-bot` shows the absolute paths.
- [ ] **Step 4: Uninstall check.** `node src/cli.ts uninstall`, answer `n`. Expected: unit gone, config kept. Re-run `init systemd` to leave the machine working, or leave as the owner prefers.
- [ ] **Step 5: Compose** can't be checked here (no Docker on this machine). Say so in the final report.
- [ ] **Step 6: Commit** `git add -A && git commit -m "Rewrite README around init"`
