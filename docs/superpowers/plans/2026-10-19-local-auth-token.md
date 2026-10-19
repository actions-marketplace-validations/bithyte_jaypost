# Local Auth Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional bearer token that `init` generates, the service enforces on `/request`, `/notify` and `/status`, and every CLI client and the Node `Client` find and send on their own.

**Architecture:** A new self-contained `src/auth/` module holds the token format, the file I/O, the client lookup rule and the constant-time check. The service gets `auth: ApiAuth` on `Config` and a per-route Fastify `onRequest` hook. Clients resolve a `ClientToken` (env, then `~/.config/telegram-ask/token`, then none) once per run for one-shot commands and once per call for `mcp` and `Client`. `init` picks the token, writes the client file, and hands `auth` to the target, which writes the service's copy (`.env` line or `apiToken` in `config.json`).

**Tech Stack:** Node 24 (runs `.ts` directly), Fastify 5, MCP SDK, commander, zod, vite-plus (`vp test` with the vitest API, `vp check` for fmt and lint), TypeScript 7 (`tsc` for types only).

**Spec:** `docs/superpowers/specs/2026-10-19-local-auth-token-design.md`. Read it before each task; this plan doesn't repeat its reasoning.

## Global Constraints

- Never use em-dashes anywhere: code, comments, tests, README, commit messages.
- Commits: conventional, lowercase summary (`feat:`, `docs:`, `chore:`). No `Co-Authored-By` trailer or any Claude/Anthropic attribution.
- Repo style wins over the global TS rules: exported functions with JSDoc (no `<Module><Role>` classes), `Client` keeps `#private` fields, single quotes, no semicolons, width 100, tests use `import { ... } from 'vite-plus/test'` with flat `test(...)`. Where the repo is silent: `type` only, `readonly` fields, `kind` unions, payload-free variants `as const satisfies`, regexes end in `_PATTERN`, lowercase error messages with `JSON.stringify`-quoted values.
- Exact values: env var `TELEGRAM_ASK_TOKEN`; file `<config directory>/token`, mode `0600`, contents token + `"\n"`; `TOKEN_BYTES = 32` encoded `base64url` (43 chars); `TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{32,256}$/`; `AUTHORIZATION_PATTERN = /^Bearer +(\S+) *$/i`; config key `apiToken`; 401 reply is `WWW-Authenticate: Bearer` with body `{"error":"unauthorized"}`.
- The token value never appears in logs, error messages, argv, `status` output or `init` output. Messages name the source, never the value. Tests assert this wherever a message is produced.
- `src/auth/` and `src/client/` must not import `src/config/store.ts`, `src/config/index.ts`, `src/provider/` or `src/telegram/`: the CJS library build (`vp pack` of `src/index.ts`) would pull in grammy. Import leaf files directly (`../config/paths.ts`, `../config/constants.ts`, `../system/files.ts`).
- Tests that exercise the default token lookup (Node `Client`, spawned `mcp`) must not read the developer's real `~/.config/telegram-ask/token`: stub `XDG_CONFIG_HOME` to a `mkdtemp` directory and `TELEGRAM_ASK_TOKEN` to `''` (`vi.stubEnv`, undone with `vi.unstubAllEnvs()` in `afterEach`), or pass that env to the spawned process.
- Verification after every task: `npx vp test` (whole suite) green, `npm run check` green, `npx tsc -p tsconfig.json` exits 0. A task that changes a shared type updates every caller and test fixture in the same task so all three stay green.

## Review Focus

1. A hand-edited token file with CRLF or surrounding spaces (`echo`, a Windows editor) should be accepted after trimming; `openssl rand -base64 32` output with its `=` padding should be rejected with a message that names the file. Test in Task 1.
2. `reset-owner` run with an unusable `TELEGRAM_ASK_TOKEN` must fail before clearing the owner, or the owner is unlinked and the CLI can't show the new code. Test in Task 7.
3. `init` run from a shell with a stale `TELEGRAM_ASK_TOKEN` must still pair: its own wait uses the token it just chose, not the env. Test in Task 9.
4. `require('telegram-ask')` must keep working without dragging the provider stack into the CJS bundle, and `new Client()` must do no I/O even when the token path is unreadable. Tests in Task 4.
5. A hand-set token using the rest of the b64token alphabet (`+ / . ~`, from `openssl rand -base64`) must pass `parseToken` and `isAuthorized`. Test in Task 1.

---

### Task 1: `src/auth/` module

**Files:**
- Create: `src/config/paths.ts` (move `findEnvValue`, `resolveConfigPath`, `resolveConfigDirectory` out of `src/config/store.ts`, bodies unchanged; `findEnvValue` becomes an export with a one-line JSDoc)
- Modify: `src/config/store.ts` (import the three from `./paths.ts`), `src/config/index.ts` (re-export `resolveConfigDirectory`, `resolveConfigPath` from `./paths.ts`)
- Create: `src/auth/constants.ts`, `src/auth/types.ts`, `src/auth/token.ts`, `src/auth/check.ts`, `src/auth/index.ts`
- Test: `test/auth/token.test.ts`, `test/auth/check.test.ts`

The move exists so `src/auth/token.ts` can resolve the config directory without importing `store.ts` (which imports the provider registry).

**Interfaces:**
- Produces (`src/auth/index.ts` re-exports all of these):
  - `type ApiAuth = { readonly kind: 'none' } | { readonly kind: 'token'; readonly token: string }`
  - `type ClientToken = { readonly kind: 'none' } | { readonly kind: 'token'; readonly token: string; readonly source: 'env' | 'file' } | { readonly kind: 'unusable'; readonly message: string }`
  - constants `TOKEN_ENV_VAR`, `TOKEN_FILE_NAME = 'token'`, `TOKEN_BYTES`, `TOKEN_PATTERN`, `AUTHORIZATION_PATTERN`, `NO_AUTH = { kind: 'none' } as const satisfies ApiAuth`, `NO_CLIENT_TOKEN = { kind: 'none' } as const satisfies ClientToken`, `UNAUTHORIZED_ERROR = 'unauthorized'`
  - `generateToken(): string`
  - `parseToken(raw: string): string | undefined`: trims surrounding whitespace, returns the trimmed value if it matches `TOKEN_PATTERN`, else `undefined`
  - `resolveTokenFile(env?: NodeJS.ProcessEnv): string`: `join(resolveConfigDirectory(env), TOKEN_FILE_NAME)`
  - `readTokenFile(path: string): string | undefined`: raw file text; `undefined` when missing (`isMissingFileError`); rethrows other errors
  - `writeTokenFile(path: string, token: string): void`: `writeFileAtomic(path, \`${token}\n\`, SECRET_FILE_MODE)` (from `../config/constants.ts` and `../system/files.ts`)
  - `removeTokenFile(path: string): void`: `rmSync(path, { force: true })`
  - `resolveClientToken(env: NodeJS.ProcessEnv, tokenFile: string): ClientToken`: never throws
  - `isAuthorized(header: string | undefined, token: string): boolean`: pure

- [ ] **Step 1: Write the failing tests**

`test/auth/token.test.ts` (helpers at top: `let directory: string` from `mkdtempSync` in `beforeEach`; `const TOKEN = 'a'.repeat(43)`; `const HAND_SET = 'Ab+/._~-'.repeat(5)` (40 chars)):

```ts
test('generated tokens are 43 base64url characters and differ between calls', () => {
  const first = generateToken()
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(parseToken(first)).toBe(first)
  expect(generateToken()).not.toBe(first)
})
test('parseToken accepts 32 to 256 characters of the b64token alphabet', () => {
  for (const raw of ['a'.repeat(32), 'a'.repeat(256), HAND_SET]) expect(parseToken(raw)).toBe(raw)
})
test('parseToken trims surrounding whitespace', () => {
  expect(parseToken(`  ${TOKEN}\r\n`)).toBe(TOKEN)
})
test('parseToken rejects short, long, padded, split and non-ascii values', () => {
  for (const raw of ['a'.repeat(31), 'a'.repeat(257), `${TOKEN}=`, `${'a'.repeat(20)} ${'a'.repeat(20)}`, `${TOKEN}é`, ''])
    expect(parseToken(raw)).toBeUndefined()
})
test('resolveTokenFile uses the install directory and ignores TELEGRAM_ASK_CONFIG', () => {
  expect(resolveTokenFile({ XDG_CONFIG_HOME: '/x', HOME: '/h', TELEGRAM_ASK_CONFIG: '/c/config.json' })).toBe('/x/telegram-ask/token')
  expect(resolveTokenFile({ HOME: '/h' })).toBe('/h/.config/telegram-ask/token')
})
test('writeTokenFile writes 0600 with a trailing newline through a new inode', () => {
  // pre-create the file 0644 with other text, note its inode
  // after writeTokenFile: contents `${TOKEN}\n`, mode & 0o777 === 0o600, inode differs, readdirSync(directory) === ['token']
})
test('readTokenFile returns undefined for a missing file and removeTokenFile tolerates one', ...)
test('resolveClientToken prefers the env, then the file, then none', () => {
  const file = join(directory, 'token')
  writeTokenFile(file, TOKEN)
  expect(resolveClientToken({ TELEGRAM_ASK_TOKEN: HAND_SET }, file)).toEqual({ kind: 'token', token: HAND_SET, source: 'env' })
  expect(resolveClientToken({ TELEGRAM_ASK_TOKEN: '' }, file)).toEqual({ kind: 'token', token: TOKEN, source: 'file' })
  expect(resolveClientToken({}, join(directory, 'none'))).toEqual({ kind: 'none' })
})
test('a token file with CRLF and spaces is read trimmed', () => {
  writeFileSync(file, `  ${TOKEN}  \r\n`)
  expect(resolveClientToken({}, file)).toEqual({ kind: 'token', token: TOKEN, source: 'file' })
})
test('an invalid env or file token is unusable and the message never quotes it', () => {
  expect(resolveClientToken({ TELEGRAM_ASK_TOKEN: 'short-secret' }, file)).toEqual({
    kind: 'unusable', message: "TELEGRAM_ASK_TOKEN isn't a valid telegram-ask token" })
  writeFileSync(file, `${TOKEN}=\n`)
  expect(resolveClientToken({}, file)).toEqual({
    kind: 'unusable', message: `token file ${JSON.stringify(file)} isn't a valid telegram-ask token` })
})
test('an unreadable token file is unusable', () => {
  mkdirSync(file) // EISDIR
  const result = resolveClientToken({}, file)
  expect(result.kind).toBe('unusable')
  // narrow, then:
  expect(result.message.startsWith(`token file ${JSON.stringify(file)} couldn't be read: `)).toBe(true)
})
```

`test/auth/check.test.ts`:

```ts
test('isAuthorized accepts the bearer token with any scheme case and extra spaces', () => {
  for (const header of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER   ${TOKEN}  `]) expect(isAuthorized(header, TOKEN)).toBe(true)
  expect(isAuthorized(`Bearer ${HAND_SET}`, HAND_SET)).toBe(true)
})
test('isAuthorized rejects wrong, longer, other-scheme, bare, empty and missing headers', () => {
  for (const header of [`Bearer ${'b'.repeat(43)}`, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN, 'Bearer ', '', undefined])
    expect(isAuthorized(header, TOKEN)).toBe(false)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/auth`
Expected: FAIL, cannot resolve `../../src/auth/index.ts`.

- [ ] **Step 3: Implement**

Move the three config path functions to `src/config/paths.ts` first and run `npx vp test test/config` (still green). Then write the auth files with the interfaces above. `resolveClientToken`: env value via `env[TOKEN_ENV_VAR]`, empty counts as unset; then `readTokenFile` inside a `try` whose catch returns `unusable` with `` `token file ${JSON.stringify(tokenFile)} couldn't be read: ${error instanceof Error ? error.message : String(error)}` ``. `isAuthorized`: match `AUTHORIZATION_PATTERN`, then `timingSafeEqual(sha256(presented), sha256(token))` (`createHash('sha256')` from `node:crypto`).

- [ ] **Step 4: Run the tests**

Run: `npx vp test test/auth test/config`
Expected: PASS.

- [ ] **Step 5: Full verification and commit**

Run the Global Constraints verification, then:

```bash
git add src/auth src/config test/auth
git commit -m "feat: add the auth module for the local api token"
```

---

### Task 2: Service enforces the token

**Files:**
- Modify: `src/config/schema.ts` (`apiToken: z.string().optional()`), `src/config/types.ts` (`Config` gains `readonly auth: ApiAuth`), `src/config/store.ts` (`loadConfig`)
- Modify: `src/provider/constants.ts` (`'apiToken'` into `RESERVED_CONFIG_KEYS`, `TOKEN_ENV_VAR` into `RESERVED_ENV_VARS`, imported from `../auth/constants.ts`)
- Modify: `src/server/types.ts` (`ApiServerOptions` gains `readonly auth: ApiAuth`), `src/server/server.ts`
- Modify: `src/daemon/service.ts` (`createApiServer(..., { auth: config.auth, ... })`; listening line becomes `` `listening on ${host}:${port} (${config.auth.kind === 'token' ? 'token required' : 'no token'})` ``)
- Test: `test/config/store.test.ts`, `test/server/server.test.ts`, `test/daemon/service.test.ts`, `test/provider/registry.test.ts`
- Fixture updates: every `createApiServer(...)` in `test/server`, `test/mcp`, `test/commands/send.test.ts` gets `auth: NO_AUTH`; `createConfig` in `test/daemon/service.test.ts` gets `auth: NO_AUTH`; full-`Config` `toEqual`s in `store.test.ts` gain `auth: NO_AUTH`.

**Interfaces:**
- Consumes: `ApiAuth`, `NO_AUTH`, `TOKEN_ENV_VAR`, `parseToken`, `isAuthorized`, `UNAUTHORIZED_ERROR` from Task 1.
- Produces: `Config.auth: ApiAuth`; `ApiServerOptions.auth: ApiAuth` (required).

- [ ] **Step 1: Write the failing tests**

`test/config/store.test.ts`:

```ts
test('api token comes from TELEGRAM_ASK_TOKEN, then apiToken in the file, else none', () => {
  updateConfigFile(file, { botToken: 'tok', apiToken: FILE_TOKEN })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file, TELEGRAM_ASK_TOKEN: ENV_TOKEN }).auth).toEqual({ kind: 'token', token: ENV_TOKEN })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file, TELEGRAM_ASK_TOKEN: '' }).auth).toEqual({ kind: 'token', token: FILE_TOKEN })
  updateConfigFile(file, { apiToken: null })
  expect(loadConfig({ TELEGRAM_ASK_CONFIG: file }).auth).toEqual(NO_AUTH)
})
test('an invalid api token throws without quoting it', () => {
  // env 'short-secret' and file 'short-secret' each:
  expect(load).toThrow('invalid api token; run `telegram-ask init` to set up the bot (or set TELEGRAM_ASK_TOKEN)')
  // and the thrown message does not contain 'short-secret'
})
```

`test/provider/registry.test.ts`: `expect(RESERVED_CONFIG_KEYS).toContain('apiToken')`, `expect(RESERVED_ENV_VARS).toContain('TELEGRAM_ASK_TOKEN')`.

`test/server/server.test.ts`: `start(request, status, notify, auth = NO_AUTH)` gains a fourth parameter. Add a `call(url, method, path, headers, body?)` helper. With `const TOKEN = 'a'.repeat(43)` and `auth = { kind: 'token', token: TOKEN }`:

```ts
test('401 with WWW-Authenticate on every api route for a missing, malformed or wrong token', async () => {
  // routes: POST /request, POST /notify, GET /status
  // headers: none, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${'b'.repeat(43)}` }
  // each: status 401, headers.get('www-authenticate') === 'Bearer', json === { error: 'unauthorized' }
})
test('401 comes before 503, 400 and 413, and nothing reaches the service', async () => {
  // status: unpaired; bodies: valid JSON, '{not json', 'x'.repeat(70_000); notify stub vi.fn()
  // all 401; request and notify mocks never called
})
test('the right token behaves as today', async () => {
  // `Bearer ${TOKEN}` and `bearer   ${TOKEN}` on /request: 200 outcome; GET /status: 200 body
})
test('openapi.yaml, 404 and 405 stay open with a token', async () => {
  // GET /openapi.yaml 200, GET /other 404, GET /request 405 with Allow: POST, all without a header
})
test('rejections are logged once each without the token', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  // POST /request no header, GET /status with `Bearer ${WRONG}`
  expect(error.mock.calls).toEqual([['rejected POST /request: missing token'], ['rejected GET /status: wrong token']])
})
test('without a token a stray authorization header is ignored', async () => {
  // NO_AUTH, `Bearer whatever` on /request: 200
})
```

`test/daemon/service.test.ts`:

```ts
test('the service puts the configured token on the api', async () => {
  // createConfig(provider) with auth { kind: 'token', token: TOKEN }
  // GET /status without header: 401; with `Bearer ${TOKEN}`: 200
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/config test/server/server.test.ts test/daemon test/provider`
Expected: FAIL on the new tests (no `auth` on `Config`, no 401s).

- [ ] **Step 3: Implement**

`loadConfig`: `findEnvValue(env, TOKEN_ENV_VAR) ?? (file.apiToken === '' ? undefined : file.apiToken)`; undefined gives `NO_AUTH`; `parseToken` failure throws `` `invalid api token; ${INIT_HINT} (or set ${TOKEN_ENV_VAR})` ``.

Server: register the hook per route. Build `const guard = auth.kind === 'token' ? { onRequest: <hook> } : {}` and pass it as the route options of `/status`, `/request`, `/notify` (`app.get('/status', guard, handler)`, `app.post<...>('/request', guard, handler)`). The hook is `async (request, reply)`: if `isAuthorized(request.headers.authorization, auth.token)` return; otherwise `console.error(\`rejected ${request.method} ${request.url.split('?')[0]}: ${request.headers.authorization === undefined ? 'missing' : 'wrong'} token\`)` and `return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: UNAUTHORIZED_ERROR })`. Update the JSDoc of `createApiServer` to mention the token.

- [ ] **Step 4: Run the tests**

Run: `npx vp test`
Expected: PASS, including the untouched no-token server tests.

- [ ] **Step 5: Verify and commit**

```bash
git add src/config src/provider src/server src/daemon test
git commit -m "feat: require the api token on the service when one is configured"
```

---

### Task 3: OpenAPI declares bearer auth

**Files:**
- Modify: `src/server/openapi.ts`, `docs/openapi.yaml` (regenerated)
- Test: `test/server/openapi.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: document shape only.

- [ ] **Step 1: Write the failing test**

```ts
test('bearer auth is declared and required on the api routes', () => {
  const document = createOpenApiDocument({ port: 8787, maxTextLength: 3900 })
  expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
  expect(document.security).toEqual([{ bearerAuth: [] }])
  expect(document.paths['/openapi.yaml'].get.security).toEqual([])
  expect(document.paths['/request'].post.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' })
  expect(document.paths['/notify'].post.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' })
  expect(document.paths['/status'].get.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vp test test/server/openapi.test.ts`
Expected: FAIL, `securitySchemes` undefined.

- [ ] **Step 3: Implement**

Per the spec's OpenAPI section: `components.securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer', description }` where the description says the token is the one `init` saved to `~/.config/telegram-ask/token` and that a service installed without one ignores the header; root `security: [{ bearerAuth: [] }]` (drop the "no auth" comment); `security: []` on `/openapi.yaml`; `Unauthorized: errorResponse('Missing or wrong bearer token.')` in `components.responses`; `'401'` on the three routes. Then run `npm run openapi`.

- [ ] **Step 4: Run the tests**

Run: `npx vp test test/server/openapi.test.ts test/cli.test.ts`
Expected: PASS, including "docs/openapi.yaml is up to date".

- [ ] **Step 5: Verify and commit**

```bash
git add src/server/openapi.ts docs/openapi.yaml test/server/openapi.test.ts
git commit -m "feat: declare bearer auth in the openapi document"
```

---

### Task 4: `postApi` and the Node `Client` send the token

**Files:**
- Modify: `src/client/types.ts` (`ApiOptions.token?: string`; `ClientOptions.token?: string` with JSDoc "Sent as a bearer token. Default: `TELEGRAM_ASK_TOKEN`, else `~/.config/telegram-ask/token`, looked up on every call."), `src/client/constants.ts`, `src/client/http.ts`, `src/client/client.ts`, `src/client/index.ts`
- Test: `test/client/http.test.ts`, `test/client/client.test.ts`, `test/pack.test.ts`

**Interfaces:**
- Consumes: `parseToken`, `resolveClientToken`, `resolveTokenFile` from `../auth/index.ts`.
- Produces (exported from `src/client/index.ts`, not from the package `src/index.ts`):
  - `TOKEN_REQUIRED_MESSAGE = "telegram-ask service needs a token; set TELEGRAM_ASK_TOKEN to the contents of ~/.config/telegram-ask/token on the host"`
  - `TOKEN_REJECTED_MESSAGE = 'telegram-ask service rejected the token; check TELEGRAM_ASK_TOKEN, or re-run telegram-ask init if the token file changed'`
  - `describeUnauthorized(sentToken: boolean): string`: one of the two messages
  - `postApi` sends `authorization: Bearer <token>` iff `options.token !== undefined`; a 401 maps to `describeUnauthorized(options.token !== undefined)`

- [ ] **Step 1: Write the failing tests**

`test/client/http.test.ts` (stub records `request.headers.authorization`):

```ts
test('the token is sent as a bearer header only when given', async () => {
  // postApi(port, '/request', {}, { ...options(), token: TOKEN }) -> header `Bearer ${TOKEN}`
  // postApi(port, '/request', {}, options()) -> header undefined
})
test('401 explains whether a token was sent', async () => {
  // reply(401, '{"error":"unauthorized"}')
  // without token -> { kind: 'failed', message: TOKEN_REQUIRED_MESSAGE }
  // with token    -> { kind: 'failed', message: TOKEN_REJECTED_MESSAGE }
})
```

`test/client/client.test.ts`: `Seen` gains `authorization?: string`. Add `beforeEach`: `directory = mkdtempSync(...)`, `vi.stubEnv('XDG_CONFIG_HOME', directory)`, `vi.stubEnv('TELEGRAM_ASK_TOKEN', '')`; `afterEach`: `vi.unstubAllEnvs()`. `const tokenFile = () => join(directory, 'telegram-ask', 'token')`.

```ts
test('an explicit token is sent as a bearer header', ...)          // new Client({ port, token: TOKEN })
test('no token anywhere sends no authorization header', ...)
test('the default lookup reads the token file on every call', async () => {
  // writeTokenFile(tokenFile(), FIRST); notify; expect seen.authorization `Bearer ${FIRST}`
  // writeTokenFile(tokenFile(), SECOND); notify; expect `Bearer ${SECOND}`
})
test('TELEGRAM_ASK_TOKEN beats the token file', ...)
test('a bad explicit token is a RangeError that does not quote it', () => {
  expect(() => new Client({ token: 'short-secret' })).toThrow(new RangeError("token isn't a valid telegram-ask token"))
})
test('the constructor does no io and an unreadable token file rejects the call', async () => {
  mkdirSync(tokenFile(), { recursive: true })
  const client = new Client({ port })   // does not throw
  await expect(client.notify({ text: 'x' })).rejects.toThrow(TelegramAskError)
  // message starts with `token file "${tokenFile()}" couldn't be read: `; stub never called
})
test('a rejected token surfaces the rejected message', ...)  // stub 401, explicit token -> TelegramAskError(TOKEN_REJECTED_MESSAGE)
```

`test/pack.test.ts`, inside the existing test: `expect(readFileSync(join(directory, 'index.cjs'), 'utf8')).not.toMatch(/grammy|@clack|commander|fastify/)`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/client test/pack.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`send()` takes the optional token and adds the header. `describeStatus` gains a `sentToken: boolean` parameter and returns `describeUnauthorized(sentToken)` for 401 before the generic fallback. `Client`: new `#token: string | undefined`; the constructor runs `parseToken` on an explicit token and throws the RangeError on failure (no I/O otherwise). `#post` resolves the token first: explicit, else `resolveClientToken(process.env, resolveTokenFile(process.env))`; `unusable` throws `TelegramAskError(message)`; `token` goes into `postApi`'s options. Update the `Client` JSDoc and `request`'s throws line if needed.

- [ ] **Step 4: Run the tests**

Run: `npx vp test test/client test/pack.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
git add src/client test/client test/pack.test.ts
git commit -m "feat: send the api token from postApi and the node client"
```

---

### Task 5: `mcp` looks the token up on every call

**Files:**
- Create: `src/mcp/types.ts`
- Modify: `src/mcp/server.ts`, `src/mcp/index.ts` (`export type { ServiceAddress }`), `src/cli.ts` (`mcp` action)
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: `ClientToken`, `resolveClientToken`, `resolveTokenFile` (Task 1); `ApiOptions.token` (Task 4).
- Produces:
  - `type ServiceAddress = { readonly port: number; readonly readToken: () => ClientToken }` (JSDoc: "Where the service listens and how to find the token; `readToken` runs once per tool call.")
  - `createMcpServer(address: ServiceAddress, signal: AbortSignal): McpServer`
  - `runMcp(address: ServiceAddress): Promise<number>`

- [ ] **Step 1: Write the failing tests**

`connect(port, extraEnv = {})` spawns with `env: { ...getDefaultEnvironment(), XDG_CONFIG_HOME: directory, ...extraEnv }` (`getDefaultEnvironment` from `@modelcontextprotocol/sdk/client/stdio.js`; `directory` from `mkdtempSync` in `beforeEach`), so no test reads the real token file. `startApi(options)` gains `auth?: ApiAuth`. `tokenFile = join(directory, 'telegram-ask', 'token')`.

```ts
test('tool calls send the token from the token file', async () => {
  writeTokenFile(tokenFile, TOKEN)
  const { port, notifier } = await startApi({ auth: { kind: 'token', token: TOKEN } })
  const client = await connect(port)
  expect(await client.callTool({ name: 'notify_user', arguments: NOTE })).toEqual({ content: [{ type: 'text', text: 'sent' }] })
})
test('TELEGRAM_ASK_TOKEN reaches the service', ...)   // no file, connect(port, { TELEGRAM_ASK_TOKEN: TOKEN })
test('the token is read again on every call', async () => {
  // service wants SECOND; file holds FIRST -> isError, text TOKEN_REJECTED_MESSAGE
  // writeTokenFile(tokenFile, SECOND) -> next call 'sent'
})
test('an unusable token fails only the call that hit it', async () => {
  // file 'short-secret' -> isError, text `token file ${JSON.stringify(tokenFile)} isn't a valid telegram-ask token`
  // fix the file -> next call 'sent'; the ask tool behaves the same (one ask call is enough)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/mcp`
Expected: FAIL on the new tests (no header sent).

- [ ] **Step 3: Implement**

Both tool handlers start with `const token = address.readToken()`; `unusable` returns `toErrorResult(token.message)` before calling `postApi`; `token` adds `token: token.token` to the options. `cli.ts`: `const tokenFile = resolveTokenFile(process.env)` then `runMcp({ port: resolveMcpPort(...), readToken: () => resolveClientToken(process.env, tokenFile) })`. `mcp` still never reads `config.json`.

- [ ] **Step 4: Run the tests**

Run: `npx vp test test/mcp`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
git add src/mcp src/cli.ts test/mcp
git commit -m "feat: read the api token on every mcp tool call"
```

---

### Task 6: `send` and `test` send the token

**Files:**
- Modify: `src/commands/types.ts` (`SendDeps.token: ClientToken`), `src/commands/send.ts`, `src/commands/test.ts`, `src/cli.ts` (`createSendDeps`, `test` action)
- Test: `test/commands/send.test.ts`, `test/commands/manage.test.ts` (the `runTest` test), `test/cli.test.ts`

**Interfaces:**
- Consumes: `ClientToken`, `NO_CLIENT_TOKEN`, `resolveClientToken`, `resolveTokenFile` (Task 1); `describeUnauthorized` (Task 4).
- Produces: `runTest(fallbackPort: number, installFile: string | undefined, token: ClientToken): Promise<number>`.

`test` stays on `fetch` (the existing test stubs global `fetch`); moving it onto `postApi` isn't needed.

- [ ] **Step 1: Write the failing tests**

`test/commands/send.test.ts`: `createDeps(port, signal, token = NO_CLIENT_TOKEN)`; `startApi` gains `auth`.

```ts
test('request sends the token', ...)        // tokened API, token { kind: 'token', token: TOKEN, source: 'env' } -> 0, answer printed
test('an unusable token fails without calling the service', async () => {
  // token { kind: 'unusable', message: 'bad token here' } -> 1, errors ['telegram-ask: bad token here'], messenger.sent empty
})
test('a wrong token prints the rejected message', ...)  // errors [`telegram-ask: ${TOKEN_REJECTED_MESSAGE}`]
```

`test/commands/manage.test.ts`: the existing `runTest` test passes `NO_CLIENT_TOKEN` and also asserts the request had no `authorization` header. Add:

```ts
test('test sends the token and explains a 401', async () => {
  // fetch stub returns new Response('{"error":"unauthorized"}', { status: 401 })
  // runTest(1234, paths.installFile, { kind: 'token', token: TOKEN, source: 'file' }) -> 1
  // fetch init.headers.authorization === `Bearer ${TOKEN}`; console.error called with TOKEN_REJECTED_MESSAGE
})
test('test with an unusable token fails before calling', ...)  // -> 1, fetch not called, console.error('bad token here')
```

`test/cli.test.ts`:

```ts
test('send exits 1 with the message on an invalid TELEGRAM_ASK_TOKEN', async () => {
  vi.stubEnv('TELEGRAM_ASK_TOKEN', 'short-secret')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(['send', 'notify', 'hi', '--port', '1'])).toBe(1)
  expect(error).toHaveBeenCalledWith("telegram-ask: TELEGRAM_ASK_TOKEN isn't a valid telegram-ask token")
  vi.unstubAllEnvs()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/commands/send.test.ts test/commands/manage.test.ts test/cli.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`runSendRequest` / `runSendNotify`: `unusable` prints `` `telegram-ask: ${deps.token.message}` `` via `printError` and returns 1 before `postApi`; otherwise pass the token. `createSendDeps` adds `token: resolveClientToken(process.env, resolveTokenFile(process.env))`. `runTest`: `unusable` prints the message with `console.error` and returns 1; with a token add the header; on 401 print `describeUnauthorized(token.kind === 'token')` with `console.error` and return 1; other statuses unchanged.

- [ ] **Step 4: Run the tests**

Run: `npx vp test test/commands test/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
git add src/commands src/cli.ts test/commands test/cli.test.ts
git commit -m "feat: send the api token from send and test"
```

---

### Task 7: `status`, the pairing wait and `reset-owner`

**Files:**
- Modify: `src/commands/types.ts`, `src/commands/constants.ts`, `src/commands/pairing-wait.ts`, `src/commands/status.ts`, `src/commands/reset-owner.ts`, `src/commands/index.ts` (export the new types), `src/cli.ts` (`runStatusCommand`, `runResetOwnerCommand`)
- Test: `test/commands/pairing-wait.test.ts`, `test/commands/manage.test.ts` (existing `fetchStatus` mocks switch to the union)

**Interfaces:**
- Consumes: `ClientToken`, `resolveClientToken`, `resolveTokenFile` (Task 1); `describeUnauthorized` (Task 4).
- Produces (in `src/commands/types.ts`):
  - `type StatusFetch = { readonly kind: 'answered'; readonly status: StatusInfo } | { readonly kind: 'unauthorized' } | { readonly kind: 'unreachable' }`
  - `type FetchStatus = (port: number, token: string | undefined) => Promise<StatusFetch>`
  - `WaitOptions` gains `readonly token?: string`; `fetchStatus?: FetchStatus`
  - `WaitResult = 'paired' | 'interrupted' | 'notStarted' | 'stopped' | 'unauthorized'`
  - `StatusDeps` gains `readonly token: ClientToken`, `readonly tokenFile: string`; `fetchStatus: FetchStatus`
  - `ResetOwnerDeps` gains `readonly token: ClientToken`
  - in `constants.ts`: `UNAUTHORIZED_STATUS = { kind: 'unauthorized' } as const satisfies StatusFetch`, `UNREACHABLE_STATUS = { kind: 'unreachable' } as const satisfies StatusFetch`
  - `defaultFetchStatus(port: number, token?: string): Promise<StatusFetch>`

- [ ] **Step 1: Write the failing tests**

`test/commands/pairing-wait.test.ts`: the existing sequences wrap with `answered(status)` and use `UNREACHABLE_STATUS` for `undefined`. `pairViaHttp` gains a status code and records headers. Add:

```ts
test('defaultFetchStatus sends the token and reads a 401 as unauthorized', async () => {
  // real server: 401 when authorization !== `Bearer ${TOKEN}`, else '{"paired":true,"bot":"b"}'
  expect(await defaultFetchStatus(port)).toEqual({ kind: 'unauthorized' })
  expect(await defaultFetchStatus(port, TOKEN)).toEqual({ kind: 'answered', status: { paired: true, bot: 'b' } })
})
test('waitForPairing stops at once on unauthorized and passes its token', async () => {
  const fetchStatus = vi.fn(async () => UNAUTHORIZED_STATUS)
  expect(await waitForPairing({ ...base, token: TOKEN, fetchStatus })).toBe('unauthorized')
  expect(fetchStatus.mock.calls).toEqual([[1, TOKEN]])
})
```

`test/commands/manage.test.ts`: `base()` adds `token: NO_CLIENT_TOKEN`, `tokenFile: '/h/.config/telegram-ask/token'`. Add:

```ts
test('status prints where the token comes from, never its value', async () => {
  // for each [token, line]:
  //   NO_CLIENT_TOKEN                                  -> 'Token:   none'
  //   { kind: 'token', token: TOKEN, source: 'env' }   -> 'Token:   from TELEGRAM_ASK_TOKEN'
  //   { kind: 'token', token: TOKEN, source: 'file' }  -> 'Token:   from /h/.config/telegram-ask/token'
  // line comes right after the 'Port:' line; output never contains TOKEN; fetchStatus called with (9000, TOKEN or undefined)
})
test('status with an unusable token prints it and returns 1 without calling the service', async () => {
  // token { kind: 'unusable', message: 'bad token here' }
  // lines include 'Token:   unusable (bad token here)' and 'Pairing: unknown (no usable token)'; -> 1; fetchStatus not called
})
test('status returns 1 when the service rejects the token', async () => {
  // fetchStatus -> UNAUTHORIZED_STATUS, token from file
  // lines include 'Pairing: unknown (the service rejected the token)' then TOKEN_REJECTED_MESSAGE; -> 1
})
test('reset-owner with an unusable token fails before clearing the owner', async () => {
  // -> 1, out contains 'bad token here', confirm/clearOwner/restart/wait not called
})
test('reset-owner passes the token to the wait and explains unauthorized', async () => {
  // token from env; wait -> 'unauthorized'; -> 1; wait called with objectContaining({ token: TOKEN }); out contains TOKEN_REJECTED_MESSAGE
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/commands/pairing-wait.test.ts test/commands/manage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`defaultFetchStatus`: header when a token is given; `response.status === 401` gives `UNAUTHORIZED_STATUS`; a body passing `statusInfoSchema` gives `answered`; anything else, including a throw, gives `UNREACHABLE_STATUS`. `waitForPairing` calls `fetchStatus(options.port, options.token)` and returns `'unauthorized'` right away on that kind. `runStatus`: print the `Token:` line after `Port:` (helper `describeTokenSource(token, tokenFile)` in `status.ts`); if `running`, an `unusable` token prints the pairing-unknown line and returns 1; otherwise call `fetchStatus(record.port, token.kind === 'token' ? token.token : undefined)` and switch on the kind. `runResetOwner`: check `unusable` first, after the not-installed check and before any prompt; pass the token to `deps.wait`; `'unauthorized'` prints `describeUnauthorized(token.kind === 'token')` and returns 1. `cli.ts` resolves the token once per command run and passes `tokenFile: resolveTokenFile(process.env)` to `status`.

`init.ts` doesn't handle `'unauthorized'` yet; it falls through to the logs hint and returns 1, which Task 9 fixes.

- [ ] **Step 4: Run the tests**

Run: `npx vp test test/commands`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
git add src/commands src/cli.ts test/commands
git commit -m "feat: use the api token in status, reset-owner and the pairing wait"
```

---

### Task 8: Targets write the service's copy

**Files:**
- Modify: `src/install/types.ts` (`InstallPaths.tokenFile: string`; `InstallOptions.auth: ApiAuth`), `src/install/paths.ts` (`tokenFile: resolveTokenFile(env)`), `src/install/templates.ts` (`formatEnvFile` options gain `readonly auth: ApiAuth`), `src/install/quadlet.ts`, `src/install/compose.ts` (pass `auth: options.auth`), `src/install/systemd.ts`
- Modify: `src/commands/init.ts` (pass `auth: NO_AUTH` to `target.install` for now so types stay green; Task 9 replaces it)
- Test: `test/install/templates.test.ts`, `test/install/systemd.test.ts`, `test/install/quadlet.test.ts`, `test/install/compose.test.ts`, plus `auth: NO_AUTH` in existing `install(...)` fixtures

**Interfaces:**
- Consumes: `ApiAuth`, `NO_AUTH`, `resolveTokenFile`, `TOKEN_ENV_VAR` (Task 1).
- Produces: `InstallPaths.tokenFile`, `InstallOptions.auth`, `formatEnvFile({ provider, port, settings, auth })`.

- [ ] **Step 1: Write the failing tests**

`test/install/templates.test.ts`:

```ts
test('formatEnvFile writes the api token right after PORT', () =>
  expect(formatEnvFile({ provider: telegramProvider, port: 8787, settings: { botToken: 't', ownerId: 42 }, auth: { kind: 'token', token: TOKEN } }))
    .toBe(`PROVIDER=telegram\nBOT_TOKEN=t\nPORT=8787\nTELEGRAM_ASK_TOKEN=${TOKEN}\nOWNER_ID=42\n`))
// the existing formatEnvFile tests pass auth: NO_AUTH and keep their exact strings (no token line)
test('formatDockerfile never carries the token', ...) // formatDockerfile output doesn't contain 'TELEGRAM_ASK_TOKEN'
```

`test/install/systemd.test.ts`:

```ts
test('install writes apiToken, and a later install without a token deletes it', async () => {
  // install({ ...base, auth: { kind: 'token', token: TOKEN } }) -> readConfigFile(...).apiToken === TOKEN
  // install({ ...base, auth: NO_AUTH }) -> 'apiToken' not in the file
})
```

`test/install/quadlet.test.ts` and `compose.test.ts`: one test each that install with a token writes `TELEGRAM_ASK_TOKEN=${TOKEN}` into the target's `.env` (mode 0600 already asserted elsewhere) and that `Dockerfile` doesn't contain it.

A paths assertion (wherever `resolveInstallPaths` is already tested, else in `test/install/registry.test.ts`): `resolveInstallPaths({ HOME: '/h' }).tokenFile === '/h/.config/telegram-ask/token'`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/install`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`formatEnvFile`: lines are `PROVIDER`, first setting, `PORT`, then `` `${TOKEN_ENV_VAR}=${token}` `` for `kind: 'token'`, then the remaining settings. systemd's `updateConfigFile` patch adds `apiToken: options.auth.kind === 'token' ? options.auth.token : null`.

- [ ] **Step 4: Run the tests**

Run: `npx vp test`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
git add src/install src/commands/init.ts test/install
git commit -m "feat: write the api token into each target's service settings"
```

---

### Task 9: `init` picks the token, `uninstall` purges it

**Files:**
- Modify: `src/commands/types.ts` (`InitArgs.token?: boolean`: `true` for `--token`, `false` for `--no-token`, absent for neither), `src/commands/init.ts`, `src/commands/uninstall.ts`, `src/cli.ts` (`init` gains `.option('--token', 'require an API token (default for new setups)')` and `.option('--no-token', "don't require an API token")`, and passes `token` through)
- Test: `test/commands/init.test.ts`, `test/commands/manage.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `generateToken`, `parseToken`, `readTokenFile`, `writeTokenFile`, `removeTokenFile`, `NO_AUTH` (Task 1); `describeUnauthorized` (Task 4); `WaitOptions.token`, `'unauthorized'` (Task 7); `InstallPaths.tokenFile`, `InstallOptions.auth` (Task 8).
- Produces: `chooseAuth(args: InitArgs, deps: InitDeps, isReplacing: boolean): Promise<ApiAuth>`, private to `init.ts`.

Fixed copy (from the spec):
- question: `Require an API token? Scripts, n8n flows and agents in containers will need to send it.` (default `true`)
- `Reusing the saved API token.`
- `The saved API token was invalid; made a new one.`
- success with a token: `` `API token saved to ${paths.tokenFile}. Agents in containers need TELEGRAM_ASK_TOKEN set to it.` ``
- success without: `No API token: any local process can use the API.`
- uninstall prompt: `Also delete the saved credentials, API token and paired owner?`

- [ ] **Step 1: Write the failing tests**

`test/commands/init.test.ts` (helpers: `const savedToken = () => readFileSync(paths.tokenFile, 'utf8').trim()`; `const REQUIRE = 'Require an API token? ...'` as above):

```ts
test('fresh install generates a token, saves it before installing, and passes it on', async () => {
  // install mock records existsSync(paths.tokenFile) at call time -> true
  // -> 0; savedToken() matches /^[A-Za-z0-9_-]{43}$/; statSync mode 0o600
  // install called with objectContaining({ auth: { kind: 'token', token: savedToken() } }); wait with objectContaining({ token: savedToken() })
  // confirm never called with REQUIRE; out contains the saved-to line; out.join() never contains savedToken()
})
test('a valid token file is reused without asking', ...)        // seed + writeTokenFile(T) -> auth T, 'Reusing the saved API token.', no REQUIRE
test('replacing an install without a token file asks, and yes makes one', ...) // confirm called with (REQUIRE, true)
test('answering no installs without a token', async () => {
  // confirm: message === REQUIRE ? false : true -> install auth NO_AUTH, wait without token, 'No API token: ...', token file absent
})
test('--token and --no-token skip the question', ...)           // seeded install, neither calls confirm with REQUIRE
test('--no-token removes the token file only after the install succeeds', async () => {
  // writeTokenFile(T); install throws -> 1 and file still holds T; install succeeds -> 0 and file gone
})
test('an invalid token file is replaced without asking', ...)   // 'short-secret' -> new token, the invalid line, no REQUIRE, 'short-secret' not in out
test('an unreadable token file fails the install', ...)         // mkdirSync(paths.tokenFile) -> 1, 'Install failed:', install not called
test('the token is masked in install errors', ...)              // writeTokenFile(T); install throws Error(`boom ${T}`) -> out has 'boom ***', not T
test('a failed install keeps the new token for the retry', ...) // fresh; first install throws; second run passes the same auth.token
test('a stale TELEGRAM_ASK_TOKEN in the shell does not reach the wait', ...) // env { TELEGRAM_ASK_TOKEN: OTHER } -> wait gets savedToken()
test('an unauthorized wait returns 1 with the hint', ...)       // wait -> 'unauthorized' -> 1, out has TOKEN_REJECTED_MESSAGE
```

`test/commands/manage.test.ts`:

```ts
test('uninstall purge removes the token file; no purge keeps it', ...) // also asserts the new prompt text
```

`test/cli.test.ts`: `init --help` lists `--token` and `--no-token`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vp test test/commands test/cli.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

`chooseAuth`, called after the port check and before `target.install`, with `isReplacing = existing !== undefined`:
1. `args.token === false`: `NO_AUTH`.
2. `readTokenFile(paths.tokenFile)` (a throw propagates to `runInit`'s catch). Text present and `parseToken` succeeds: print the reusing line, use it. Text present but invalid: generate, print the invalid line.
3. File missing: generate when `args.token === true` or `!isReplacing`; otherwise ask the question; yes generates, no gives `NO_AUTH`.

For a token: `seen.push(token)` and `writeTokenFile` before `target.install`. After `writeInstall`, `NO_AUTH` calls `removeTokenFile`. `deps.wait` gets `token` when there is one. `'unauthorized'` prints `describeUnauthorized(auth.kind === 'token')` and returns 1. On `'paired'`, print the token or no-token line after `Check state:`. Update `runInit`'s JSDoc. `runUninstall`: new prompt text; on purge call `removeTokenFile(deps.paths.tokenFile)` next to `removeInstall`.

- [ ] **Step 4: Run the tests**

Run: `npx vp test`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
git add src/commands src/cli.ts test/commands test/cli.test.ts
git commit -m "feat: generate the api token in init and purge it on uninstall"
```

---

### Task 10: README and changeset

**Files:**
- Modify: `README.md`
- Create: `.changeset/local-auth-token.md`

- [ ] **Step 1: Update the README**

Follow the spec's Docs section, inside the existing structure. Check that every curl example in "Ask a question", "Send a notification" and "Status" has `-H "authorization: Bearer $(cat ~/.config/telegram-ask/token)"`, that every error table has `401 | Missing or wrong token.`, that Quick start and Agents (MCP) show `TELEGRAM_ASK_TOKEN=$(cat ~/.config/telegram-ask/token)` for container agents plus an `"env"` block for MCP clients, that From Node documents `token` and the per-call default lookup, that each target's "Written" list and Config mention the token file, `TELEGRAM_ASK_TOKEN` and `apiToken`, that Commands shows `[--token|--no-token]` and the `status` token line, that `uninstall`'s bullet mentions the API token, that Security replaces "There's no auth" with what the token stops and doesn't stop (same-user processes), and that rotation is "delete the token file and re-run `init`". Add an upgrade note under "Upgrading from the old setup": re-running `init` asks about the token (default yes), and curl, n8n and container callers need it once it's on.

- [ ] **Step 2: Add the changeset**

```md
---
'telegram-ask': minor
---

Optional API token. `init` generates one for new setups (and asks when upgrading an install without one); the service then answers 401 without it. The CLI, `mcp` and the Node `Client` send it on their own; curl, n8n and container agents set `TELEGRAM_ASK_TOKEN` to the contents of `~/.config/telegram-ask/token`.
```

- [ ] **Step 3: Verify**

Run: `grep -nP '\x{2014}' README.md .changeset/local-auth-token.md` (expect no output: no em-dashes), then `npx vp test`, `npm run check`, `npx tsc -p tsconfig.json`.
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md .changeset/local-auth-token.md
git commit -m "docs: document the api token"
```

## Not covered by tests

Real Podman and Docker runs (as before), the `listening on ... (token required)` startup line (`runService` exits the process; checked by reading the diff), and a real browser's CORS preflight (relies on the existing 405 test).
