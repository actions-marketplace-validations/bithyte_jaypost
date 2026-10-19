# Local auth token: design

Source: an autonomous brainstorming run on 2026-10-19 from this request: "Add an optional bearer
token that `init` generates and that `mcp`, `test`, `status` read. Today any local process or
container can POST questions to the owner." Nobody was available to answer questions, so every
choice the request doesn't settle is marked "Decision (made without user input)". Those are listed
again at the end so they can be checked in one pass.

Grounded in the code at `99ae1b9` (0.3.0). What exists stays as it is unless this doc says
otherwise.

## Intent

The HTTP API on `127.0.0.1:8787` has no auth. Anything that can open a TCP connection to it can
make the owner's phone buzz with a question or a notification, and read the pairing code from
`/status` while unpaired. That includes:

- any process on the host, under any user;
- a container that can reach host loopback (host networking, or Podman's pasta/slirp mapping);
- a web page in the owner's browser. The service accepts any content type, so a page can send a
  "simple" cross-origin `POST` with `text/plain` and no CORS preflight. The page can't read the
  answer, but the question still arrives. DNS rebinding could also let a page read `/status`.

The pairing code is the sharpest of these. Whoever reads it first and sends `/start CODE` to the
bot becomes the owner.

The fix: a random bearer token. `init` generates it and stores it where the service and the
clients can find it. The service rejects calls without it, and the CLI's own clients (`mcp`,
`test`, `status`, `send`, and the Node `Client`) send it on their own. Nobody on the host has to
copy it by hand unless they call the API from somewhere else (curl, n8n, a container).

## What it stops, and what it doesn't

Stops:

- other users on the host (the token file is mode 0600);
- containers that can reach the port but don't have the token;
- browser pages: an `Authorization` header forces a CORS preflight, and the service doesn't answer
  preflights, so the browser never sends the real request. Without the header the service answers
  401 before doing anything;
- reading the pairing code from `/status` without the token.

Doesn't stop:

- processes running as the owner's own user. They can read `~/.config/telegram-ask/token` like any
  other file in the owner's home. This is the usual limit of a local secret file, and the README
  should say so plainly;
- anything that has been handed the token, like an agent with `TELEGRAM_ASK_TOKEN` in its env.
  That's the point: the agent is a legitimate caller.

## Goals

- `init` generates a token on a fresh setup, saves it for the service and for clients, and reuses
  it on later runs so re-running `init` doesn't break callers that already have it. Upgrading an
  install that has no token asks first.
- A service with a token answers 401 on `/request`, `/notify` and `/status` without a valid
  `Authorization: Bearer <token>` header, before it reads the body or checks pairing.
- `mcp`, `test`, `status`, `send request`, `send notify`, `init`'s and `reset-owner`'s pairing
  wait, and the Node `Client` find the token by one rule and send it.
- A container agent can be given the token through one env var, `TELEGRAM_ASK_TOKEN`.
- Installs made before this change keep working exactly as today until the owner says yes to the
  token when re-running `init`.

## Non-goals

- TLS, or exposing the service beyond loopback. Still localhost only.
- More than one token, per-caller tokens, scopes or expiry.
- A rotate command. Rotation is "delete the token file, re-run `init`" (see below).
- Protecting against processes running as the same user.
- Rate limiting failed attempts. A 256-bit token can't be guessed.
- Host header checks or CORS support. The token covers the browser cases above.
- Auth on `/openapi.yaml`. It's the public shape of the API and holds nothing secret.

## Anti-goals

- The token in logs, error messages, argv, `ps` output, `status` output or `init` output. `init`
  prints the file path, never the value.
- The token in a container image layer. It goes in `.env` only, which `.dockerignore` already keeps
  out of the build context. Never in the `Dockerfile`.
- An install made by `init` that the CLI's own commands can't talk to.
- A comparison that leaks the token through timing.
- A token in the clients but none in the service, or the reverse, after a successful `init`.

## The token

- 32 bytes from `crypto.randomBytes`, encoded as base64url without padding: 43 characters from
  `[A-Za-z0-9_-]`. Those characters need no quoting in an env file, a systemd value, compose's
  `.env` (no `$`, so no interpolation) or an HTTP header.
- No prefix. Decision (made without user input): a prefix like `tga_` helps secret scanners, but
  this token never leaves the machine on purpose, and a bare base64url string keeps parsing simple.
- Accepted shape for any token read from env or a file: `TOKEN_PATTERN =
  /^[A-Za-z0-9._~+/-]{32,256}$/`. That's RFC 6750's `b64token` alphabet without trailing `=`,
  plus a length floor. Decision (made without user input): a 32-character minimum so a
  hand-set token can't be trivially short. `openssl rand -hex 16` and `openssl rand -base64 32`
  output both pass once trailing `=` is stripped. A value that fails the pattern is an error, never
  silently ignored.
- Comparison: hash the presented token and the configured one with SHA-256 and compare the digests
  with `crypto.timingSafeEqual`. Hashing first keeps lengths equal, so the length doesn't leak and
  `timingSafeEqual` can't throw.

## Where it lives

Decision (made without user input): two copies, one for the service and one for clients, both
written by `init`. The clients' copy is a single file that's the same for every target. The
service's copy goes wherever that target already keeps its settings, so the service reads it the
same way it reads `PORT` and `BOT_TOKEN`. I looked at having the service read the clients' file
through a bind mount, which would give one copy. I dropped it: rootless Podman maps the host user
to root in the container, so the container's `node` user can't read a 0600 file from the host, and
SELinux relabelling of a file in `$HOME` is its own mess. The `.env` route already works for the
bot token.

| Target  | Service reads                                         | Clients read                    |
| ------- | ----------------------------------------------------- | ------------------------------- |
| systemd | `apiToken` in the config file the unit pins           | `~/.config/telegram-ask/token`  |
| quadlet | `TELEGRAM_ASK_TOKEN=` line in `quadlet/.env`          | `~/.config/telegram-ask/token`  |
| compose | `TELEGRAM_ASK_TOKEN=` line in `compose/.env`          | `~/.config/telegram-ask/token`  |

- The token file is `<config directory>/token`, using the same directory as `install.json`
  (`$XDG_CONFIG_HOME/telegram-ask/`, else `~/.config/telegram-ask/`, ignoring
  `$TELEGRAM_ASK_CONFIG` like the other install files do). Contents: the token plus `"\n"`.
  Written with `writeFileAtomic` and `SECRET_FILE_MODE` (0600). Readers trim surrounding
  whitespace. `InstallPaths` gains `tokenFile`.
- Decision (made without user input): the name `token`, not `api-token` or `token.txt`. It's short
  enough to type in `$(cat ~/.config/telegram-ask/token)`.
- `apiToken` joins `RESERVED_CONFIG_KEYS` and `TELEGRAM_ASK_TOKEN` joins `RESERVED_ENV_VARS`, so no
  provider setting can take them.
- Decision (made without user input): one env var name, `TELEGRAM_ASK_TOKEN`, for the service and
  the clients. The other service vars are unprefixed (`PORT`, `BOT_TOKEN`), but `API_TOKEN` or
  `TOKEN` in an agent's shell is very likely to belong to something else. One name for one value
  also means a hand-run `telegram-ask start` and the `mcp` in the same shell agree without extra
  setup.

## Service side

### Config

- `fileConfigSchema` gains `apiToken: z.string().optional()`.
- `loadConfig` resolves `TELEGRAM_ASK_TOKEN` (empty counts as unset, as for every env var there),
  then the file's `apiToken`, then nothing. The result goes on `Config` as `auth: ApiAuth`:

  ```ts
  /** Whether the HTTP API demands a bearer token. */
  export type ApiAuth = { readonly kind: 'none' } | { readonly kind: 'token'; readonly token: string }
  ```

  with `NO_AUTH = { kind: 'none' } as const satisfies ApiAuth` in constants. This follows the repo's
  `kind` unions (`RequestResult`, `ApiResult`) rather than an optional string.
- A value that fails `TOKEN_PATTERN` throws `invalid api token; run \`telegram-ask init\` to set up
  the bot (or set TELEGRAM_ASK_TOKEN)`, matching the existing `invalid ${description}` errors. Like
  them, it never quotes the value.

### HTTP server

- `ApiServerOptions` gains `auth: ApiAuth` (required, so every caller decides). `startService`
  passes `config.auth`.
- With `kind: 'token'`, `/request`, `/notify` and `/status` get a route-level `onRequest` hook. It
  runs before Fastify reads the body, so an unauthenticated caller gets 401, not 413, 400 or 503,
  and can't learn the pairing state. The hook:
  - reads the `authorization` header and matches `/^Bearer +(\S+) *$/i` (scheme
    case-insensitive);
  - on a missing header, a header in any other form, or a token that doesn't match, replies `401`
    with `WWW-Authenticate: Bearer` and `{ "error": "unauthorized" }`. Every case gets the same
    reply, so a caller can't tell a wrong token from a missing one.
- With `kind: 'none'`, there's no hook and behavior is byte-for-byte today's. A header sent anyway
  is ignored.
- `/openapi.yaml`, the 404 handler and the 405 handler stay open. A 405 for `OPTIONS /request` is
  what makes browser preflights fail, and it doesn't change.
- Logging. Decision (made without user input): each rejection logs one stderr line,
  `rejected <METHOD> <path>: missing token` or `...: wrong token`, with no header value and no
  token. Logging which one it was is fine because only the owner reads the log. No rate limit: a
  misconfigured n8n flow will fill the journal, and I think that's the right nudge.
- On startup, the existing `listening on ...` line gains `(token required)` or `(no token)` so the
  logs show the mode. Decision (made without user input).

### OpenAPI

- `components.securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer', description }`. The
  description says the token is the one `init` saved to `~/.config/telegram-ask/token`, and that a
  service installed without one ignores the header.
- Root `security` changes from `[]` to `[{ bearerAuth: [] }]`. `/openapi.yaml` sets its own
  `security: []`.
- A shared `Unauthorized` response (`errorResponse('Missing or wrong bearer token.')`) on
  `/request`, `/notify` and `/status`, each as `'401'`.
- Decision (made without user input): the document always declares the scheme, whatever the
  install's mode. It's generated without access to the token config (`openapi` command, the docs
  copy), and a client that sends the header works against both modes. `security: [{ bearerAuth:
  [] }, {}]` would be the strictly accurate "optional" form, but generated clients handle it badly.
- Regenerate `docs/openapi.yaml` (`npm run openapi`). `test/server/openapi.test.ts` already fails
  until that's done.

## Client side

### One rule for finding the token

Every client resolves the token the same way:

1. `TELEGRAM_ASK_TOKEN`, if set and non-empty;
2. else the token file, if it exists;
3. else no token.

Decision (made without user input): no `--token` flag. Secrets on argv show up in `ps` and shell
history, and the env var already covers every case a flag would. Also no `--token-file` flag:
mounting the file into a container and setting the env var from it is a one-liner.

A new function returns this as data and never throws:

```ts
/** Token a client sends; `unusable` carries a message ready to show. */
export type ClientToken =
  | { readonly kind: 'none' }
  | { readonly kind: 'token'; readonly token: string; readonly source: 'env' | 'file' }
  | { readonly kind: 'unusable'; readonly message: string }
```

`unusable` covers a value that fails `TOKEN_PATTERN` and a token file that exists but can't be read
(anything but `ENOENT`). Messages name the source, never the value:
`TELEGRAM_ASK_TOKEN isn't a valid telegram-ask token` or
`token file "/home/u/.config/telegram-ask/token" isn't a valid telegram-ask token` (or `couldn't be
read: <reason>`).

Decision (made without user input): an `unusable` token is an error, not a fallback to the next
source or to sending nothing. Falling through would hide a typo behind a confusing 401.

### Module shape

Decision (made without user input): a new self-contained `src/auth/` module holds everything both
sides share, because config, server, install, client and commands all need it and none of them owns
it:

- `constants.ts`: `TOKEN_ENV_VAR`, `TOKEN_FILE_NAME`, `TOKEN_BYTES = 32`, `TOKEN_PATTERN`,
  `AUTHORIZATION_PATTERN`, `NO_AUTH`, `UNAUTHORIZED_ERROR`.
- `types.ts`: `ApiAuth`, `ClientToken`.
- `token.ts`: `generateToken()`, `parseToken(raw)` (undefined when invalid), `resolveTokenFile(env)`,
  `readTokenFile(path)` (missing file is a normal state), `writeTokenFile(path, token)`,
  `removeTokenFile(path)`, `resolveClientToken(env, tokenFile)`.
- `check.ts`: `isAuthorized(header: string | undefined, token: string): boolean`, pure, the SHA-256
  plus `timingSafeEqual` compare.
- `index.ts`: named re-exports.

Code style, settled (the request said to follow the global TypeScript rules but to match the repo's
conventions where they differ): the repo wins wherever the two conflict. That means exported
functions with JSDoc, not `<Module><Role>` classes; `Client` keeps its `#private` fields; tests
use the repo's runner (`vp test`, vitest API, `vi.fn`, `vi.stubEnv`), not `node:test`; and
formatting is the repo's (single quotes, no semicolons). Where the repo has no convention of its
own, the global rules apply: types are `type`, fields `readonly`, outcomes are `kind` unions,
payload-free variants are `as const satisfies`, regexes end in `_PATTERN`, errors are lowercase
with quoted values, and missing files are checked with the existing `isMissingFileError`. New
tests go under `test/auth/`.

### `postApi` and the messages

- `ApiOptions` gains `token?: string`. When set, the request carries
  `authorization: Bearer <token>`.
- `describeStatus` learns 401. It knows whether it sent a token:
  - sent none: `TOKEN_REQUIRED_MESSAGE`, roughly `telegram-ask service needs a token; set
    TELEGRAM_ASK_TOKEN to the contents of ~/.config/telegram-ask/token on the host`;
  - sent one: `TOKEN_REJECTED_MESSAGE`, roughly `telegram-ask service rejected the token; check
    TELEGRAM_ASK_TOKEN, or re-run telegram-ask init if the token file changed`.

  Final wording is the builder's. Both go in `client/constants.ts` with the other fixed messages.

### When the token is read

Decision (made without user input): long-lived callers (`mcp` and `Client`, when `Client` gets no
explicit `token`) look the token up again on every call. They don't cache it. An MCP server sits
in an open agent session for hours. If it read the token once, then turning auth on with `init`,
or rotating the token, would leave every running agent sending no token or a stale one until it
restarts. The lookup is one env read plus one small sync file read per call, which costs nothing
next to a call that waits on a human. One-shot commands (`send`, `test`, `status`, `init`,
`reset-owner`) resolve once per run, since a run is a single call or a short poll.

### Each caller

- `mcp`: `cli.ts` hands `runMcp` and `createMcpServer` the port plus a token lookup,
  `() => resolveClientToken(process.env, tokenFile)`, with `tokenFile` resolved once from the
  env. Each tool call runs the lookup. Decision (made without user input): bundle the two as one
  value, `{ port, readToken }` (a `ServiceAddress` type or similar), rather than another
  positional argument. Tests pass a fixed lookup. An `unusable` result doesn't stop the MCP server
  from starting, and it doesn't fail anything but the call that hit it: that call returns the
  message as a tool error, so the agent and the user see why, and the next call looks again. The
  old MCP design's anti-goal still holds: `mcp` never reads `config.json` or the bot token. It
  reads only the token file.
- `send request` / `send notify`: `createSendDeps` resolves the token, and `SendDeps` gains it. An
  `unusable` token prints `telegram-ask: <message>` and exits 1 without calling the service.
- `test`: sends the header. On `unusable`, it prints the message and returns 1. On 401, it prints
  the same text `postApi` would. It still uses its own `fetch` today; moving it onto `postApi` is the
  builder's call.
- `status`: prints one more line after `Port:`, `Token:   from TELEGRAM_ASK_TOKEN`,
  `Token:   from ~/.config/telegram-ask/token` (the real path) or `Token:   none`. On `unusable` it
  prints `Token:   unusable (<message>)`. Never the value. `fetchStatus` takes the token and returns
  a union instead of `StatusInfo | undefined`:

  ```ts
  type StatusFetch =
    | { readonly kind: 'answered'; readonly status: StatusInfo }
    | { readonly kind: 'unauthorized' }
    | { readonly kind: 'unreachable' }
  ```

  On `unauthorized`, `status` prints `Pairing: unknown (the service rejected the token)` with the
  `postApi` hint, and returns 1. Decision (made without user input): 1, because a CLI that can't
  talk to its own service is broken even if the unit is up.
- `waitForPairing` (used by `init` and `reset-owner`): `WaitOptions` gains `token?: string` and passes
  it to `fetchStatus`. On `unauthorized` it stops at once with a new `WaitResult` `'unauthorized'`
  instead of polling until the start timeout. Callers print the hint and return 1. After a
  successful `init` this shouldn't happen, but a wrong `TELEGRAM_ASK_TOKEN` in the shell running
  `reset-owner` would otherwise look like a service that never started.
- Node `Client`: `ClientOptions` gains `token?: string`. Decision (made without user input): when
  it's omitted, the `Client` uses the same rule as the CLI (env, then the token file), so a script
  on the host keeps working after `init` turns auth on. The lookup runs on each `request` and
  `notify` (see "When the token is read"), not in the constructor, so the constructor does no I/O,
  as today. An explicit `token` that fails `TOKEN_PATTERN` throws a `RangeError` from the
  constructor, since that's misuse. An `unusable` lookup makes that call reject with a
  `TelegramAskError` carrying the message. There's no way to force "send no token": a service
  without a token ignores the header, so nobody needs it.
- Decision (made without user input): `ClientOptions` gets no new fields besides `token`. There's
  no `env` or `configDirectory` injection on the public type. The lookup reads `process.env` and
  the default token path (`resolveTokenFile(process.env)`, which follows `XDG_CONFIG_HOME` and
  `HOME`). Tests drive it with `vi.stubEnv` for `TELEGRAM_ASK_TOKEN` and `XDG_CONFIG_HOME`
  pointing at a `mkdtemp` directory. Putting test seams on a published type would be the wrong
  trade.

## `init`, `uninstall`, `reset-owner`

### `init`

- New flags `--token` and `--no-token` (a commander option pair, so "neither" stays distinct from
  either one). The request calls the token optional. I read that as optional for the service
  (absent config means open, which keeps old installs and hand-run `start` working) and on by
  default for new setups.
- Decision (made without user input): whether `init` sets up a token depends on the situation,
  because `init` is also how people upgrade, and silently turning auth on during an upgrade would
  break every curl call, n8n flow and container agent with a 401:
  - `--token` or `--no-token` given: do that. No question.
  - The token file already holds a valid token: reuse it, print `Reusing the saved API token.`
    That install already had auth, so nothing changes for its callers.
  - Fresh setup (no existing install and no token file, whether or not a bot token was left over):
    generate one. Nothing calls this install yet, so nothing can break.
  - Replacing an existing install that has no token file (an upgrade from before this change, or
    an install made with `--no-token`): ask, in the same prompt style as `Replace it?`:
    `Require an API token? Scripts, n8n flows and agents in containers will need to send it.`,
    default yes. Yes generates one. No means `NO_AUTH`.
- Picking the token happens after the provider settings are settled and the port check passes,
  before `target.install`. Details of the cases above:
  - The file holds something invalid: generate one (no question; the file shows the user wanted a
    token) and say `The saved API token was invalid; made a new one.`
  - The file exists but can't be read: fail like any other install error.

  Decision (made without user input): the token file is the only place `init` looks for an old
  token. It doesn't read one back out of `.env` or `config.json`. If the file is gone, a new token
  is fine, because `init` rewrites the service's copy in the same run.
- A new or reused token is written to the token file before `target.install`, so a failed install
  followed by a retry reuses the same token. This matches how the saved bot token survives a failed
  run.
- The token goes into `seen` right away, so `redact` masks it in any error text.
- `InstallOptions` gains `auth: ApiAuth`. Targets:
  - quadlet and compose: `formatEnvFile` gains `auth` and writes `TELEGRAM_ASK_TOKEN=<token>` right
    after `PORT=`, or no line for `none`. It's reserved, so no provider setting collides with it.
  - systemd: the `updateConfigFile` patch adds `apiToken: token`, or `apiToken: null` for `none` so
    a replaced install doesn't keep an old token.
- `NO_AUTH` (from `--no-token` or a "no" answer): after `target.install` succeeds, remove the token
  file (`rm` with `force`). Before success it stays, so a failed run doesn't leave the old
  service's clients without their token.
- Switching from systemd to a container target leaves the old `config.json` (and its `apiToken`)
  on disk, as `remove(record, false)` already does for the bot token. The container never reads
  the host's `config.json`, so the stale value is harmless, and a later switch back to systemd
  overwrites it.
- `waitForPairing` gets the token.
- On success, after `Done. Try it: telegram-ask test`, one more line with a token:
  `API token saved to <path>. Agents in containers need TELEGRAM_ASK_TOKEN set to it.` With
  `NO_AUTH`: `No API token: any local process can use the API.` Wording is the builder's.

### `uninstall`

- Purge also removes the token file, after `target.remove` and next to `removeInstall`. The prompt
  becomes `Also delete the saved credentials, API token and paired owner?`
- No purge keeps the file. The next `init` finds it and reuses it, the same way it reuses the kept
  bot token.

### `reset-owner`

Doesn't touch the token. It passes it to `waitForPairing`.

### Rotating the token

Delete the token file and run `init` again, answering yes to the token question (or pass
`--token`). It removes the old service, generates a new token and writes both copies. Running
`mcp` servers and default `Client`s pick up the new token on their next call. Decision (made
without user input): no `--new-token` flag or `rotate` command for now. Rotation is rare, and the
two-step path is easy to document.

## Compatibility

| Situation                                                              | Result                                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Install from before this change, not re-initialized                    | No token anywhere. The service is open, new clients find no file and send nothing. Same as today.                                |
| Same install, `init` run again (upgrade)                               | `init` asks whether to require a token (default yes). On yes, host-side CLI, running `mcp` servers and `Client` pick up the file on their next call; curl, n8n and container agents get 401 until they send the token. On no, open as today. |
| New client, old service                                                | The header is ignored. Works.                                                                                                    |
| Old client (say `npx telegram-ask@0.3.0 mcp`) against a tokened service | 401, shown as `telegram-ask service error 401: unauthorized`. Upgrade the client, or re-run `init --no-token`.                  |
| Hand-run `telegram-ask start` with no config token and no env var      | Open, as today.                                                                                                                  |

The README needs an upgrade note: re-running `init` offers the token, and which callers need it
once it's on.
I'd ship this as a minor version (0.4.0), but release mechanics aren't part of this design.

## Docs

README changes, all in the existing structure:

- Security: replace "There's no auth" with what the token protects and what it doesn't (same-user
  processes), and where it lives.
- Quick start and Agents (MCP): container agents need `-e TELEGRAM_ASK_TOKEN=...`. Show
  `TELEGRAM_ASK_TOKEN=$(cat ~/.config/telegram-ask/token)` for the env and a JSON `"env"` block for
  MCP clients.
- HTTP API: every curl example gains `-H "authorization: Bearer $(cat ~/.config/telegram-ask/token)"`.
  The error tables gain `401 | Missing or wrong token.` `/status` notes it needs the token too.
- From Node: the `token` option and the default lookup.
- Install options: each target's "Written" list gains the token file and where the service's copy
  goes. Config gains `TELEGRAM_ASK_TOKEN` and `apiToken`.
- Commands: `init [systemd|compose|quadlet] [--port N] [--provider NAME] [--token|--no-token]`, and the
  `status` line.
- Upgrading: the compatibility note above.

## Testing

Real infra as the repo already does: Fastify `inject` or a listening server on port 0, temp
directories for files, the fake provider in `test/provider/fake.ts`.

- `test/auth/`: generated tokens match `TOKEN_PATTERN` and differ between calls; `parseToken`
  edges (31 characters, 256, 257, whitespace, `=` padding, non-ASCII); `isAuthorized` for a match,
  a wrong token, a different length, a lowercase `bearer` scheme, extra spaces, other schemes, an
  empty header and a missing header; `resolveClientToken` precedence (env beats file, empty env
  falls through to the file, a missing file is `none`, invalid env and invalid file are `unusable`,
  an unreadable file is `unusable`); token file written 0600, atomically, with a trailing newline,
  and read back trimmed.
- `test/config/store.test.ts`: env beats file, invalid values throw without quoting them, absent
  gives `none`.
- `test/server/server.test.ts`: with a token, 401 plus `WWW-Authenticate` for missing, malformed and
  wrong tokens on all three routes; 401 beats 503 (unpaired), 400 (bad JSON) and 413 (big body);
  `/openapi.yaml`, 404 and 405 unaffected; nothing reaches the fake provider on a 401; a right token
  behaves as today. Without a token, today's tests pass unchanged and a stray header is ignored.
- `test/server/openapi.test.ts`: the scheme and the 401s are there; the docs copy is regenerated.
- `test/client/http.test.ts` and `client.test.ts`: the header is sent iff a token is given; the
  `Client` lookup runs per call (changing the file between calls changes the header); both
  401 messages; `Client` default lookup through an injected env and a temp config directory; a
  `RangeError` for a bad explicit token; `TelegramAskError` for an `unusable` default.
- `test/mcp/server.test.ts`: tool calls carry the token; the lookup runs per call (a lookup that
  changes between calls sends the new token); `unusable` comes back as a tool error for that call
  only.
- `test/commands/`: `init` generates on a fresh setup, reuses a valid file without asking, asks
  when replacing an install with no token file (yes and no paths), skips the question for `--token`
  and `--no-token`, replaces an invalid file, honors `NO_AUTH`
  (removes the file only after success), masks the token in errors and passes it to the targets
  and the wait; `uninstall` purge removes the file and non-purge keeps it; `status` prints each
  `Token:` form and returns 1 on `unauthorized`; `waitForPairing` stops on `unauthorized`.
- `test/install/templates.test.ts`, `systemd.test.ts`: the `.env` line and its position, no line for
  `none`; `apiToken` written, or deleted for `none`.
- `test/cli.test.ts`: `send` exits 1 with the message on an invalid `TELEGRAM_ASK_TOKEN`.

Not testable here: real Podman and Docker runs. Compose is already marked untested on real Docker,
and this doesn't change that.

## Left to the builder

- Exact message wording, as long as no message contains the token.
- Whether `test` moves onto `postApi`.
- The name of the `{ port, token }` type and where it lives (`mcp` or `client`).
- Whether the auth hook is registered per route or as one hook that checks `routeOptions.url`, as
  long as it runs before the body is read and leaves 404/405 alone.
- Commit order. A sensible split: `auth` module, then service and config, then clients, then
  `init`/`uninstall`/targets, then docs and the regenerated OpenAPI file.

## Decisions made without user input

The builder check asked four questions that would normally go back to the owner. Each is settled
below and marked as made without user input: code style (19), whether an upgrade turns auth on
silently (14), reading the token once or per call (20), and test seams on the public `Client`
(21).

1. Two copies of the token: a client file shared by every target, plus the service's copy in the
   target's existing settings store (`.env` or `config.json`). No bind mount.
2. Client file at `<config directory>/token`, 0600, written atomically.
3. One env var, `TELEGRAM_ASK_TOKEN`, for the service and the clients. Config key `apiToken`. Both
   reserved from providers.
4. Token format: 32 random bytes, base64url, no prefix. Accepted shape `[A-Za-z0-9._~+/-]{32,256}`.
5. `/request`, `/notify` and `/status` need the token. `/openapi.yaml`, 404 and 405 don't.
6. Auth runs before the body is read and before the paired check. One 401 body for every failure.
7. Each rejection is logged without the token, with no rate limit. The startup line shows the mode.
8. The OpenAPI doc always declares `bearerAuth` as required on the three routes.
9. Client lookup: env, then file, then none. No `--token` or `--token-file` flag.
10. An invalid or unreadable token is an error, never a silent fallback.
11. The MCP server starts even with an unusable token and reports it as a tool error on the call
    that hit it.
12. `status` prints the token's source (never its value) and returns 1 when the service rejects
    the token. `waitForPairing` gains an `'unauthorized'` result.
13. Node `Client` defaults to the same env-then-file lookup. A bad explicit token is a
    `RangeError`.
14. `init` generates a token on a fresh setup, reuses a valid token file without asking, and asks
    (default yes) when replacing an install that has no token. `--token` and `--no-token` skip the
    question. `NO_AUTH` removes the file after success.
15. `init` reuses the token file's token and reads no other source. A new or reused token is
    written before the install, so a retry keeps it.
16. `init` prints the token's path, never the value.
17. `uninstall` purge deletes the token file. No purge keeps it for the next `init`.
18. Rotation is "delete the file, re-run `init`". No rotate command.
19. A new `src/auth/` module. Repo conventions win over the global TypeScript rules where they
    conflict (functions, vitest, formatting); the global rules fill the gaps.
20. `mcp` and a default-lookup `Client` read the token on every call, so running agents pick up a
    new or rotated token without a restart. One-shot commands read it once.
21. `ClientOptions` gains only `token`. Tests drive the default lookup with `vi.stubEnv`, not with
    public injection fields.
