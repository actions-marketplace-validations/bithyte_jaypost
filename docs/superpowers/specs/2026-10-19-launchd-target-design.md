# launchd install target (macOS): design

Source: a brainstorming session with the owner on 2026-10-19. Meant to be built in a session on
the owner's Mac, after `2026-10-19-standalone-binary-design.md` has landed (it adds the binary,
the `binary` kind of `CliLocation`, the copy to `~/.local/bin`, and `update`). Read that one
first. Calls the owner made are stated plainly; calls I made are marked "My call". Anything not
mentioned here stays as it is.

## Intent

On a Mac, `telegram-ask init` should give a background service, the way the systemd target does
on Linux. Today `init` knows quadlet, compose and systemd; on a Mac only compose can work, and only
with Docker installed and running.

The owner wants this to work from the standalone binary (no Node on the Mac) and from an npm
install.

## Goals

- A new install target, `launchd`, available on macOS. `init launchd` (or picking it from the
  list) installs a per-user LaunchAgent that runs `telegram-ask start`, starts it now, and starts
  it again at login.
- Works from the binary (copies itself to `~/.local/bin/telegram-ask`, same as the systemd target)
  and from an npm install (runs `<node> <cli.js> start`, same CLI resolution as the systemd target,
  including the `npm i -g` fallback).
- `status`, `reset-owner`, `uninstall` and `update` work with it, through the same `Target`
  interface the other targets implement.
- The darwin release binaries from the binary design are confirmed to run on a real Mac.

## Non-goals

- A LaunchDaemon (system-wide, runs at boot without anyone logged in). It needs root. The owner's
  Mac always has them logged in to the desktop, and SSH-only use isn't needed, so a per-user
  LaunchAgent in the `gui/<uid>` domain is enough. It matches the no-sudo systemd user service.
- Changing the config location on macOS. Config stays under `~/.config/telegram-ask/` (or
  `$XDG_CONFIG_HOME`), as today. No move to `~/Library/Application Support`.
- Notarization or a Developer ID signature. Ad-hoc signing is enough for a binary fetched with
  curl. See "Gatekeeper" below.
- Homebrew formula.

## Anti-goals

- `init` on Linux behaving any differently. `launchd` is never offered there.
- Leaving a loaded agent behind after `uninstall`, or two copies of the service running after
  re-running `init`.

## Target order on macOS

Today `TARGET_ORDER` is quadlet, compose, systemd, and the first available one is the default.
On a Mac, quadlet and systemd are never available.

My call: on macOS, `launchd` comes before compose. Docker Desktop has to be running for the
compose service to be up, which makes it a weaker background service on a Mac than a LaunchAgent.
Linux order doesn't change. How the order is expressed per platform is the builder's call.

## What the target writes

- `~/Library/LaunchAgents/<label>.plist`. Label: `telegram-ask` would match the systemd unit name,
  but launchd labels are conventionally reverse-DNS. My call: `io.github.cozminu.telegram-ask`.
- `ProgramArguments`: `[<home>/.local/bin/telegram-ask, start]` for the binary, or
  `[<node>, <cli.js>, start]` for npm. Homebrew Node: `process.execPath` is the versioned Cellar
  path (`/opt/homebrew/Cellar/node/24.x.y/bin/node`), which disappears after `brew upgrade` and
  cleanup, and the agent would then fail and retry forever. My call: when `execPath` is under a
  Homebrew Cellar, use the stable `<prefix>/opt/<formula>/bin/node` symlink instead, if it exists
  and resolves to the same file. Otherwise use `execPath` as is.
- `EnvironmentVariables`: `TELEGRAM_ASK_CONFIG` pinned to the absolute config path, same reason as
  the systemd unit (later commands don't depend on the shell's environment). No `PATH`; `start`
  doesn't need one.
- `RunAtLoad: true`.
- `KeepAlive: { SuccessfulExit: false }`, the equivalent of `Restart=on-failure`.
  `ThrottleInterval: 5`, the equivalent of `RestartSec=5`.
- `StandardOutPath` and `StandardErrorPath`: `~/Library/Logs/telegram-ask/telegram-ask.log` (one
  file for both). There's no journal. Create the directory first. Log rotation is out of scope.
- The config file, written the same way the systemd target writes it (`updateConfigFile`).
- `install.json` with `target: 'launchd'`, the CLI kind, `cliPath` and `configFile`, as for
  systemd.

The plist values must be XML-escaped (paths can contain `&` or `<`). Writing a small plist
formatter next to `formatSystemdUnit` in `templates.ts` fits the existing layout.

## Lifecycle, mapped to `launchctl`

Domain is `gui/<uid>` (uid from `os.userInfo()`).

- `available()`: `process.platform === 'darwin'`, `launchctl` runs, and the `gui/<uid>` domain
  exists (`launchctl print gui/<uid>` succeeds; it doesn't over an SSH session with nobody logged in
  to the desktop). Reason otherwise: "launchd is macOS only", "launchctl not available", or "no
  desktop session; log in on the Mac first".
- `install()`: resolve the CLI (binary copy or npm, shared with the systemd target, not
  duplicated), write config and plist. If the agent is already loaded, `launchctl bootout` it
  first (ignore "not loaded"). Then `launchctl bootstrap gui/<uid> <plist>`. `enable` isn't needed
  for a fresh agent, but if a previous `launchctl disable` left it disabled, bootstrap fails;
  run `launchctl enable gui/<uid>/<label>` before bootstrapping. No linger step.
- `restart()`: `launchctl kickstart -k gui/<uid>/<label>`.
- `isRunning()`: `launchctl print gui/<uid>/<label>` succeeds and shows a running state with a
  pid. Parse defensively; the output format isn't a stable API.
- `remove(record, purge)`: `launchctl bootout gui/<uid>/<label>` (ignore "not loaded"), delete
  the plist. Purge: delete config, state file, and the `~/.local/bin` copy for a binary install,
  and print the `npm rm -g` hint for npm, same as systemd. Logs are left (my call; they hold no
  secrets the config doesn't, and the owner might want them).
- `readSecrets()`, `clearOwner()`: same as systemd (config file based). Reuse its code.
- `logsHint()`: `tail -f ~/Library/Logs/telegram-ask/telegram-ask.log`.

## `update`

Works as in the binary design: step 1 gets the new binary or npm package, then the new CLI's
finish step rewrites the plist from its own template and restarts the agent (`bootout` +
`bootstrap` if the plist changed, otherwise `kickstart -k`).

The asset name for a Mac is `telegram-ask-darwin-<arch>.gz`. After gunzip and before the rename,
check the new binary's signature is valid (`codesign --verify`), and if it isn't, ad-hoc sign it
(`codesign --sign - --force`). If that fails, abort the update and keep the old binary. My call;
it avoids swapping in a binary macOS will kill on launch.

## Gatekeeper

A file downloaded with a browser gets the `com.apple.quarantine` attribute, and Gatekeeper may
refuse to run an ad-hoc signed binary with it. curl doesn't set it. The README should give the
curl install, and mention `xattr -d com.apple.quarantine telegram-ask` for anyone who downloaded
through a browser. When `init` copies the binary to `~/.local/bin`, drop the quarantine attribute
from the copy (`xattr -d`, ignore "no such xattr"). My call.

## First thing to check on the Mac

Before building the target, confirm the darwin release binaries work:

1. Download `telegram-ask-darwin-arm64.gz` (and x64 if there's an Intel Mac or Rosetta to try)
   from the latest release with curl, gunzip, `chmod +x`.
2. `./telegram-ask --version`, `--help`, `status`. No `punycode` warning.
3. `codesign --verify --verbose ./telegram-ask`.

If they don't run (signature killed, missing symbols), fix the build in the release workflow first
(likely: build darwin on a `macos-latest` runner and `codesign --sign -` there). That fix belongs
to the binary design's release job.

## README

- `init` step 1 lists launchd among the targets.
- New "launchd (macOS)" section next to "systemd (npm)": what's written, that it runs while you're
  logged in, the log path, the Gatekeeper note.
- The Node requirement line covers launchd the same way it covers systemd.

## Testing

Same style as the systemd target tests (fake `exec`, temp dirs, `vite-plus/test`): plist content
for both CLI kinds and escaping, the `launchctl` calls and their order for install, re-install,
restart, remove, purge, `available()` on a non-darwin platform (inject the platform; don't read
`process.platform` inside the target).

Manual on the Mac: `init launchd` from the binary, pair, `status`, log out and back in and check
it's running, `kill -9` the process and check launchd restarts it (a plain `kill` sends SIGTERM,
which `start` handles by exiting 0, so `SuccessfulExit: false` correctly leaves it stopped, same as
`Restart=on-failure`), `update` from an older release,
`uninstall` with purge and check `launchctl print` no longer finds it. Then the same `init` from an
npm install.

## Left to the builder

- How the per-platform target order is expressed.
- How CLI resolution is shared between the systemd and launchd targets.
- `isRunning()` parsing details.
- Whether `InstallPaths` gets the plist and log paths (it should, to match how the systemd unit
  path is handled).
