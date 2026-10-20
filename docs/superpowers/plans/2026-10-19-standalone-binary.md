# Standalone Binary and `update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `telegram-ask` as a standalone binary on every GitHub Release, let `init` install it as a systemd user service without Node, and add `telegram-ask update` for binary, npm, quadlet and compose installs.

**Architecture:** A build script calls `vite-plus/pack`'s `build()` with `exe` options, separate from the npm build. `CliLocation` becomes a union on `kind` (`npm` | `binary`) so the systemd target can copy the binary to `~/.local/bin` and exec it directly. `update` runs in two steps: get the new CLI onto the machine (download + verify + swap, or `npm i -g`), then spawn that new CLI with a hidden `update --finish` that rewrites the install's files from its own templates via a new `Target.upgrade()` and restarts.

**Tech Stack:** TypeScript on Node 24 (repo), Node 26 embedded in the binary, commander, zod, `vite-plus/test`, `vite-plus/pack` (tsdown `exe`), GitHub Actions, `gh`.

**Spec:** `docs/superpowers/specs/2026-10-19-standalone-binary-design.md`

## Global Constraints

- Repo code style, not the global class-based style: plain exported functions, factories like `createSystemdTarget`, JSDoc on exports, tests in `test/<module>/*.test.ts` with `vite-plus/test` (`test`, `expect`, `vi`). Match the file you're in.
- Don't modify or commit `vite.config.ts` or `tsconfig.build.json`; they hold the owner's separate uncommitted work. Stage files explicitly (`git add <paths>`), never `git add -A`.
- `npm run build`, `npm test` and `npm run check` keep working on Node 24, and the npm tarball contents don't change.
- Binary build needs Node >= 25.7; embedded Node version is 26.
- Asset names: `telegram-ask-linux-x64.gz`, `telegram-ask-linux-arm64.gz`, `telegram-ask-darwin-x64.gz`, `telegram-ask-darwin-arm64.gz`, plus `SHA256SUMS` (sha256 of each `.gz`, `sha256sum` format).
- Binary copy path: `~/.local/bin/telegram-ask` (`$HOME/.local/bin`, never XDG-derived).
- Latest version sources: `https://api.github.com/repos/cozminu/telegram-ask/releases/latest` (binary), `https://registry.npmjs.org/telegram-ask/latest` (npm and containers).
- `update`: no flags except the hidden `--finish`, no prompt, latest only, forward only. Exit 0 on success or already current, 1 on failure with a one-line reason, 130 on interrupt.
- Workflow file stays `.github/workflows/publish.yml`.
- No em-dashes anywhere. Commit messages conventional and lowercase (`feat:`, `docs:`, `chore:`), no `Co-Authored-By` trailer.
- Run single test files with `node_modules/.bin/vp test <file>`; full suite `npm test`; lint/types `npm run check`.

## Review Focus

1. Release created but its assets not uploaded yet (or the GitHub API returns 403 for rate limiting): `update` prints a one-line reason, exits 1, and changes nothing. Test in Task 3 and Task 2.
2. `$HOME` with spaces or `$` in it: the binary `ExecStart` stays correctly quoted. Test in Task 4.
3. `~/.local/bin` doesn't exist yet on a fresh server: `init` creates it. Test in Task 4.
4. Ctrl-C during the download: temp file removed, old binary intact, exit 130. Test in Task 3 (abort signal) and Task 7 (exit code).
5. Container install with an older `npx` CLI: `update` says to run `npx telegram-ask@latest update` and exits 1 without touching the container. Test in Task 7.

---

### Task 1: Binary build script

**Files:**
- Create: `scripts/build-exe.ts`
- Modify: `package.json` (scripts, devDependencies), `.gitignore`

**Interfaces:**
- Produces: `npm run build:exe` writes the four binaries to `dist-exe/` (exact filenames are whatever tsdown emits per target; the release job in Task 8 renames them to the asset names).

- [ ] **Step 1: Find the `punycode` importer and add the userland package**

Known chain: `grammy -> node-fetch@2 -> whatwg-url@5 -> tr46@0.0.3`, which does `require('punycode')`. Run `npm i -D punycode` (devDependency only; it's bundled into the binary, not shipped in the npm package).

- [ ] **Step 2: Write `scripts/build-exe.ts`**

Calls `build()` from `vite-plus/pack` with `config: false` (so `vite.config.ts` isn't read) and: `entry: 'src/cli.ts'`, `outDir: 'dist-exe'`, `exe` with `targets` for linux/darwin x x64/arm64 at Node 26 (use the newest 26.x release), `deps: { alwaysBundle: [/.*/], onlyBundle: false }`, `minify: true`, and an alias `punycode` -> `punycode/` (the trailing slash resolves the userland package, not the built-in). Check `node_modules/vite-plus/dist/pack.d.ts` for the exact option names; the experiment's config in `docs/standalone-executable.md` is known to work.

- [ ] **Step 3: Add the npm script and ignore the output**

`package.json`: `"build:exe": "vp env exec --node 26 node scripts/build-exe.ts"`. `.gitignore`: add `dist-exe/`.

- [ ] **Step 4: Build and check the binary**

Run: `npm run build:exe`, then for the host's platform binary: `env -i ./dist-exe/<linux-x64 binary> --version 2>&1` and `--help`.
Expected: prints the `package.json` version, no `DEP0040` / `punycode` line, works with an empty environment (no Node on `PATH`).

- [ ] **Step 5: Confirm the npm build is unchanged**

Run: `npm run build && npm pack --dry-run 2>&1 | tail -20` and compare the file list against the same command on `HEAD` before this task.
Expected: identical file list.

If tsdown can't produce a validly signed darwin binary when cross-building (check with `codesign` later on the Mac; on Linux, note what tsdown logs), record that in the commit message; Task 8 then builds darwin on `macos-latest`.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-exe.ts package.json package-lock.json .gitignore
git commit -m "feat: build a standalone binary with vp pack exe"
```

---

### Task 2: Release lookups and version comparison

**Files:**
- Create: `src/update/constants.ts`, `src/update/types.ts`, `src/update/version.ts`, `src/update/release.ts`, `src/update/index.ts`
- Test: `test/update/version.test.ts`, `test/update/release.test.ts`

**Interfaces:**
- Produces (exported from `src/update/index.ts`):
  - `type LatestRelease = { readonly version: string; readonly assets: Readonly<Record<string, string>> }` (asset name -> download URL; version without the leading `v`)
  - `compareVersions(left: string, right: string): number` (negative, 0, positive; a non-`X.Y.Z` string is older than any `X.Y.Z`; two non-semver strings compare 0)
  - `formatAssetName(platform: string, arch: string): string | undefined`
  - `fetchLatestRelease(url: string, signal?: AbortSignal): Promise<LatestRelease>`
  - `fetchLatestNpmVersion(url: string, signal?: AbortSignal): Promise<string>`
  - `parseChecksums(text: string): ReadonlyMap<string, string>` (file name -> lowercase hex)
  - constants `RELEASES_API_URL`, `NPM_LATEST_URL`, `CHECKSUMS_ASSET = 'SHA256SUMS'`, `FETCH_TIMEOUT_MS = 30_000`, `DOWNLOAD_TIMEOUT_MS = 600_000`

- [ ] **Step 1: Write the failing tests**

```ts
// version.test.ts
test('compares release versions numerically', () => {
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0)
})
test('treats a legacy version as older than any release', () => {
  expect(compareVersions('legacy', '0.0.1')).toBeLessThan(0)
  expect(compareVersions('0.0.1', 'legacy')).toBeGreaterThan(0)
})
test('names assets for supported platforms only', () => {
  expect(formatAssetName('linux', 'x64')).toBe('telegram-ask-linux-x64.gz')
  expect(formatAssetName('darwin', 'arm64')).toBe('telegram-ask-darwin-arm64.gz')
  expect(formatAssetName('win32', 'x64')).toBeUndefined()
  expect(formatAssetName('linux', 'ia32')).toBeUndefined()
})
test('parses sha256sum output', () => {
  expect(parseChecksums(`${'a'.repeat(64)}  telegram-ask-linux-x64.gz\n`)).toEqual(
    new Map([['telegram-ask-linux-x64.gz', 'a'.repeat(64)]]),
  )
})
```

`release.test.ts` uses a `node:http` server on port 0:
- `fetchLatestRelease` maps `{ tag_name: 'v0.5.0', assets: [{ name, browser_download_url }] }` to `{ version: '0.5.0', assets: { [name]: url } }`.
- Rejects with a message containing `403` when the server answers 403 (rate limit).
- Rejects on a body without `tag_name`.
- `fetchLatestNpmVersion` returns `'0.5.0'` from `{ version: '0.5.0' }`; rejects on 404.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vp test test/update`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Global `fetch` with `AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])` when a signal is given. Validate response bodies with zod (repo already uses it). Error messages: `GitHub release lookup failed: HTTP 403`, `npm lookup failed: HTTP 404`.

- [ ] **Step 4: Run the tests**

Run: `node_modules/.bin/vp test test/update`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/update test/update
git commit -m "feat: look up the latest release on github and npm"
```

---

### Task 3: Download, verify and swap a binary

**Files:**
- Create: `src/update/binary.ts`; export from `src/update/index.ts`
- Test: `test/update/binary.test.ts`

**Interfaces:**
- Consumes: `LatestRelease`, `parseChecksums`, `CHECKSUMS_ASSET`, `DOWNLOAD_TIMEOUT_MS` (Task 2); `Exec` from `src/system/index.ts`.
- Produces: `replaceBinary(options: ReplaceBinaryOptions): Promise<void>` with
  `type ReplaceBinaryOptions = { readonly release: LatestRelease; readonly assetName: string; readonly destination: string; readonly exec: Exec; readonly signal?: AbortSignal }`. Throws on any failure; on throw the destination is untouched and no temp file remains.

Order: fetch `SHA256SUMS` and the asset, hash the gzipped bytes, compare, gunzip (`node:zlib`) to `${destination}.${process.pid}.tmp` in the destination's directory, `chmod 755`, run `exec(temp, ['--version'])` and require trimmed stdout to equal `release.version`, then `rename` over `destination`. Remove the temp file in a `finally`-style cleanup on failure.

- [ ] **Step 1: Write the failing tests**

Serve fixtures from a `node:http` server on port 0; the "binary" is any bytes, gzipped. Fake `exec` returns `{ code: 0, stdout: '0.5.0\n', stderr: '' }` unless a test overrides it.

- `replaces the destination with the verified binary`: destination content equals the un-gzipped bytes, mode `& 0o777` is `0o755`, inode differs from before, directory holds no `*.tmp`.
- `refuses a missing asset`: asset absent from `release.assets` -> rejects with `no telegram-ask-linux-x64.gz on release 0.5.0 yet`; destination unchanged.
- `refuses a missing checksum entry`: rejects; destination unchanged.
- `refuses a checksum mismatch`: rejects with a message containing `checksum`; destination unchanged, no `*.tmp`.
- `refuses a binary that reports another version`: fake `exec` prints `0.4.0` -> rejects; destination unchanged, no `*.tmp`.
- `stops when aborted`: abort the signal before the server responds -> rejects; destination unchanged, no `*.tmp`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vp test test/update/binary.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `replaceBinary` in `src/update/binary.ts`**

- [ ] **Step 4: Run the tests**

Run: `node_modules/.bin/vp test test/update/binary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/update test/update
git commit -m "feat: download, verify and swap in a new binary"
```

---

### Task 4: systemd target runs the binary

**Files:**
- Modify: `src/install/types.ts` (`CliLocation`, `InstallPaths`), `src/install/schema.ts`, `src/install/paths.ts`, `src/install/templates.ts` (`formatSystemdUnit`), `src/install/systemd.ts`, `src/cli.ts:136-145`
- Test: `test/install/systemd.test.ts`, `test/install/templates.test.ts`, `test/install/state.test.ts`

**Interfaces:**
- Produces:
  - `type CliLocation = { readonly kind: 'npm'; readonly selfPath: string; readonly nodePath: string } | { readonly kind: 'binary'; readonly binaryPath: string }`
  - `InstallPaths.binaryCopy: string` = `join(home, '.local', 'bin', 'telegram-ask')`
  - `installRecordSchema` gains `cliKind: z.enum(['npm', 'binary']).optional()`; absent means `npm`.
  - `formatSystemdUnit(options: { readonly exec: readonly string[]; readonly config: string }): string` writes `ExecStart=<quoted words> start`. Callers pass `[node, cliPath]` or `[binaryPath]`.
  - `resolveCliLocation(): CliLocation` in `src/cli.ts` (not exported from the package): `isSea()` from `node:sea` ? `{ kind: 'binary', binaryPath: process.execPath }` : the current npm shape. Never calls `realpathSync(fileURLToPath(import.meta.url))` in the binary.

- [ ] **Step 1: Write the failing tests**

In `systemd.test.ts`, add a `makeBinary(env?)` helper next to `make()` that passes `{ kind: 'binary', binaryPath: <tmp>/dl/telegram-ask }` (write a small file there first). Update `make()` to pass `kind: 'npm'`.

- `binary install copies itself to ~/.local/bin and runs it directly`: `~/.local/bin` didn't exist before; after install the copy exists with mode `0o755` and the source's content; unit contains `ExecStart="<tmp>/.local/bin/telegram-ask" start` and no node path; `calls` has no `npm` entry; record matches `{ target: 'systemd', cliKind: 'binary', cliPath: <copy> }`; no `*.tmp` left in `~/.local/bin`.
- `binary install over an existing copy replaces it with a new inode`.
- `binary install from the copy itself skips the copy` (`binaryPath === paths.binaryCopy`): file inode unchanged.
- `binary unit stays quoted with spaces and $ in HOME`: `HOME` = `<tmp>/my $home`; `ExecStart` has the path quoted and `$` doubled.
- `binary install prints a PATH hint when ~/.local/bin isn't on PATH`; no hint when it is.
- npm installs still record `cliKind: 'npm'`.

In `templates.test.ts`, update the two existing `formatSystemdUnit` tests to the `exec` array form (same expected output), and add one for a single-word `exec`.

In `state.test.ts`, a record with `cliKind: 'binary'` round-trips; one without `cliKind` still parses.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vp test test/install`
Expected: FAIL.

- [ ] **Step 3: Implement**

Binary path in `createSystemdTarget.install`: copy with `copyFileSync` to `${binaryCopy}.${process.pid}.tmp`, `chmodSync(0o755)`, `renameSync`; `mkdirSync(dirname, { recursive: true })` first; clean up the temp on failure. `resolveCli` (npm) only runs for `kind: 'npm'`. PATH hint text: `~/.local/bin isn't on your PATH; add it to run telegram-ask from anywhere.` Wire `resolveCliLocation()` into `createRealTargets` in `src/cli.ts`.

- [ ] **Step 4: Run the tests, check and build**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install src/cli.ts test/install
git commit -m "feat: install the standalone binary as a systemd service"
```

---

### Task 5: Uninstall purge and the npm collision rules

**Files:**
- Modify: `src/install/systemd.ts` (`available`, `install` npm path, `remove`)
- Test: `test/install/systemd.test.ts`

**Interfaces:**
- Consumes: `CliLocation`, `InstallPaths.binaryCopy`, `cliKind` (Task 4).

- [ ] **Step 1: Write the failing tests**

- `purge removes the binary copy`: record `{ target: 'systemd', cliKind: 'binary', cliPath: <copy>, ... }`, `remove(record, true)` -> copy gone; no `npm rm -g` hint printed.
- `remove without purge keeps the binary copy`.
- `binary target is unavailable when ~/.local/bin/telegram-ask is a symlink`: `symlinkSync` something there; `available()` with a binary location resolves `{ ok: false, reason: '~/.local/bin/telegram-ask is a symlink (npm\'s launcher?); run "npm rm -g telegram-ask" first' }` (systemctl fake still succeeds).
- `npm install deletes a leftover binary copy before npm i -g`: regular file at `binaryCopy`; after install it's gone, and the removal happened before the `npm i` call (check file absence inside the fake exec when it sees `npm i`).
- `npm install leaves a symlink at ~/.local/bin/telegram-ask alone`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vp test test/install/systemd.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** using `lstatSync` (`isSymbolicLink()`, `isFile()`); ENOENT means nothing there (`isMissingFileError`).

- [ ] **Step 4: Run the tests**

Run: `node_modules/.bin/vp test test/install/systemd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/systemd.ts test/install/systemd.test.ts
git commit -m "feat: clean up the binary copy on purge and avoid clobbering npm's launcher"
```

---

### Task 6: `Target.upgrade` for all three targets

**Files:**
- Modify: `src/install/types.ts` (`Target`), `src/install/systemd.ts`, `src/install/quadlet.ts`, `src/install/compose.ts`, `src/install/index.ts`
- Test: `test/install/systemd.test.ts`, `test/install/quadlet.test.ts`, `test/install/compose.test.ts`, `test/commands/manage.test.ts` (add `upgrade: vi.fn()` to `fake()`), `test/commands/init.test.ts` (same, if it has a fake target)

**Interfaces:**
- Produces:
  - `Target.upgrade: (options: InstallOptions, previous: InstallRecord) => Promise<InstallRecord>`: rewrites the target's files from the current templates at `options.version`, switches the running service over, and returns the new record. Never calls `remove()`. On a build failure it throws and the old service keeps running.
  - `findUnitExecWords(unit: string): readonly string[] | undefined` in `src/install/systemd.ts`, exported: the unquoted words of `ExecStart=` minus the trailing `start` (used by Task 7 for legacy installs and for the npm unit's node path).

Per target:
- systemd: `install(options)` then `systemctl --user restart telegram-ask` (`enable --now` doesn't restart a running unit). Runs inside the new CLI, so the binary copy step skips itself and the npm `resolveCli` finds itself under the npm root.
- quadlet: `install(options)` (build happens before the unit is rewritten), then `systemctl --user restart telegram-ask`, then `podman rmi localhost/telegram-ask:<previous.version>` when it differs from the new tag (failure to remove is printed, not thrown).
- compose: read the old image ID first (`docker compose -f <file> images -q bot`), `install(options)` (`up -d --build` recreates the container when the image changed), then `docker image rm <old id>` when it differs from the new one (failure printed, not thrown).

- [ ] **Step 1: Write the failing tests**

- systemd: `upgrade rewrites the unit and restarts`: `calls` contains `daemon-reload` and then `restart telegram-ask` after the unit write.
- quadlet: `upgrade builds the new tag, restarts, then removes the old image`: order of `podman build -t localhost/telegram-ask:0.5.0`, `systemctl restart`, `podman rmi localhost/telegram-ask:0.4.0`.
- quadlet: `upgrade leaves the old unit when the build fails`: build returns code 1 -> rejects; `.container` file content unchanged; no `rmi`.
- compose: `upgrade removes the previous image`: fake returns `old123` for `images -q` before and `new456` after -> `docker image rm old123`.
- `findUnitExecWords` returns `['/usr/bin/node', '/x/cli.js']` for `ExecStart="/usr/bin/node" "/x/cli.js" start` and `['/h/.local/bin/telegram-ask']` for the binary form; `undefined` without an `ExecStart` line.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vp test test/install`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the full suite** (fake targets in command tests need the new member)

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install test/install test/commands
git commit -m "feat: add Target.upgrade for in-place upgrades"
```

---

### Task 7: The `update` command

**Files:**
- Create: `src/commands/update.ts`
- Modify: `src/commands/types.ts`, `src/commands/index.ts`, `src/cli.ts` (new `update` command)
- Test: `test/commands/update.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3 (`fetchLatestRelease`, `fetchLatestNpmVersion`, `compareVersions`, `formatAssetName`, `replaceBinary`), Task 4 (`CliLocation`, `cliKind`), Task 6 (`Target.upgrade`, `findUnitExecWords`), existing `findExistingInstall`, `writeInstall`, `readTokenFile`/`parseToken`, `readSecrets`, `requireProvider`.
- Produces:
  - `type UpdateDeps = { readonly targets: Readonly<Record<TargetName, Target>>; readonly paths: InstallPaths; readonly providers: readonly Provider[]; readonly exec: Exec; readonly cli: CliLocation; readonly version: string; readonly platform: string; readonly arch: string; readonly releasesUrl: string; readonly npmLatestUrl: string; readonly print: (text: string) => void; readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv; readonly timeZone?: string }`
  - `runUpdate(deps: UpdateDeps): Promise<number>`
  - `runFinishUpdate(deps: UpdateDeps): Promise<number>`
  - CLI: `update` with a hidden `--finish` option (`new Option('--finish').hideHelp()`), wired like `uninstall` (with `runWithSignals`).

`runUpdate` flow:
1. `existing = findExistingInstall(...)`. Decide the step-1 subject:
   - systemd + `cliKind: 'binary'`: the file at `record.cliPath`; latest from GitHub.
   - systemd + npm (or absent `cliKind`, incl. legacy): the npm package; `cliPath` from the record, else from `findUnitExecWords` on the unit; node from the unit's first word; latest from npm.
   - quadlet/compose, or nothing installed: the running CLI (`deps.cli`): binary -> `binaryPath`, GitHub; npm -> only if `selfPath` is under `npm root -g` or the `userNpmPrefix` fallback root, npm registry; otherwise not updatable.
2. Current version = `record.version` if installed, else `deps.version`. If `compareVersions(current, latest) >= 0`: print `Already on <current>.`, return 0.
3. Step 1, skipped when the subject already reports `latest` (`exec(path, ['--version'])`, or for npm `exec(node, [cliPath, '--version'])`; for the running CLI, `deps.version`):
   - binary: `replaceBinary` (unsupported platform -> `no binary for <platform>-<arch>`).
   - npm: `npm i -g telegram-ask@<latest>` plus `--prefix <userNpmPrefix>` when `cliPath` is under the fallback root.
   - running CLI not updatable: print `Can't update this copy; run "npx telegram-ask@latest update" or download the latest binary.`, return 1.
4. Nothing installed: print `Updated telegram-ask <old> -> <latest>.`, return 0.
5. Hand off: `exec(<new cli words>, ['update', '--finish'], { inherit: true })` where the words are `[binaryPath]` or `[node, cliPath]`. Return its exit code. If step 1 was skipped because the running CLI is already latest (e.g. `npx telegram-ask@latest`), call `runFinishUpdate(deps)` in-process instead.
6. Any thrown error: print `Update failed: <message>`, return 1; if the handoff exits non-zero after step 1 succeeded, also print `The new version is in place; run "telegram-ask update" again or "telegram-ask init".` Aborted signal -> return 130.

`runFinishUpdate` flow: read the existing install (none -> `Not installed.`, return 1). Build `InstallOptions` from `record.port`, `requireProvider(providers, resolveRecordProvider(record))`, `(await target.readSecrets(record)).settings`, auth from the token file (valid token -> `{ kind: 'token', token }`, else `NO_AUTH`), `deps.timeZone`, `version: deps.version`. Call `target.upgrade(options, record)`, `writeInstall(paths.installFile, newRecord)`, print `Updated telegram-ask <old> -> <new>.`, return 0.

- [ ] **Step 1: Write the failing tests**

Fake targets as in `manage.test.ts`; fake `exec` records calls; a `node:http` server on port 0 serves the GitHub JSON, npm JSON, `SHA256SUMS` and a gzipped fake binary. Each test asserts the exit code and the printed lines.

- `already current exits 0 without touching anything` (record version equals latest; prints `Already on 0.5.0.`; no `npm`, no handoff, no `upgrade`).
- `binary systemd install swaps the copy then hands off to it`: copy replaced; last `exec` call is `[<copy>, ['update', '--finish'], { inherit: true }]`.
- `npm systemd install runs npm i -g then hands off with the unit's node`: calls include `['npm', ['i', '-g', 'telegram-ask@0.5.0']]`, then `[<node from unit>, [<cliPath>, 'update', '--finish'], ...]`.
- `npm install under the fallback prefix passes --prefix`.
- `legacy install takes cliPath and node from the unit`.
- `npm failure exits 1 without handing off`.
- `missing asset exits 1 and leaves the copy` (Review Focus 1).
- `container install with an old npx CLI asks for npx telegram-ask@latest` (Review Focus 5): `cli` is npm with `selfPath` outside both npm roots, `version: '0.4.0'`, latest `0.5.0` -> exit 1, message matches, `upgrade` not called.
- `container install already on the latest CLI finishes in-process`: `version: '0.5.0'`, record version `0.4.0` -> `upgrade` called with `version: '0.5.0'`, install.json version `0.5.0`.
- `nothing installed updates the running binary only`: no handoff.
- `failed handoff prints the retry hint`: handoff exec returns code 1.
- `interrupt during download exits 130` (Review Focus 4): abort the signal while the server holds the asset response.
- `runFinishUpdate upgrades with the saved secrets and token`: `upgrade` receives `port`, provider, settings from `readSecrets`, `auth.kind === 'token'` when a token file exists; install.json rewritten with the returned record.
- `runFinishUpdate with nothing installed exits 1`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vp test test/commands/update.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runUpdate` and `runFinishUpdate` in `src/commands/update.ts`, then wire `update` into `src/cli.ts`** (real deps: `realExec`, `resolveCliLocation()`, `VERSION`, `process.platform`, `process.arch`, `RELEASES_API_URL`, `NPM_LATEST_URL`, time zone as `runInitCommand` computes it).

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run check`
Expected: PASS.

- [ ] **Step 5: Smoke test against the real CLI**

Run: `node src/cli.ts update --help` and `node src/cli.ts --help`
Expected: `update` listed in help; `--finish` not shown.

- [ ] **Step 6: Commit**

```bash
git add src/commands src/cli.ts test/commands
git commit -m "feat: add update command for binary, npm and container installs"
```

---

### Task 8: Attach binaries to the GitHub Release

**Files:**
- Modify: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: `npm run build:exe` and its `dist-exe/` output (Task 1).

- [ ] **Step 1: Add a `binaries` job**

`needs: publish`, `runs-on: ubuntu-latest`, `permissions: contents: write`. Steps: `actions/checkout@v5` (`persist-credentials: false`), `actions/setup-node@v5` with `node-version: 26`, `npm ci`, `npm run build:exe`, then a shell step that copies each target's binary to `telegram-ask-<platform>-<arch>`, `gzip -9` each, runs `sha256sum telegram-ask-*.gz > SHA256SUMS`, reads `version` from `package.json`, and runs `gh release upload "v$version" telegram-ask-*.gz SHA256SUMS --clobber` with `GH_TOKEN: ${{ github.token }}`. If Task 1 found darwin signing doesn't work when cross-building, split into a matrix: linux on `ubuntu-latest`, darwin on `macos-latest` with `codesign --sign - --force` before gzip, and a final job that downloads both sets, writes one `SHA256SUMS` and uploads.

- [ ] **Step 2: Validate the workflow file**

Run: `npx --yes @action-validator/cli .github/workflows/publish.yml` (or `actionlint` if installed).
Expected: no errors.

- [ ] **Step 3: Dry-run the build steps locally**

Run the job's shell step by hand after `npm run build:exe`, skipping `gh release upload`.
Expected: four `.gz` files and a `SHA256SUMS` with four lines that `sha256sum -c SHA256SUMS` accepts.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml
git commit -m "chore: attach standalone binaries to github releases"
```

The first real run is the next release after merge. Say so in the PR description; it isn't verified before then.

---

### Task 9: README and changeset

**Files:**
- Modify: `README.md` (Quick start or Install options, "systemd (npm)" section, Node requirement line, Commands list, Releasing)
- Create: `.changeset/standalone-binary.md`

- [ ] **Step 1: Write the docs**

- New "Standalone binary" subsection under Install options: `curl -L https://github.com/cozminu/telegram-ask/releases/latest/download/telegram-ask-linux-x64.gz | gunzip > telegram-ask && chmod +x telegram-ask && ./telegram-ask init systemd`, note it copies itself to `~/.local/bin/telegram-ask` and needs no Node; macOS binaries exist but there's no macOS service target yet.
- "systemd (npm)" section: one line on the binary variant (unit runs `~/.local/bin/telegram-ask start`; purge deletes it).
- Node requirement line: "Node 24+ is needed for `npx` and the systemd target unless you use the standalone binary".
- Commands: `update`: what it does per install kind, in two or three sentences.
- Releasing: the workflow also builds the binaries and attaches them with `SHA256SUMS`.

- [ ] **Step 2: Add the changeset**

```md
---
'telegram-ask': minor
---

Standalone binaries for Linux and macOS on each GitHub Release; `init` can install the binary as a systemd service without Node. New `update` command for binary, npm, Quadlet and Compose installs.
```

- [ ] **Step 3: Check formatting**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md .changeset/standalone-binary.md
git commit -m "docs: document the standalone binary and update command"
```

---

### Task 10: Manual end-to-end check

Not code; done by a person on a Linux box (a VM is fine), after Tasks 1-9.

- [ ] Build with `npm run build:exe`, copy the linux-x64 binary to a machine or container without Node on `PATH`.
- [ ] `./telegram-ask init systemd`, pair, `telegram-ask status` from `~/.local/bin`, reboot, check it's running again.
- [ ] Simulate `update`: serve two builds (version bumped in `package.json` for the second) from a local HTTP server, point `update` at it by temporarily overriding the URLs (or wait for the first two real releases), and confirm the copy is swapped, the service restarted, and `install.json` shows the new version.
- [ ] `uninstall` with purge removes `~/.local/bin/telegram-ask`.

Record results in the PR description, including anything not tried.
