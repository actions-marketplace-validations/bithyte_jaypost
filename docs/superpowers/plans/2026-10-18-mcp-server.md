# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `telegram-ask mcp` runs a stdio MCP server with `ask_for_permission` and `notify_user`, each forwarding to the local HTTP API, and both API endpoints gain an optional `project` field.

**Architecture:** The core parsers turn `project` + `text` into one combined message text, so services, providers and the final edited message need no change. A new `src/mcp/` module is a thin HTTP client (port resolution, POST with error mapping) plus an `McpServer` from the official SDK over stdio. The CLI gets an `mcp` subcommand.

**Tech Stack:** Node >= 24.2 running `.ts` directly, commander, zod 4, fastify (existing), `@modelcontextprotocol/sdk` ^1.32.1 (new), tests with `vite-plus/test`.

**Spec:** `docs/superpowers/specs/2026-10-18-mcp-server-design.md`

## Global Constraints

- Follow the repo's existing style, not a generic one: plain exported functions and small classes as in `src/approval/`, no semicolons, single quotes, printWidth 100, `vite-plus/test` imports, tests in `test/<module>/`, importing from `src/<module>/index.ts`.
- MCP process writes nothing but JSON-RPC to stdout. Diagnostics go to stderr.
- `src/mcp/` must not import `src/provider/`, `src/telegram/`, `src/config/store.ts`, or read `config.json`. Importing constants from `src/approval/index.ts`, `VERSION` from `src/config/index.ts` and `readInstall` from `src/install/index.ts` is fine.
- Host is always `127.0.0.1`.
- No retries of any HTTP call.
- `project`: trimmed, non-empty after trim, max 100 characters. Optional on the API, required (`project_name`) on both tools.
- Combined text format: `[<project>]`, blank line, text, i.e. `` `[${project}]\n\n${text}` ``.
- No em-dashes anywhere (code, comments, README, commits).
- Commits: conventional, lowercase summary. No `Co-Authored-By` or other Claude attribution (owner's rule).

## Review Focus

1. Agent passes `timeout_seconds` above 300: accepted, service clamps to 300, client fetch timeout uses the clamped value (Task 3 test `timeout above 300 is capped`).
2. Service dies mid-call (connection reset during an ask): tool error with the not-reachable text, MCP server keeps serving (Task 2 test `connection reset mid-request reads as unreachable`).
3. Something other than telegram-ask on the port answers with non-JSON (HTML 404 page): generic `service error` text, no crash (Task 2 test `non-json error body is used as is`).
4. stdin closes while an ask is pending: in-flight fetch aborted, service settles the request as cancelled (Task 3 test `closing stdin cancels a pending ask`).
5. Whitespace-only `project_name` passes the tool schema but the service rejects it: the service's 400 text reaches the agent (Task 3 test `service 400 text reaches the agent`).

---

### Task 1: `project` field on `/request` and `/notify`

**Files:**
- Modify: `src/approval/constants.ts`, `src/approval/formatter.ts`, `src/approval/parser.ts`, `src/approval/index.ts`
- Modify: `src/notify/parser.ts`
- Modify: `README.md` (API tables)
- Test: `test/approval/parser.test.ts`, `test/notify/parser.test.ts`, `test/server/server.test.ts`, `test/approval/service.test.ts`

**Interfaces:**
- Produces:
  - `MAX_PROJECT_LENGTH = 100` in `src/approval/constants.ts`, exported from `src/approval/index.ts`.
  - `formatProjectText(project: string, text: string): string` in `src/approval/formatter.ts`, returns `` `[${project}]\n\n${text}` ``. Exported.
  - `createTextSchema` loses its `maxTextLength` parameter (non-empty check only); length moves to a body-level step shared by both parsers via an exported helper in `src/approval/parser.ts`:
    `checkProjectText(text: string, project: string | undefined, maxTextLength: number): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }`. Without `project` it checks `text.length <= maxTextLength`; with one it checks the combined text against `maxTextLength` and reports `text must be at most ${maxTextLength - (project.length + 4)} characters`. Returns the combined text on success.
  - `createProjectSchema()` exported from `src/approval/parser.ts`: optional string, errors `project must be a non-empty string` (non-string, empty, whitespace-only) and `project must be at most 100 characters` (checked after trim), output trimmed.
  - `parseApprovalRequest` and `parseNotifyRequest` keep their signatures and result types; `value.text` is the combined text when `project` is given. Apply `checkProjectText` in the schema's `.transform((body, context) => ...)` with `context.addIssue` + `z.NEVER` on failure. Issue order between it and the `timeoutOption` refine doesn't matter; tests use single-problem bodies.

- [ ] **Step 1: Write the failing tests**

In `test/approval/parser.test.ts`:

```ts
test('project goes on its own first line, trimmed', () =>
  expect(parseApprovalRequest({ ...base, project: ' api ' }, 3900)).toEqual({
    ok: true,
    value: { ...base, text: '[api]\n\nThis is a test', timeoutSeconds: 300 },
  }))
test('project counts toward the text limit', () => {
  expect(parseApprovalRequest({ ...base, text: 'xxxx', project: 'ab' }, 10).ok).toBe(true)
  expect(parseApprovalRequest({ ...base, text: 'xxxxx', project: 'ab' }, 10)).toEqual({
    ok: false,
    error: 'text must be at most 4 characters',
  })
})
test.each([5, '', '   '])('bad project %s', (project) =>
  expect(parseApprovalRequest({ ...base, project }, 3900)).toEqual({
    ok: false,
    error: 'project must be a non-empty string',
  }))
test('project length limit', () => {
  expect(parseApprovalRequest({ ...base, project: 'x'.repeat(100) }, 3900).ok).toBe(true)
  expect(parseApprovalRequest({ ...base, project: 'x'.repeat(101) }, 3900)).toEqual({
    ok: false,
    error: 'project must be at most 100 characters',
  })
})
```

Same four tests in `test/notify/parser.test.ts` against `parseNotifyRequest({ text: ..., project: ... }, limit)`, expecting `value: { text: '[api]\n\nhi' }` for the first.

In `test/server/server.test.ts`: `'project is folded into the request text'` (POST `/request` with `{ ...valid, project: 'api' }`, assert the stub's first call arg `.text` is `'[api]\n\nDeploy?'`) and `'project is folded into the notification text'` (same for `/notify`, assert notify called with `{ text: '[api]\n\nhi' }`).

In `test/approval/service.test.ts`: `'final text keeps the project line'`: request with `text: '[api]\n\nDeploy?'`, tap option 0, assert `m.finalized[0]?.text` starts with `'[api]\n\nDeploy?\n\n'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vp test test/approval test/notify test/server`
Expected: the new tests FAIL (project ignored, text unchanged); the service test may already pass, which is fine (it pins behavior).

- [ ] **Step 3: Implement the interfaces above**

Existing error strings stay byte-identical, including `text must be at most 3900 characters` when no project is given.

- [ ] **Step 4: Run all tests and checks**

Run: `npm test && npm run check`
Expected: all pass, no lint or format errors.

- [ ] **Step 5: README**

Add a row to both API tables: `` | `project` | string | no | Shown as `[project]` on the first line. Trimmed, max 100 chars. Counts toward the 3900. | ``

- [ ] **Step 6: Commit**

```bash
git add src/approval src/notify test/approval test/notify test/server README.md
git commit -m "feat: accept a project name on /request and /notify"
```

---

### Task 2: MCP HTTP client and port resolution

**Files:**
- Create: `src/mcp/constants.ts`, `src/mcp/types.ts`, `src/mcp/client.ts`, `src/mcp/port.ts`, `src/mcp/index.ts`
- Test: `test/mcp/client.test.ts`, `test/mcp/port.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PORT` from `src/config/index.ts` (constant only), `readInstall` from `src/install/index.ts`.
- Produces (all exported from `src/mcp/index.ts`):
  - `type ApiPath = '/request' | '/notify'`
  - `type ApiResult = { readonly kind: 'ok'; readonly body: unknown } | { readonly kind: 'failed'; readonly message: string }`
  - `postApi(port: number, path: ApiPath, body: object, options: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<ApiResult>`. Never throws.
  - `resolveMcpPort(flagPort: number | undefined, env: NodeJS.ProcessEnv, installFile: string): number`: flag, else `env.PORT` if an integer 1-65535, else `readInstall(installFile)?.port`, else `DEFAULT_PORT`.

`postApi` failure messages (exact):

| Situation | `message` |
| --- | --- |
| fetch throws, not an abort | `telegram-ask service not reachable on 127.0.0.1:<port> (run telegram-ask status)` |
| `timeoutMs` elapsed | `telegram-ask service didn't answer within <timeoutMs / 1000> s` |
| `options.signal` aborted | `cancelled` |
| 400 | the body's `error` string |
| 404 on `/notify` | `telegram-ask service is too old for notifications (run telegram-ask init to upgrade)` |
| 501 | `notifications not supported by this provider` |
| 503 | `telegram-ask isn't paired yet (run telegram-ask status)` |
| 502 | `couldn't send the message to the user` |
| any other non-200 | `telegram-ask service error <status>: <error>`, where `<error>` is the JSON body's `error` string, else the raw body text trimmed |

The timeout row and `cancelled` are my additions; the spec doesn't name them. Combine signals with `AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])` and tell them apart by which one is aborted.

- [ ] **Step 1: Write the failing tests**

`test/mcp/client.test.ts`: helper `startStub(handler: http.RequestListener): Promise<number>` using `node:http` on port 0 (closed in `afterEach`), and `freePort()` (listen on 0, read the port, close). Tests:

- `'200 returns the parsed body'`: stub answers `{"answer":"Approve","timedOut":false}`; `postApi(port, '/request', {...}, { signal: new AbortController().signal, timeoutMs: 5000 })` equals `{ kind: 'ok', body: { answer: 'Approve', timedOut: false } }`; stub saw method POST, path `/request`, `content-type: application/json` and the JSON body.
- `test.each` over the status rows above: `[400, '/request', '{"error":"options must be unique"}', 'options must be unique']`, `[404, '/notify', '{"error":"not found"}', <too old text>]`, `[501, ...]`, `[503, ...]`, `[502, ...]`, `[500, '/request', '{"error":"internal server error"}', 'telegram-ask service error 500: internal server error']`; each equals `{ kind: 'failed', message }`.
- `'non-json error body is used as is'`: 404 on `/request` with body `<html>nope</html>\n` gives `telegram-ask service error 404: <html>nope</html>`.
- `'unreachable port'`: `freePort()` gives the not-reachable text with that port.
- `'connection reset mid-request reads as unreachable'`: stub calls `request.socket.destroy()`; result is the not-reachable text.
- `'timeout'`: stub never answers; `timeoutMs: 50` gives `telegram-ask service didn't answer within 0.05 s`.
- `'caller abort'`: stub never answers; abort the controller after the request is seen; result `{ kind: 'failed', message: 'cancelled' }`, and the stub sees the request's `close` event.

`test/mcp/port.test.ts` (`mkdtemp` for the install file, written with `writeInstall` from `src/install/index.ts`):

- `'flag wins'`: `resolveMcpPort(9000, { PORT: '9001' }, file-with-9002)` is `9000`.
- `'PORT env next'`: `resolveMcpPort(undefined, { PORT: '9001' }, file-with-9002)` is `9001`.
- `test.each(['abc', '0', '70000', ''])` `'bad PORT %s falls through'` to the install file's `9002`.
- `'install.json next'`: no flag, no env, file with 9002 gives `9002`.
- `'default'`: missing file gives `8787`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vp test test/mcp`
Expected: FAIL, module `src/mcp/index.ts` not found.

- [ ] **Step 3: Implement the interfaces above**

Put `HOST = '127.0.0.1'` and the message strings that are fixed copy in `src/mcp/constants.ts`.

- [ ] **Step 4: Run all tests and checks**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp test/mcp
git commit -m "feat: add the http client the mcp server uses"
```

---

### Task 3: MCP server, `mcp` command, README

**Files:**
- Modify: `package.json`, `package-lock.json` (dependency)
- Create: `src/mcp/server.ts`
- Modify: `src/mcp/constants.ts`, `src/mcp/index.ts`, `src/cli.ts`, `README.md`
- Test: `test/mcp/server.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `postApi`, `resolveMcpPort`, `ApiResult` (Task 2); `MAX_OPTION_LENGTH`, `MAX_PROJECT_LENGTH`, `MAX_TIMEOUT_SECONDS` from `src/approval/index.ts`; `VERSION` from `src/config/index.ts`.
- Produces (exported from `src/mcp/index.ts`):
  - `createMcpServer(port: number, signal: AbortSignal): McpServer` registering the two tools. `signal` aborts every in-flight call (used on shutdown).
  - `runMcp(port: number): Promise<number>`: connects `createMcpServer` to a `StdioServerTransport`, resolves `0` once stdin ends or closes, after aborting in-flight calls and closing the server.
  - `toFetchTimeoutMs(timeoutSeconds: number | undefined): number`: `Math.min(timeoutSeconds ?? 300, 300) * 1000 + FETCH_GRACE_MS`, with `FETCH_GRACE_MS = 30_000` in `src/mcp/constants.ts`.

Tools, via `server.registerTool(name, { description, inputSchema, outputSchema? }, handler)`:

- `ask_for_permission`, input: `project_name` (string, min 1, max `MAX_PROJECT_LENGTH`), `text` (string, min 1), `options` (array of strings min 1 max `MAX_OPTION_LENGTH`, min 1 item), `timeout_option` (string), `timeout_seconds` (positive number, optional; describe "default and max 300, longer values are capped", don't reject above 300). Output schema `{ answer: string, timed_out: boolean }`. POSTs `/request` with `{ project, text, options, timeoutOption, timeout? }`, `timeoutMs: toFetchTimeoutMs(timeout_seconds)`. Success: text content `answer`, or `` `${answer} (timed out, no answer from the user)` `` when `timedOut`, plus `structuredContent: { answer, timed_out }`.
- `notify_user`, input: `project_name`, `text` as above. POSTs `/notify` with `{ project, text }`, `timeoutMs: FETCH_GRACE_MS`. Success: text content `sent`.
- Any `failed` result: `{ isError: true, content: [{ type: 'text', text: message }] }`.
- Handler signal: `AbortSignal.any([extra.signal, signal])`.
- Descriptions (wording is the builder's, intent from the spec): notify_user tells the user something they don't need to answer, e.g. a task finished or the agent is stuck and needs help, and doesn't wait; ask_for_permission asks the user to choose with short button labels, blocks until answered or timed out, and on timeout returns `timeout_option`, so make that the safe choice.

- [ ] **Step 1: Add the dependency**

Run: `npm i @modelcontextprotocol/sdk@^1.32.1`
Expected: added to `dependencies`, no zod peer warning (it accepts zod `^4.0`).

- [ ] **Step 2: Write the failing tests**

`test/mcp/server.test.ts`. Helpers at top:

- `startApi(options?: { notifications?: boolean })`: real `createApiServer` from `src/server/index.ts` on `127.0.0.1` port 0 with a real `ApprovalService` over a recording messenger (`sent`, `finalized`, like `FakeMessenger` in `test/approval/service.test.ts`) and, unless `notifications: false`, a real `NotificationService` over a recording notifier. Status always paired, `maxTextLength: 3900`. Returns `{ port, service, messenger, notifier }`; closed in `afterEach`.
- `connect(port: number)`: SDK `Client` + `StdioClientTransport({ command: process.execPath, args: ['src/cli.ts', 'mcp', '--port', String(port)], stderr: 'pipe' })`; closed in `afterEach`.
- `waitFor(condition: () => boolean)`: polls every 10 ms, fails after 5 s.

Tests:

- `'lists exactly the two tools with project_name required'`: `listTools()` names sorted equal `['ask_for_permission', 'notify_user']`; each `inputSchema.required` contains `'project_name'`.
- `'ask returns the tapped answer'`: call `ask_for_permission` with `{ project_name: 'api', text: 'Deploy?', options: ['Approve', 'Decline'], timeout_option: 'Decline' }`; `waitFor` one sent message, assert its text is `'[api]\n\nDeploy?'`, `service.tap(id, 0)`; result equals `{ content: [{ type: 'text', text: 'Approve' }], structuredContent: { answer: 'Approve', timed_out: false } }`.
- `'ask on timeout returns the timeout option'`: `timeout_seconds: 0.2`, nobody taps; text `'Decline (timed out, no answer from the user)'`, structured `{ answer: 'Decline', timed_out: true }`.
- `'timeout above 300 is capped'`: unit test on `toFetchTimeoutMs`: `900` gives `330_000`, `undefined` gives `330_000`, `10` gives `40_000`.
- `'service 400 text reaches the agent'`: `project_name: '   '`; result `{ isError: true, content: [{ type: 'text', text: 'project must be a non-empty string' }] }`.
- `'notify sends and returns'`: `notify_user` `{ project_name: 'api', text: 'done' }`; result text `'sent'`; notifier got `'[api]\n\ndone'`.
- `'notify without provider support'`: `startApi({ notifications: false })`; error text `notifications not supported by this provider`.
- `'service down is a tool error and the server keeps going'`: connect to a free port, `notify_user` returns the not-reachable text with `isError: true`; then a second call also returns a result (process still alive).
- `'cancelling an ask cancels the request'`: call with an `AbortController` signal in the request options, `waitFor` sent, abort; `waitFor` `messenger.finalized[0]?.settlement.kind === 'cancelled'`.
- `'closing stdin cancels a pending ask'`: start the ask without awaiting, `waitFor` sent, `client.close()`; `waitFor` finalized with `cancelled`.
- `'stdout carries only json-rpc'`: `spawn(process.execPath, ['src/cli.ts', 'mcp', '--port', String(port)])` directly, write an `initialize` request, the `notifications/initialized` notification and a `tools/list` request as newline-delimited JSON, end stdin, collect stdout until exit; every non-empty line `JSON.parse`s and has `jsonrpc: '2.0'`; exit code `0`.

In `test/cli.test.ts`: `'mcp rejects a bad port with 2'`: `main(['mcp', '--port', 'abc'])` is `2`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vp test test/mcp/server.test.ts test/cli.test.ts`
Expected: FAIL, `createMcpServer` not exported and `mcp` is an unknown command.

- [ ] **Step 4: Implement `createMcpServer`, `runMcp`, `toFetchTimeoutMs` in `src/mcp/server.ts`**

`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, server info `{ name: 'telegram-ask', version: VERSION }`. Listen for both `end` and `close` on `process.stdin`; the SDK transport doesn't resolve anything on its own when stdin ends.

- [ ] **Step 5: Add the `mcp` command in `src/cli.ts`**

```
telegram-ask mcp [--port N]
```

Description `run an MCP server on stdin/stdout for agents`, `--port <n>` with the existing `parsePort`. Action: `code = await runMcp(resolveMcpPort(options.port, process.env, resolveInstallPaths().installFile))`. It doesn't use `resolvePort()` (that reads `config.json`). Nothing in this path may `console.log`.

- [ ] **Step 6: Run all tests and checks**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 7: Check Claude Code's MCP tool-call timeout**

Look up Claude Code's default MCP tool timeout (the `MCP_TOOL_TIMEOUT` env var in its docs). If the default is under 330 s, the README section below says so and shows `MCP_TOOL_TIMEOUT=330000`. If it's longer, leave it out. Record what you found in the commit message body.

- [ ] **Step 8: README**

Add `## MCP server` after the API section, before Security. Cover, briefly in the README's voice:

- `telegram-ask mcp [--port N]`, the two tools and their params (table each), what each returns, and that `project_name` shows as `[name]` on the first line.
- Registering: `claude mcp add telegram-ask -- telegram-ask mcp`, the `npx -y telegram-ask mcp` form for container installs without the package, and a generic JSON snippet `{ "mcpServers": { "telegram-ask": { "command": "telegram-ask", "args": ["mcp"] } } }`.
- Port order: `--port`, `PORT`, `install.json`, 8787. A hand-run `start` on a custom port with no install needs `--port` or `PORT`.
- The service must be running; calls made while it's down return an error, the MCP server stays up.
- Version skew: `project` needs a service at least as new as this release; an older service sends the message without the project line, and `notify_user` reports the service as too old. Re-run `init` to upgrade.
- Tool timeout note from Step 7, if any.

Add `telegram-ask mcp` to the Commands list with one bullet.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/mcp src/cli.ts test/mcp test/cli.test.ts README.md
git commit -m "feat: add telegram-ask mcp with ask_for_permission and notify_user"
```
