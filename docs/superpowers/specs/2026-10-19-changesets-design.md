# Changesets releases: design

Source: a brainstorming conversation with the owner on 2026-10-19. The owner will build it later.

Calls marked "My call" were made by me, not agreed with the owner. They're collected at the end too.

## Intent

Two problems, in the owner's words:

- "no changelog, users can't see what changed between versions"
- "I want easier releases (less commands to type)"

How releases work today: run `npm version <bump>` locally (its `version` script regenerates
`docs/openapi.yaml` and stages it), push the `vX.Y.Z` tag, and `.github/workflows/publish.yml`
publishes to npm with trusted publishing (OIDC, no token). There's no `CHANGELOG.md` and there are
no GitHub Releases.

## Goals

- A `CHANGELOG.md` users can read, with an entry per release.
- A GitHub Release per version with the same notes.
- Releasing takes one action: merging a PR. Day to day, the only thing typed is `npx changeset`
  when a change is worth telling users about.
- npm publishing keeps using trusted publishing (OIDC). No `NPM_TOKEN` secret.

## Non-goals

- Prereleases. The owner decided to drop the `next` dist-tag handling; every publish goes to
  `latest`. npm has never had a prerelease of this package (versions 0.1.1, 0.1.2, 0.2.0, 0.3.0, all
  `latest`). Changesets' pre mode can be added later if it's ever wanted.
- Changelog entries before 0.2.0.
- The changeset bot (GitHub App that comments on PRs missing a changeset). My call: left out, can
  be added later.
- A PR CI workflow. There isn't one today and this doesn't add one.

## Decided by the owner

- Use changesets (`@changesets/cli`) with the bot-PR flow: a GitHub Action keeps a release PR open,
  and merging it publishes.
- The owner will start squash-merging PRs into `main` (history so far is linear direct pushes).
- Drop the `next` prerelease tag.
- Backfill changelog entries for 0.2.0 and 0.3.0 only.

## How it works

### Day to day

1. Work on a branch, open a PR.
2. If the change matters to users, run `npx changeset` (or `npm run changeset`). Pick
   patch/minor/major, write a line or two. Commit the generated `.changeset/*.md` with the change.
3. Squash-merge the PR into `main`.

### Release

On every push to `main`, the release workflow runs `changesets/action`:

- **Pending changesets exist:** open or update the release PR. The PR bumps `package.json` (and
  `package-lock.json`), writes `CHANGELOG.md`, deletes the consumed `.changeset/*.md` files, and
  regenerates `docs/openapi.yaml`.
- **No pending changesets and the `package.json` version isn't on npm yet** (meaning the release
  PR was just merged): run `npm run check` and `npm test`, publish to npm on `latest` via OIDC,
  push the `vX.Y.Z` tag, and create the GitHub Release with that version's changelog section.
- **Neither:** do nothing.

The action runs its publish command on every push to `main` that has no pending changesets, so
the "isn't on npm yet" check has to be a gate the builder adds (e.g. a step that compares
`npm view telegram-ask@<version> version` to `package.json` and feeds the action's `publish`
input or an `if:`). Without it, check and test run on every ordinary push. My call.

### Why `docs/openapi.yaml` must be regenerated in the release PR

`src/server/openapi.ts` puts the package version into the spec, and
`test/server/openapi.test.ts` checks the committed `docs/openapi.yaml`. Today the npm `version`
lifecycle script handles it. `changeset version` doesn't run npm lifecycle scripts, so the
regeneration has to be part of the action's version command. Otherwise the test fails during
publish.

## Changes

### Dependencies and config

- Add `@changesets/cli` as a dev dependency.
- `npx changeset init`, then set `.changeset/config.json`: `baseBranch: "main"`,
  `access: "public"`, `commit: false`.
- Changelog format: the default `@changesets/cli/changelog` (one line per change plus a short
  commit link). My call: `@changesets/changelog-github` would add "Thanks @user!" to every line,
  which is noise on a solo project.

### npm scripts

My call on names:

- `"changeset": "changeset"`
- `"version-packages": "changeset version && npm install --package-lock-only && npm run openapi"`
  (the action's version command; `changeset version` doesn't touch `package-lock.json`)
- `"release": "npm run check && npm test && changeset publish"` (the action's publish command;
  `changeset publish` runs `npm publish`, which runs `prepack` and builds `dist`)
- Remove the old `"version"` script. Nothing runs `npm version` anymore, and leaving it would
  surprise anyone who does.

### Workflow

Rewrite `.github/workflows/publish.yml` in place. Keep the filename: npm's trusted publisher config
for this package is tied to it, and renaming the file breaks publishing until the npmjs.com setting
is updated.

- Trigger: `push` to `main`. Drop the tag trigger.
- Permissions: `contents: write` (tags, release commits, GitHub Releases), `pull-requests: write`
  (release PR), `id-token: write` (OIDC).
- `concurrency` on the workflow name so two pushes don't race.
- Keep the existing steps for Node 24, `registry-url`, the npm >= 11.5.1 check, and `npm ci`.
- Drop the tag/version match step and the `next` dist-tag logic.
- `changesets/action` with `version: npm run version-packages`, `publish: npm run release`,
  `createGithubReleases: true`. My call: set the PR `title` and `commit` to `chore: release` so
  the squash-merged commit matches the repo's conventional commit style.

### Backfill

Hand-write `CHANGELOG.md` entries for 0.3.0 and 0.2.0, in the same format changesets produces
(`## 0.3.0`, then `### Minor Changes` / `### Patch Changes`), so later generated entries stack on
top cleanly. Source the entries from the git log:

- 0.3.0: `git log v0.2.0..v0.3.0` (send request/notify CLI commands, exported `Client` for library
  use, OpenAPI spec for the HTTP API).
- 0.2.0: `git log v0.1.2..v0.2.0` (notifications with `POST /notify` and dismiss button, project
  name on `/request` and `/notify`, `telegram-ask mcp` with `ask_for_permission` and
  `notify_user`, choosing the chat provider at `init`, and the fixes in that range). Leave out
  internal refactors and doc commits unless they change something a user sees.

Write them for users: what they can now do, not which files moved. Don't create GitHub Releases
for these old versions (my call); the changelog is enough.

### Package contents

Add `CHANGELOG.md` to `files` in `package.json` so it ships in the npm tarball too (npm doesn't
include it automatically). My call.

### README

Add a short "Releasing" section at the end of the README covering when to add a changeset, that
merging the release PR is the release, and that nothing else needs to be run.

## The owner does by hand

- Turn on "Allow GitHub Actions to create and approve pull requests" in the repo settings
  (Settings, Actions, General, Workflow permissions). Done on 2026-10-19.

## Constraints

- Node >= 24.2, ESM, existing `vp check` / `vp test` toolchain. `npm run check` has to pass with
  the new `.changeset/` files and `CHANGELOG.md` present; if `vp check` formats or lints Markdown,
  make the files conform or exclude them.
- No `NPM_TOKEN` secret.

## Risk to verify while building

- I'm not sure `changesets/action` publishes cleanly through npm OIDC with no `NPM_TOKEN`. Some
  versions write an `.npmrc` with `NPM_TOKEN` when none exists. `setup-node` with `registry-url`
  already writes one, which should stop that, but this needs checking against the action's current
  source/docs. Fallback: use the action only for the release PR, and in a following step, when the
  action reports nothing was published but the version isn't on npm, run `npm run release` plus
  `git tag` / `git push --tags` / `gh release create` directly.
- PRs opened with `GITHUB_TOKEN` don't trigger other workflows. Nothing depends on that today, but
  if a PR CI workflow gets added later, the release PR won't get CI runs without a PAT or GitHub App
  token.

## Left to the builder

- Exact `changesets/action` version (pin a major tag or SHA).
- Wording of the changelog backfill and the README section.
- How to verify the workflow end to end (e.g. a throwaway patch changeset after merging).

## My calls, for the owner to check

- Default changelog format, not `@changesets/changelog-github`.
- Script names `changeset`, `version-packages`, `release`; old `version` script removed.
- Release PR title and commit `chore: release`.
- No changeset bot.
- No GitHub Releases for the backfilled 0.2.0 and 0.3.0.
- README gets a "Releasing" section.
- Publish gated on "version not on npm yet" so ordinary pushes don't run check/test/publish.
- `CHANGELOG.md` added to the npm package `files`.
