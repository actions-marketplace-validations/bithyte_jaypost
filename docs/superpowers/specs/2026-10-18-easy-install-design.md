# Easy install: design

Source: brainstorming conversation on 2026-10-18. Builds on
`2026-10-18-telegram-approval-bot-design.md`; the HTTP API and Telegram behavior described there
stay as they are unless this doc says otherwise.

## Intent

A new user should go from nothing to a bot running 24/7 (survives crashes, reboots, logout) with
as little work as possible. Owner's words: "as little work from the user as possible".

Today that takes a git clone, `npm install`, an interactive `npm run onboard` on the host, then
either a shell script for systemd or a hand-written `docker run`. Containers need the owner's
Telegram id found by hand. Rootless Podman isn't covered at all.

## Goals

- Publishable npm package: runnable with `npx telegram-approval-bot ...` and
  `npm i -g telegram-approval-bot`.
- One command, `telegram-approval-bot init`, that sets up and starts one of three targets and
  doesn't return until the bot is paired and running:
  - **systemd**: Node on the host, systemd user service.
  - **compose**: Docker with `docker compose` (v2), image built locally.
  - **quadlet**: rootless Podman, systemd-managed via quadlet, image built locally.
- Pairing code replaces interactive onboarding (owner's decision). The service pairs itself while
  running headless.
- Podman with quadlet is first-class (owner's decision; the owner's machine uses it).

## Non-goals

- Publishing to npm (the owner does that) and pushing images to a registry. Images are built on
  the user's machine.
- Windows and macOS service setup. `npx telegram-approval-bot start` in the foreground may work
  there; nothing more is promised.
- Rootful Podman, `podman-compose`, Kubernetes, launchd.
- Changing `POST /request` semantics.

## Anti-goals

- Anyone other than the owner becoming the owner. A stranger who finds the bot's public username
  must not be able to pair with it.
- The API reachable from outside the machine. Every target binds or publishes on `127.0.0.1` only.
- The bot token printed to a terminal, logged, or left in a world-readable file.
- `init` leaving a half-installed setup without saying what's there and how to remove it.

## Pairing (owner's decision: replaces `onboard`)

On start, if the config has a token but no owner id, the service enters pairing mode:

1. Generates a random code (my call: 8 chars from an unambiguous alphabet, e.g.
   `K7QM-4XPD`, about 40 bits, so guessing over Telegram isn't practical). New code on every start.
2. Logs one line: `Not paired. Send "/start K7QM-4XPD" to @<botname>`.
3. Listens for private messages. `/start <code>` with the right code (case-insensitive, dash
   optional): saves the sender's user id as owner, replies "Paired. Approval requests will appear
   here.", leaves pairing mode without restarting.
4. Anything else while unpaired: short reply "This bot isn't paired. Check the service logs for
   the pairing code." My call: after 5 wrong codes from one sender, ignore that sender until
   restart.
5. While unpaired, `POST /request` returns `503 {"error":"not paired"}`.

After pairing, behavior is today's: only the owner's taps count, everything else is ignored.

`OWNER_ID` env var still works and skips pairing (useful for scripted setups).

**Status endpoint (my call).** `GET /status` on the same local port returns
`{"paired": false, "code": "K7QM-4XPD", "bot": "my_bot"}` while unpaired and
`{"paired": true, "bot": "my_bot"}` after. `init` polls this to show the code and to know when
pairing is done, the same way for all three targets, without parsing logs. Exposing the code to
local processes is the same trust level as the API itself (anyone local can already send
requests). The 404/405 rules for other paths stay.

**Re-pairing.** `telegram-approval-bot reset-owner` clears the owner id and restarts the service
for the installed target, then waits for pairing like `init`.

## Config

- Same file and precedence as today: `$APPROVAL_BOT_CONFIG`, else XDG, else
  `~/.config/telegram-approval-bot/config.json`. Env vars `BOT_TOKEN`, `OWNER_ID`, `PORT`, `HOST`
  override.
- The file must be writable by the service now (pairing writes `ownerId`). When saving, write only
  what was in the file plus `ownerId`; don't copy env-provided values into it. Mode 0600, as today.
- Missing token is still a hard error. Missing owner is no longer an error; it means pairing mode.

## The CLI

Package `bin`: `telegram-approval-bot`. Subcommands:

| Command       | What it does                                                                          |
| ------------- | ------------------------------------------------------------------------------------- |
| `init [target]` | Interactive setup, below. Target optional: `systemd`, `compose`, `quadlet`.         |
| `start`       | Runs the service in the foreground. What every target runs.                           |
| `status`      | Which target is installed, whether it's running, paired, on which port.               |
| `test`        | Today's `test-request`: sends "This is a test" with Approve/Decline, prints the answer. |
| `reset-owner` | Clears owner, restarts, waits for re-pairing.                                         |
| `uninstall`   | Stops and removes what `init` installed. Asks before deleting config (token, owner).  |

`init` records what it installed in `~/.config/telegram-approval-bot/install.json` (target, port,
paths, image tag) so `status`, `reset-owner` and `uninstall` know what to act on.

### `init` flow

1. Detect what's available: `systemctl --user`, `docker compose`, `podman` (with version).
   Docker counts as available only if `docker info` works as the current user; if it fails with
   a permission error, compose is listed as unavailable with "not in the docker group". Ask
   which target, defaulting to the first available of quadlet, compose, systemd (my call on the
   order). Unavailable targets are listed with the reason. A target given on the command line
   skips the question.
2. If something is already installed (install.json exists), say what, and ask whether to replace
   it. Replacing stops and removes the old target but keeps the token and owner id (see
   "Re-running init" below).
3. Ask for the bot token (hidden input), validate with `getMe`, retry on failure. Never echo it,
   never include Telegram's error text (it can contain the token), as `onboard` does today.
   Skipped when a valid token is already known from the previous install.
4. Port: 8787, overridable with `--port`. No prompt (my call). Fail early with a clear message if
   it's in use.
5. Install and start the target (sections below).
6. Poll `GET /status` until it answers (timeout around 60s, then print where to find logs and
   exit non-zero). Print the pairing line, wait until `paired: true`, print "Done", plus the
   `status`/`test`/logs commands.
7. Ctrl-C during the wait: the service keeps running and keeps waiting for pairing; say so, and
   say `telegram-approval-bot status` shows the code again.

Only one instance per token can run (Telegram polling conflict). `init` stops anything it
previously installed before starting a new target; it can't detect a copy started by hand, so
the existing "another instance is already polling" error stays and the wait in step 6 should
surface it if the service exits.

### Re-running init (my call)

Re-running `init` (upgrade, same target, or switching targets) keeps the token and the owner, so
the user isn't asked for the token again and doesn't re-pair:

- Token: read from wherever the previous target kept it (config.json or the env file), checked
  with `getMe`; prompt only if missing or rejected.
- Owner: read from config.json (systemd) or from `/data/config.json` in the volume (containers,
  e.g. via a one-off `run` against the volume). Passed to the new target: written into
  config.json for systemd, `OWNER_ID` in the env file for containers.
- If both are reused, `init` still waits for `GET /status` to answer, but there's no pairing step.
- `uninstall` asks once whether to delete the token and owner too (config.json, env files, and
  the named volume). `init`'s internal replace never deletes them.

### Legacy installs (my call)

Installs from the old `onboard` + `install-service.sh` have no install.json. `init` treats an
existing `~/.config/systemd/user/telegram-approval-bot.service` without install.json as a legacy
systemd install: says so, stops and replaces it, and reuses token and owner from config.json like
a re-run. It can't see a hand-run container from the old Dockerfile; README tells upgraders to
stop it, and the 409 error covers the rest.

### Target: systemd

- Never sudo (owner's decision). `init` never runs anything as root, for any target.
- Needs a stable install path. If `init` is running from an npx cache (not a global install), it
  says so and installs itself (my call: do it, don't just print it, given the "least work" goal).
  If the global npm prefix is user-writable, `npm i -g telegram-approval-bot@<its own version>`.
  Otherwise (e.g. distro Node with prefix `/usr`), `npm i -g --prefix ~/.local/share/telegram-approval-bot/npm
  telegram-approval-bot@<version>` (exact path left to the builder). The unit uses the absolute
  bin path either way, so nothing needs to be on PATH.
- Writes `~/.config/systemd/user/telegram-approval-bot.service` with `ExecStart=<abs node>
  <abs global bin path> start`, `Restart=on-failure`, plus `Environment=APPROVAL_BOT_CONFIG=...`
  if it was set. Writes the token to config.json (0600). `daemon-reload`, `enable --now`.
- Linger: runs `loginctl enable-linger $USER` (my call: try it; on failure, print the command for
  the user to run). Same for quadlet.

### Target: compose

- Files in `~/.config/telegram-approval-bot/compose/` (my call: a fixed path, not cwd, so `init`
  works from anywhere and `uninstall` can find it):
  - `Dockerfile`: `node:24-slim`, `npm i -g telegram-approval-bot@<init's version>`, create `/data`
    owned by `node`, `USER node`, `ENV APPROVAL_BOT_CONFIG=/data/config.json HOST=0.0.0.0`,
    `CMD ["telegram-approval-bot","start"]`.
  - `compose.yaml`: build from that Dockerfile, `restart: unless-stopped`, named volume at `/data`,
    `env_file: .env`, port `127.0.0.1:<port>:<port>`.
  - `.env` (0600): `BOT_TOKEN=...`, `PORT=...`.
- Token goes via env; owner id is written by the service into `/data/config.json` on the named
  volume. Named volume, not a bind mount, to avoid host/container uid mismatches.
- `docker compose up -d --build`. Docker's restart policy handles reboots (daemon is rootful).

### Target: quadlet

- Requires Podman 4.4+ (quadlet). Doesn't use `.build` units, since those need Podman 5 and the
  owner's machine runs 4.9.3. Instead `init` runs `podman build -t
  localhost/telegram-approval-bot:<version>` from a context dir
  `~/.config/telegram-approval-bot/quadlet/` with the same Dockerfile as compose.
- Writes `~/.config/containers/systemd/telegram-approval-bot.container`: that image, named volume
  at `/data`, `EnvironmentFile=` pointing at the 0600 env file in the context dir,
  `PublishPort=127.0.0.1:<port>:<port>`, `[Service] Restart=on-failure`,
  `[Install] WantedBy=default.target`.
- `systemctl --user daemon-reload`, `start telegram-approval-bot`. Linger as for systemd.
- Upgrades: re-running `init` from a newer version rebuilds with the new tag. No auto-update.

## Package and build

- Compile TS to JS into `dist/` for publishing; Node won't strip types under `node_modules`.
  `bin` points at `dist/cli.js`, `files` covers `dist` (and templates, if they live as files).
  Drop `"private": true`. Keep `engines.node >=24`.
- Dev keeps running `.ts` directly as today.
- Remove `scripts/onboard.ts`, `deploy/`, the repo-root `Dockerfile` and `.dockerignore`. The
  Dockerfile now comes from `init`. `test-request` becomes `test`.
- README rewritten around `npx telegram-approval-bot init`, with one short section per target
  covering logs, status, uninstall, and what got written where.

## Left to the builder

- Module layout for the CLI, how templates are stored (string constants vs files in the package),
  argument parsing (plain `process.argv` is fine).
- How to test the container paths before the package is on npm (e.g. a hidden flag to install
  from a local `npm pack` tarball in the Dockerfile).
- Exact wording of prompts and messages, within the constraints above.
- How `status` detects "running" per target.

## My calls (not discussed with the owner)

- Pairing code length/alphabet, per-sender wrong-code limit, new code per start.
- `GET /status` endpoint exposing the code locally.
- `init` auto-runs `npm i -g` and `loginctl enable-linger`.
- Target default order quadlet > compose > systemd.
- Fixed file locations under `~/.config/telegram-approval-bot/`.
- No port prompt.
- Image built from the npm registry version, not from local source.
- Re-running `init` keeps token and owner; `uninstall` is the only thing that deletes them.
- Legacy `install-service.sh` installs are detected by unit path and replaced.
- Per-user npm prefix fallback when the global prefix isn't writable.
