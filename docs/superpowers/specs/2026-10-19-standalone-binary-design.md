# Standalone binary and `update`: design

Source: a brainstorming session with the owner on 2026-10-19. Builds on the `vp pack` `exe`
experiment written up in `docs/standalone-executable.md` (that file has the build numbers and the
list of what broke). Calls the owner made are stated plainly; calls I made are marked "My call".
Anything not mentioned here stays as it is.

The macOS service target (launchd) is a separate design, `2026-10-19-launchd-target-design.md`,
to be built later on a Mac. This one covers Linux end to end and only builds the macOS binaries.

## Intent

Someone with a server and no Node installed wants the bot running as a systemd user service.
Today that's impossible without Node: the systemd target either reuses an npm-installed CLI or
runs `npm i -g` itself, and the unit runs `<node> <cli.js> start`. The container targets bring
their own Node but need Podman or Docker.

They should be able to download one file from the GitHub Release, run `./telegram-ask init`, pick
systemd, and end up where an npm user ends up. Later they run `telegram-ask update` to move to a
new version.

`update` isn't only for the binary. It works for every kind of install: the binary, npm installs,
and the two container targets.

## Goals

- Every npm release also gets standalone binaries attached to its GitHub Release, built in the
  same workflow run from the same commit, for `linux-x64`, `linux-arm64`, `darwin-x64` and
  `darwin-arm64`, plus a checksums file.
- Run from the binary, `init` with the systemd target copies the binary to
  `~/.local/bin/telegram-ask` and writes a unit whose `ExecStart` runs that copy directly. It never
  calls npm and never needs Node.
- `telegram-ask update` brings the installed service (or, with nothing installed, the CLI you ran)
  to the latest release, for all four install kinds, and restarts the service.
- The binary runs without printing the `punycode` deprecation warning, so it doesn't show up in the
  service logs on every start.
- The npm package build (`npm run build`, on Node 24) and what ends up in the npm tarball don't
  change.

## Non-goals

- A launchd target. Separate design. Until it exists, `init` on a Mac offers only what's available
  there today (compose, if Docker is set up).
- Windows binaries. There's no Windows service target.
- Automatic update checks, or the bot telling you a new version exists. `update` runs when you run
  it.
- Rolling back a bad update. To go back, download the older binary and run `init`, or
  `npm i -g telegram-ask@<version>`.
- Updating to a specific older or newer version (`update --version X`). Latest only.
- Signed binaries or build provenance attestations beyond the checksums file. Could be added later.
- Hook mode, `mcp`, `send` etc. need no special work; they ran fine from the binary in the
  experiment. They aren't retested beyond what's listed under Testing.

## Anti-goals

- Changing anything for npm users who never touch the binary, beyond gaining `update`.
- `update` leaving a broken install behind when a download, checksum, npm install or image build
  fails. A failure before the swap leaves the old version installed and running.
- The binary build requiring Node >= 25.7 for local development or for `npm run build`. The repo
  stays on Node 24.
- A half-uploaded release that `update` installs from. If the binary for this platform isn't on
  the release yet, `update` says so and does nothing.

## How the binary is built

The experiment's config works, with these changes:

- It lives apart from the npm pack config, so `vp pack` and `npm run build` keep producing exactly
  what they do now. The branch currently has an uncommitted change to `vite.config.ts` and
  `tsconfig.build.json` that moves the npm build to `vp pack`. That's the owner's separate work:
  don't modify or commit those changes as part of this. The exe build goes on top of whatever npm
  build is in place when this is built, without changing it. How it's kept apart (separate config
  file, a script, an env check) is the builder's call.
- `deps: { alwaysBundle: [/.*/], onlyBundle: false }` and `minify: true`, as in the experiment.
- `exe.targets` lists the four platforms. Embedded Node version: 26, the newest major (`exe` needs
  >= 25.7). My call.
- Building needs Node >= 25.7 on the build machine. Locally that's
  `vp env exec --node 26 node node_modules/.bin/vp pack ...` (or whatever the exe script ends up
  being); add an npm script for it, e.g. `build:exe`.
- The `punycode` warning: find which bundled dependency imports `punycode` and make it resolve to
  the userland `punycode` package (bundler alias) rather than the Node built-in. Silencing the
  warning is the fallback if aliasing doesn't work.

Asset names on the release:

```
telegram-ask-linux-x64.gz
telegram-ask-linux-arm64.gz
telegram-ask-darwin-x64.gz
telegram-ask-darwin-arm64.gz
SHA256SUMS
```

My call: gzip each binary. Raw they're about 152 MB, mostly Node, and gzip should cut that a lot
on a server download. `SHA256SUMS` holds the sha256 of each `.gz` file in `sha256sum` format.
Platform and arch names follow Node's `process.platform` and `process.arch`, so `update` can build
the asset name directly.

macOS binaries need a code signature to run on Apple Silicon (an unsigned or invalidly signed
binary gets killed). I don't know whether tsdown re-signs when cross-building darwin targets on
Linux. The builder should check. If it doesn't, build the darwin binaries on a `macos-latest`
runner, where `codesign --sign -` is available, and keep the Linux ones on Ubuntu. Whether the
darwin binaries actually run is verified in the launchd design, on the owner's Mac.

## Release workflow

`publish.yml` today: on push to `main`, `select-mode` picks `version` or `publish`; in publish
mode, `pack` runs checks and tests and packs the tarball, then `publish` publishes to npm, pushes
`vX.Y.Z` and creates the GitHub Release.

Add a job (or a small matrix, if darwin needs a macOS runner) that:

- `needs: publish`, so it only runs after the npm publish and the release exist.
- Checks out the same commit, sets up Node 26, `npm ci`, builds the binaries.
- Gzips them, writes `SHA256SUMS`, and uploads everything to the `v<version>` release
  (`gh release upload`, with `--clobber` so a re-run of the job works). Version comes from
  `package.json` at that commit.
- Has `contents: write` only.

The workflow file name must stay `publish.yml` (the npm trusted publisher is tied to it).

There's a window between the release being created and the assets being uploaded. That's why
`update` checks for its asset rather than assuming it's there.

## Telling the binary apart from an npm install

Use `isSea()` from `node:sea`. It's `false` under plain Node.

`CliLocation` becomes a discriminated union on `kind`, built in `src/cli.ts`:

- `npm`: `selfPath` (the real path of `cli.js`) and `nodePath` (`process.execPath`), as now.
- `binary`: `binaryPath` (`process.execPath`, which inside the binary is the binary itself).

In the binary, don't call `realpathSync(fileURLToPath(import.meta.url))`; that path isn't a real
file.

## `init` with the systemd target, from the binary

What changes in `createSystemdTarget` when the location is `binary`:

1. Copy the binary to `~/.local/bin/telegram-ask` (create `~/.local/bin` if needed), replacing
   any existing file there. Copy to a temp file in the same directory, `chmod 755`, then rename, so
   a running service using the old copy isn't handed a half-written file. If the binary being run
   already is that path, skip the copy.
2. Write the unit with `ExecStart=<home>/.local/bin/telegram-ask start`. No node path.
   `formatSystemdUnit` takes the exec words in a way that covers both shapes; the builder decides
   how.
3. Never call npm. The `resolveCli` npm logic is only for the `npm` kind.
4. Everything else is as today: config file, `TELEGRAM_ASK_CONFIG` pinned in the unit,
   `daemon-reload`, `enable --now`, linger.
5. `install.json` records `cliPath: ~/.local/bin/telegram-ask` and a new optional field saying
   which kind of CLI the service runs (`npm` or `binary`). Old records without it are `npm` when
   the target is systemd. The field name is the builder's call.
6. If `~/.local/bin` isn't on `PATH`, print one line saying so, since `update`, `status` etc. are
   easiest to run from there. My call.

`~/.local/bin` is fixed, not derived from `XDG_*` (there's no XDG variable for it).

Re-running `init` from a newer binary is also a way to upgrade: it overwrites the copy and
replaces the install, same as re-running `init` does today.

Switching kinds works through the existing replace path: `init` from the binary over an
npm-based systemd install replaces it with the binary one, and the reverse works too. The npm
package left behind is not removed by the switch.

Collision with npm (my call): people who set `npm config set prefix ~/.local` have npm's
`telegram-ask` launcher symlink at `~/.local/bin/telegram-ask`. Renaming over it would break later
`npm i -g` runs (EEXIST) and leave a stale binary on `PATH`.

- `init` from the binary: if `~/.local/bin/telegram-ask` is a symlink, stop before touching
  anything and say to run `npm rm -g telegram-ask` first (or keep using the npm install).
- Switching from a binary install to npm (`init` from an npm CLI over a binary systemd install):
  delete the recorded binary copy before running `npm i -g`, but only if it's a regular file.

## `uninstall`

- Binary systemd install, purge answered yes: also delete `~/.local/bin/telegram-ask`. We put it
  there, so we clean it up. (npm installs keep printing the `npm rm -g` hint, as now.)
- Without purge, leave the copy in place.

## `update`

New command: `telegram-ask update`. No flags, no confirmation prompt (running it is the
confirmation). My call on both.

The rule the owner chose: the new version writes the files. The CLI that runs `update` only gets
the new version onto the machine, then hands off to it, and the new code writes the unit,
Dockerfile, compose file or plist from its own templates and restarts the service. That way a
release that changes a template, a base image or a unit line reaches existing installs.

So `update` has two steps:

1. **Get the new CLI.** Bring the CLI that will do the work to the latest version (per kind,
   below).
2. **Hand off.** Run the new CLI with a hidden subcommand (name is the builder's call, e.g.
   `update --finish`, hidden from help like `owner` is). It rewrites the install's files from its
   own templates, restarts the service, and writes its own `VERSION` to `install.json`.

If what step 1 would update already reports the latest version (`--version`), step 1 is skipped
and step 2 runs from it. This also covers `npx`: `npx telegram-ask@latest update` runs the latest
code directly.

What gets updated in step 1:

- **Binary systemd install.** The copy at the recorded `cliPath` (`~/.local/bin/telegram-ask`).
- **npm systemd install.** The npm global package the unit runs.
- **Quadlet and compose.** The CLI you ran `update` from, since that's whose templates the
  container files come from: the binary replaces itself (`process.execPath`), or an npm global
  install runs `npm i -g`. If it's neither (repo checkout, or an old `npx` version), it can't update
  itself; it says to run `npx telegram-ask@latest update` (or download the latest binary) and exits
  1.
- **Nothing installed.** Only step 1, for the CLI you ran, same rules as the container case. No
  handoff, since there are no files to rewrite.

Where the latest version comes from:

- Binary: the GitHub Releases API for `cozminu/telegram-ask`, latest release. Unauthenticated, so
  rate limited to 60 calls an hour per IP, which is plenty.
- npm: `https://registry.npmjs.org/telegram-ask/latest`, fetched directly, so checking doesn't need
  the npm CLI.

If the installed version (from `install.json`, or `VERSION` when nothing is installed) is already
the latest, print that and exit 0. Compare as semver; only move forward. Legacy installs record
`version: 'legacy'` and no `cliPath`: treat a non-semver version as older than anything, and for
the npm `--prefix` choice fall back to the systemd unit's `ExecStart` path.

Step 1 per kind:

- **Binary.** Download `telegram-ask-<platform>-<arch>.gz` and `SHA256SUMS` from the release,
  check the hash, gunzip to a temp file in the same directory as the binary being replaced,
  `chmod 755`. Run the temp file with `--version` and check it prints the expected version, so a
  binary that can't start never gets swapped in. Then rename it over the old one. If the asset or
  checksum entry is missing, the hash doesn't match, the version check fails, or any step fails
  before the rename, delete the temp file, leave the old binary in place and exit 1.
- **npm.** Run `npm i -g telegram-ask@<latest>`, adding `--prefix <userNpmPrefix>` when the
  recorded `cliPath` is under the fallback root (the same choice `remove` makes today). If npm
  fails, the old version stays (npm doesn't swap until the install succeeds) and nothing is
  restarted.

Step 2 per target, run by the new CLI:

- **systemd (either kind).** Rewrite the unit from the new template (same `ExecStart` shape as
  `init` writes), `daemon-reload`, restart. No copy and no npm: step 1 already did that.
- **Quadlet and compose.** Rebuild the image at the new CLI's `VERSION` and restart. This is what
  re-running `init` over an existing install does with the target's `install()`, minus the prompts:
  reuse the recorded port and provider, the saved secrets (`readSecrets`), the existing API token.
  My call: remove the old image after the new container is running, so updates don't pile up
  images. If the build fails, the old container keeps running.

  Things the existing code does that the finish step must not copy as is:
  - `init`'s replace path calls `old.remove()` before `install()` to free the port. `update` stays
    on the same target and port, so it builds the new image first and only switches over once the
    build succeeded.
  - Quadlet `install()` ends with `systemctl start`, which does nothing when the unit is already
    running. The container has to be restarted to move to the new image.
  - Compose doesn't tag its image by version (`build: .`). Capture the old image ID before the
    build to know what to remove. Quadlet's old image is `localhost/telegram-ask:<old version>`.

How the handoff runs: the old CLI spawns the new one (the binary path, or `<node> <cli.js>` for
npm) with inherited stdio and the same environment, waits, and exits with its exit code.

If step 2 fails after step 1 succeeded, the new CLI is in place but the service may still be on
the old files or stopped. Print what failed and say to run `telegram-ask update` again (which then
skips step 1 and retries step 2) or `telegram-ask init`. No automatic rollback; that's a non-goal.

When it's done, print the old and new version. Pending requests at restart time are handled by the
existing restart-safe state.

Output style and exit codes follow the other commands: 0 on success or already current, 1 on
failure with a one-line reason, 130 on interrupt.

## Platform detection for downloads

Asset name is built from `process.platform` and `process.arch`. Anything other than linux/darwin
and x64/arm64 gets a clear "no binary for <platform>-<arch>" error.

## README

- New install section for the binary: download with curl, gunzip, `chmod +x`, run `init`. Point at
  the Releases page.
- The systemd section gets a line on the binary variant (`~/.local/bin/telegram-ask`, no Node).
- "Node 24+ is needed for npx and the systemd target" becomes "for npx and the systemd target
  unless you use the binary".
- Document `update` under Commands.
- Releasing section: mention the binaries get attached by the same workflow.

`docs/standalone-executable.md` is superseded by this design. Leaving it to the owner whether to
delete it.

## Testing

Follow the repo's existing test setup (`vite-plus/test`, fake `exec`, temp dirs).

- systemd target with a `binary` location: copies the file (new inode, mode 755, no stray temp
  files), unit `ExecStart` is the copy with no node path, never calls npm, `install.json` records
  the kind.
- `uninstall` purge removes the copy; no purge keeps it.
- `update` per kind with fake `exec` and a local `node:http` server standing in for GitHub and the
  npm registry (port 0): already current, happy path, missing asset, bad checksum (old binary
  untouched, temp file gone), npm failure (no restart), image build failure (old image and unit
  kept).
- Version comparison.
- Build check for the binary (like `test/pack.test.ts` does for the npm build) only if it can run
  on the CI Node version; otherwise the release job building successfully is the check. Builder's
  call.

Manual, before calling it done: on a Linux box without Node on `PATH`, download a release binary,
run `init systemd`, pair, confirm the service survives a reboot, then `update` from an older
release to a newer one. The first real check of the release job is the first release after this
merges; the builder can test the job on a fork or with `workflow_dispatch` first.

## Left to the builder

- How the exe pack config is kept apart from the npm one.
- Exact shape of `CliLocation`, the `install.json` field name, and how `formatSystemdUnit` takes
  its exec words.
- Where `update` lives (`src/commands/update.ts` fits the existing layout) and how it shares the
  reinstall logic with `init`.
- Whether darwin needs a macOS runner (depends on tsdown's signing behavior).
