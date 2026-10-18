# Style rule small items (gap 7)

Spec: none written. Source of requirements is the user's TS style rule (`~/.claude/rules/ts-coding-style.md`) sections "Control flow", "Files and I/O", "Errors", "Comments", plus the gap-7 list agreed in chat.

## Global Constraints

- Work on branch `main` in place. No new branches or worktrees.
- Keep behavior the same except where a task says otherwise. All existing tests must keep passing.
- Verify with all four: `npx tsc -p tsconfig.json`, `npx vp check`, `npx vp test`, `npm run build && node dist/cli.js --version` (prints `0.1.0`).
- Format with `npx vp fmt` before committing (no semicolons, single quotes, width 100).
- Cross-module imports go through `../<module>/index.ts`. Tests import from `src/<module>/index.ts` only.
- Tests use `vite-plus/test` (`test`, `expect`, `vi`), flat `test(...)` calls, real temp dirs via `mkdtempSync`.
- Never use em-dashes anywhere (code, comments, commit messages).
- Commits: conventional, lowercase summary (`refactor: ...`, `test: ...`, `chore: ...`). No `Co-Authored-By` trailer, no Claude attribution.
- Keep `src/cli.ts` at the src root; `dist/cli.js` stays the bin path.

## Task 1: atomic file writes

Add an atomic write helper to the `system` module and use it for the three files that hold state or secrets.

- New file `src/system/files.ts` exporting:
  ```ts
  /** Writes `contents` to `path` via a temp file, fsync and rename, so readers never see a partial file. Creates the parent directory. On failure removes the temp file (best effort) and rethrows; an existing file is left as it was. */
  export function writeFileAtomic(path: string, contents: string, mode: number): void
  ```
  Temp path is exactly `${path}.${process.pid}.tmp`. Open the temp with `openSync(temp, 'w', mode)`, write, `fchmodSync(fd, mode)` (umask can strip bits at create), `fsyncSync(fd)`, close in `finally`, then `renameSync(temp, path)`. Cleanup of the temp on failure uses `rmSync(temp, { force: true })` inside its own `try`; a bare `catch {}` there needs a why-comment.
- Re-export `writeFileAtomic` from `src/system/index.ts`.
- Add `SECRET_FILE_MODE = 0o600` to `src/config/constants.ts` and to `src/install/constants.ts`.
- Use `writeFileAtomic(path, text, SECRET_FILE_MODE)` in place of mkdir + writeFileSync + chmodSync in:
  - `src/config/store.ts` `updateConfigFile`, with text `` `${JSON.stringify(next, null, 2)}\n` ``
  - `src/install/state.ts` `writeInstall`, with text `` `${JSON.stringify(record, null, 2)}\n` ``
  - `src/install/envfile.ts` `writeEnvFile`
  Drop imports that become unused.
- New test file `test/system/files.test.ts` with these tests:
  1. `writeFileAtomic creates parent directories and writes the content with the given mode` (mode checked as `statSync(path).mode & 0o777` equals `0o600`).
  2. `replacing a file gives it a new inode and leaves no temp file behind` (compare `statSync(path).ino` before and after; `readdirSync(dir)` contains only the target name).
  3. `a failed rename throws, keeps the old target and removes the temp file` (make `path` an existing directory containing a marker file; expect the call to throw; the directory and marker still exist; no `*.tmp` entry in the parent directory).
- Out of scope: unit files, Dockerfile, compose.yaml, .dockerignore writes in the install targets stay `writeFileSync` (they're regenerated on every install).

## Task 2: missing file as ENOENT instead of existsSync

- Add to `src/system/files.ts` and re-export from `src/system/index.ts`:
  ```ts
  /** True when `error` is a Node error with code `ENOENT`. */
  export function isMissingFileError(error: unknown): boolean
  ```
- `src/config/store.ts` `readConfigFile`: drop `existsSync`. Read the file in its own `try`: on `isMissingFileError` return `{}`, otherwise rethrow the original error. Parse JSON in a separate `try` that keeps the existing invalid-JSON message (and its comment about not leaking the parser message).
- `src/install/envfile.ts`: drop `existsSync`. `readEnvFile` returns `{}` on a missing file and rethrows other read errors. `removeEnvKey` returns without writing on a missing file and rethrows other read errors.
- Behavior change (intended): a config path that exists but can't be read (for example a directory, EISDIR, or EACCES) now rethrows the read error instead of reporting "contains invalid JSON".
- Tests to add:
  - `test/config/store.test.ts`: `readConfigFile rethrows read errors other than a missing file` (pass a directory path, expect `/EISDIR/`).
  - `test/install/envfile.test.ts`: `removeEnvKey on a missing file writes nothing` (file still absent afterwards) if no such test exists, and `readEnvFile rethrows read errors other than a missing file` (directory path, `/EISDIR/`).
  - `test/system/files.test.ts`: `isMissingFileError is true only for ENOENT` (true for the error from reading a missing path, false for EISDIR error, a plain `Error`, and a string).
- Leave the catch-alls in `src/install/state.ts` `readInstall` and `src/install/registry.ts` `findExistingInstall` as they are.

## Task 3: lowercase error messages

Thrown error messages and stderr diagnostics start lowercase. Quote user-supplied text with `JSON.stringify`; context first, cause after a colon. Exact new strings:

| File | Old | New |
| --- | --- | --- |
| `src/config/store.ts` | `` `Config file ${path} contains invalid JSON; ${INIT_HINT}` `` | `` `config file ${JSON.stringify(path)} contains invalid JSON; ${INIT_HINT}` `` |
| `src/config/store.ts` | `` `Config file ${path} has invalid or missing fields; ${INIT_HINT}` `` | `` `config file ${JSON.stringify(path)} has invalid or missing fields; ${INIT_HINT}` `` |
| `src/config/store.ts` | `` `Missing bot token; ${INIT_HINT} (or set BOT_TOKEN)` `` | `` `missing bot token; ${INIT_HINT} (or set BOT_TOKEN)` `` |
| `src/config/store.ts` | `` `Invalid owner id; ${INIT_HINT} (or set OWNER_ID)` `` | `` `invalid owner id; ${INIT_HINT} (or set OWNER_ID)` `` |
| `src/config/store.ts` | `` `Invalid port ${String(rawPort)}; must be an integer 1-65535` `` | `` `invalid port ${JSON.stringify(String(rawPort))}: must be an integer 1-65535` `` |
| `src/install/compose.ts`, `src/install/quadlet.ts` | `` `Couldn't clear the owner in the container: ${...}` `` | `` `couldn't clear the owner in the container: ${...}` `` |
| `src/install/quadlet.ts` | `` `Purge incomplete; ${failures.join('; ')}` `` | `` `purge incomplete: ${failures.join('; ')}` `` |
| `src/system/exec.ts` | `` `Command not found: ${command}` `` | `` `command ${JSON.stringify(command)} not found` `` |
| `src/commands/test.ts` | `` `Could not reach the service on port ${port} (...)` `` | same text starting `could not reach` |

- Stdout prose printed to the user during `init`, `status`, `reset-owner`, `uninstall` (sentences like "Install failed: ...", "Cannot use ...", "Not installed.") stays sentence case. `Usage: owner get|clear` stays.
- Update any test that asserts on a changed string. Don't add new tests for this task.

## Task 4: braces everywhere, no blank lines inside functions

- In `vite.config.ts` add an oxlint config enabling `curly` (all) as an error: `lint: { rules: { curly: 'error' } }` beside the existing `fmt` block.
- Fix every `curly` violation in `src/` and `test/` (try `npx oxlint --fix` or `npx vp lint --fix` first, then fix the rest by hand).
- Remove blank lines inside function and method bodies in `src/` only (blank lines between top-level declarations and between class members stay). Don't touch `test/` blank lines.
- No other changes. `npx vp check` must pass with the new rule.

## Task 5: JSDoc on exports

- Every exported declaration in `src/` outside `index.ts` files gets a `/** */` comment: functions, classes, types, constants. One line where possible; state the contract and the reason, guarantees first. Don't restate the name ("Formats the X" on `formatX` adds nothing; say what it guarantees or why it exists).
- Keep existing JSDoc that already says something useful; adjust only if it's wrong.
- Fields of exported types get a comment only when the meaning isn't obvious from the name and type (units, who sets it, when it's absent).
- `src/cli.ts` `main`: one line describing argv in, exit code out.
- No code changes.
