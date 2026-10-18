# Provider seam: design

Source: brainstorming conversation on 2026-10-18. Builds on
`2026-10-18-telegram-approval-bot-design.md` and `2026-10-18-easy-install-design.md`; what those
describe stays as it is unless this doc says otherwise.

## Intent

Telegram is the only chat app the bot talks to, and it's assumed all over the code: setup, stored
secrets, the install targets, pairing text, the daemon. The owner wants Telegram to be easily
replaceable so that people who install the bot could, in the future, use a chat app they already
have. Owner's words: they want "telegram to be easily replaceable (even if the alternative doesn't
have the same features)".

There is no second app in mind yet. Telegram is enough for the owner; this is about leaving a clean
seam so adding one later is a contained job, not a rewrite.

## Goals

- One **provider** module owns everything specific to a chat app. Outside it, nothing imports
  grammY or knows about bot tokens, chat ids, `/start`, or `t.me` links.
- Telegram becomes the first (and for now only) provider. Its user-visible behavior doesn't change.
- A provider with fewer features still fits. Required parts are small; the rest is optional and the
  core copes when a part is missing (see "Required and optional parts").
- Config, env file, install targets, leftover-secret discovery and token masking don't name
  provider-specific keys. They handle whatever settings the selected provider declares.
- Existing installs keep working with no re-pairing and no manual migration.
- A fake provider in tests proves the seam: at least one fake that leaves every optional part out
  runs through request, answer, timeout and cancel.

## Non-goals

- Building a second real provider (Slack, Discord, Matrix, ntfy, email...). Not now.
- Renaming the package, binary, service, volume or config directory. `telegram-approval-bot` stays
  for now (my call; see "My calls"). The rename is a separate decision for later.
- Running several providers at once, or sending one request to more than one app.
- Changing `POST /request` semantics.

## Anti-goals

- Telegram behaving differently for current users after this change: different messages, a lost
  owner, a forced re-pair, a changed env file they'd have to fix by hand.
- An abstraction shaped so tightly around Telegram that a button-less or edit-less provider can't
  fit without changing the core again.
- Secrets showing up in logs, terminal output or world-readable files. The masking and permission
  rules that apply to the bot token today apply to every setting a provider marks as secret.

## The provider

A provider has two halves, because they run in different processes:

- **Setup half**, used by the CLI (`init`, `status`, `reset-owner`, `uninstall`): its name and
  label, which settings it needs, how to prompt for them, how to check them.
- **Runtime half**, used by the daemon: start, stop, send, receive answers, pairing.

The exact TypeScript shape is left to the builder. What follows is what it must be able to do.

### Required and optional parts (owner agreed to this split)

Required, every provider:

- **Check credentials.** At `init` (before installing) and at daemon startup. Returns a short
  display name on success (Telegram: `@botname`) or a reason on failure. Never includes secret
  values in the reason.
- **Send a request** to the owner: request id, text, option labels. Returns an opaque reference the
  core hands back later. The core doesn't look inside it.
- **Report answers**: "the owner picked option N for request X". The provider calls a callback the
  core passes in; the callback returns accepted or expired, as `ApprovalService.tap` does today,
  so the provider can react (Telegram shows "Expired").
- **Start and stop.** Stop is called on SIGTERM/SIGINT; the existing 5 s exit fallback stays.
- **Fatal errors.** The provider can tell the daemon it can't continue (Telegram: 409 "another
  instance is already polling"), and the daemon logs it and exits 1 as today.

Optional, the core must work when absent:

- **Request ended** (today's `finalize`). The core calls it once per request when it settles,
  with the reference, the settlement (answered / timed out / cancelled) and the formatted final
  text. Telegram edits the message and removes the buttons. A provider that can't edit can still
  use it for bookkeeping, e.g. a typed-reply provider dropping the request from its own list of
  open ones so it knows which request a "1" refers to. When the hook is missing, the core skips
  it. My call: the core never sends a follow-up message itself, since a follow-up per request is
  noise on apps that can't edit; a provider that wants one sends it from this hook.
- **Pairing.** When a provider supports it, it gets the pairing code from the core, checks
  attempts from senders, and reports the new owner. It also supplies the human instructions
  ("Send `/start ABCD-EFGH` to @bot, or open https://t.me/..."). When it doesn't support
  pairing, the owner/recipient is one of its settings, entered at `init`, and the service is
  "paired" as soon as it starts.
- **Buttons.** Not modeled as a capability in the core. A provider without buttons maps a typed
  reply ("1", "yes") to an option index itself; the core only ever sees an index.

The message length limit (`MAX_TEXT_LENGTH`, sized for Telegram's 4096) becomes a per-provider
value. The request parser takes the limit as input instead of using a Telegram constant.

### Identifiers

- Request ids stay strings, generated by the core.
- Owner and sender ids become strings in the generic layer. `Pairing`'s per-sender failure map keys
  on strings. Telegram converts its numeric ids at its edge, and keeps storing the owner as a
  number where it does today so existing files stay valid.
- `MessageReference` becomes opaque to the core (Telegram's `{ chatId, messageId }` lives inside the
  Telegram provider).

### Pairing code stays generic

Code generation, formatting (`ABCD-EFGH`), normalizing (case, dashes, whitespace) and the
per-sender failure limit stay in a provider-independent place. Stripping a leading `/start` or
`/start@bot` is Telegram's job (its provider strips it before handing the text to the generic
check).

## Settings, config and env

### Provider selection

- `config.json` gains `provider` (string). Env var `PROVIDER` overrides it, like `PORT` does.
- Missing `provider` means `telegram`. That's how every existing install reads after the change,
  with no file rewritten.
- An unknown provider name is a startup error: `unknown provider "<name>"; run
  \`telegram-approval-bot init\``.

### Provider settings

Each provider declares its settings. Per setting, at least: config key, env var name, whether it's
secret, whether it's the owner (cleared by `reset-owner`), and how to validate/convert the raw
string. Everything generic (config loading, env file writing, `readSecrets`, leftover discovery,
masking, `owner get`/`owner clear`) works from that declaration and never names a key.

Telegram declares:

| setting | config key | env var | secret | owner |
|---|---|---|---|---|
| bot token | `botToken` | `BOT_TOKEN` | yes | no |
| owner id | `ownerId` (number) | `OWNER_ID` | no | yes |

Telegram's config keys stay top-level in `config.json`, exactly where they are today (my call: no
nesting under a `telegram` object, so existing files, `updateConfigFile` and the loose schema keep
working unchanged). A future provider uses its own key names; collisions are the provider
author's problem to avoid, and a test should assert no two registered providers declare the same
config key or env var.

Generic keys (`provider`, `port`) and env vars (`PROVIDER`, `PORT`, `HOST`) stay outside provider
settings.

### Config shape at runtime

`Config` becomes generic: `provider`, `port`, `host`, plus the provider's resolved settings as an
opaque bag the provider itself validated. `loadConfig` still throws user-facing errors for a
missing required setting, using the setting's env var in the hint (today: `missing bot token; run
... (or set BOT_TOKEN)`; Telegram's wording stays identical).

## Install targets

- `Secrets` and `InstallOptions` stop having `token`/`ownerId` fields. They carry the provider name
  plus the provider's settings as key/values.
- The env file (`.env` for compose and quadlet) gets `PROVIDER=<name>` plus one line per provider
  setting, using the declared env var names. For Telegram the file is the same as today plus a
  `PROVIDER=telegram` line. My call: always write `PROVIDER`, even for Telegram, so the file says
  what it is.
- systemd's `config.json` gets `"provider": "telegram"` plus the same keys as today.
- `readSecrets`, `findLeftoverSecrets` and the legacy-install path read whatever keys the provider
  declares. When `PROVIDER` is absent (old files), assume Telegram. "First source with a token
  wins" becomes "first source with all of the provider's required secret settings wins".
- `clearOwner` clears the setting marked as owner. If the provider has no owner setting (no
  pairing), `reset-owner` prints that the provider doesn't support re-pairing and exits 1.
- The containers' `owner get` / `owner clear` subcommands (`src/commands/owner.ts`) work on the
  provider's owner setting instead of `ownerId`.
- File permission rules (owner-only) apply to any file holding a secret setting, which today means
  all of them.

## CLI

### `init`

- New step after picking the target: pick the provider. With only Telegram registered, skip the
  prompt and say nothing (my call: no "Provider: telegram" line, so the output is unchanged
  today). A `--provider <name>` flag selects it explicitly.
- Reuse logic (existing install, leftover secrets) works per provider: settings are reused only
  when the stored provider matches the selected one.
- Switching provider on re-init (only reachable once a second provider exists): `init` asks for
  confirmation that the old provider's settings and owner will be deleted, then the new install
  holds only the new provider's settings. For systemd that means removing the old provider's
  declared keys from `config.json` (today's merge would keep them); for containers it also
  clears the old owner in the data volume, as `clearOwner` does. No keeping both side by side.
  With only Telegram registered this path is covered by fake-provider tests only.
- Prompts come from the provider's setup half. Telegram's stay as they are ("Bot token", hidden,
  re-asked on rejection with the same message).
- Token masking in error output covers every value of every setting marked secret, not just the
  token.
- `validateToken` moves out of `system/host.ts` into the Telegram provider's setup half.

### `status`, `reset-owner`, pairing wait

- Pairing instructions printed by `status`, `waitForPairing` and the daemon log line come from the
  provider, not hardcoded strings. Text for Telegram stays identical.
- `/status` response: add fields that don't assume Telegram, without removing old ones. My call:
  `{ paired: true, provider, displayName }` or `{ paired: false, provider, displayName, code,
  instructions }`, where `instructions` is the ready-to-print pairing text. The Telegram provider
  also keeps sending `bot` (the username).
- Version skew is real: container images are pinned to the version `init` installed, while
  `npx telegram-approval-bot status` / `reset-owner` may run a newer CLI. So the CLI's status
  schema accepts the old shape (`{ paired, bot }` / `{ paired, code, bot }`, no `provider`) and
  treats it as Telegram, building today's `/start` / `t.me` text itself for that case only. When
  `instructions` is present, it's printed as is. Tests cover both shapes for `status` and
  `waitForPairing` (an old-shape body must not make `reset-owner` time out as `notStarted`).
- `reset-owner` confirmation: "This unlinks your Telegram account." becomes provider-supplied text
  (Telegram keeps that exact text).
- `uninstall` prompt "Also delete the bot token and paired owner?" becomes generic, e.g. "Also
  delete the saved credentials and paired owner?" My call; it's the one user-visible wording
  change for Telegram users.

## HTTP server

- 502 body "failed to send Telegram message" becomes "failed to send message". My call; clients
  should key on the status code, not the text. The service log still says which provider failed.
- Everything else unchanged.

## Daemon

`runService` loads config, looks up the provider by name, runs its credential check, wires its
runtime half to `ApprovalService` (send/finalize for outgoing, answer callback for incoming),
starts pairing if the provider supports it and no owner is set, then starts the provider and the
HTTP server. All grammY imports, `GrammyError` handling and the "don't print the token" care move
into the Telegram provider.

## Tests

- Existing Telegram tests keep passing, moved next to the Telegram provider where they test
  Telegram specifics. User-visible Telegram strings are asserted unchanged.
- A fake provider with no optional parts: request is sent, an answer via the callback settles it,
  timeout and cancel settle it, no finalize is attempted, `/status` reports paired from start.
- A fake provider with pairing but no finalize, to cover the pairing path without Telegram.
- Config and install tests: old files with no `provider` read as Telegram; new files get `PROVIDER`
  / `"provider"`; an unknown provider name fails with the message above; settings with secret flag
  are masked and written owner-only.
- Registry test: no two providers declare the same config key or env var.

## Left to the builder

- Exact types and module layout for the provider (folder names, how setup and runtime halves are
  split, how the registry of providers is defined). Follow the repo's existing style.
- Whether `Pairing` moves to its own module or stays near approval code.
- How a provider receives the core's callbacks (constructor args, a `start(handlers)` param, etc.).
- Order of the refactor steps, as long as tests pass at each commit.

## My calls (not discussed with the owner)

- Keep the `telegram-approval-bot` name everywhere for now.
- `finalize` becomes an optional "request ended" hook with the settlement; missing means skip, and
  the core never sends a follow-up itself.
- Switching provider on re-init confirms, then deletes the old provider's settings and owner.
- Telegram's config keys stay top-level in `config.json`; no nesting, no migration.
- Always write `PROVIDER` to new env files and `provider` to new config files, including Telegram.
- No provider prompt in `init` while only one provider exists; `--provider` flag added anyway.
- `/status` gains `provider`, `displayName`, `instructions`; Telegram keeps `bot`, and the CLI
  still understands the old shape from older pinned containers.
- Uninstall prompt and the 502 error text become generic; every other Telegram string stays the
  same.
- Message length limit becomes per provider.
