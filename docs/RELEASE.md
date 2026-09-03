# Release Process

This repository uses [Changesets](https://github.com/changesets/changesets) for versioning,
changelog generation, npm publishing, and GitHub Releases.

## For normal feature/fix PRs

1. If the published package changes, run:

   ```bash
   pnpm changeset
   ```

2. Choose bump level:
   `patch`: bug fixes, non-breaking internal improvements.
   `minor`: new features and, while the package remains pre-1.0, intentional
   breaking API or behavior changes with explicit migration notes.
   `major`: the 1.0 stability commitment and later breaking releases.
3. Commit the generated `.changeset/*.md` file in the same PR.
4. Do not edit package versions manually.

## What happens on `main`

1. CI passes.
2. Release workflow runs `changesets/action`.
3. If unreleased changesets exist, the action creates or updates a `Version Packages` PR.
4. For substantial releases, commit Highlights and Upgrade notes to the generated
   package changelog on the release PR branch and align the PR description with it.
5. Merge the `Version Packages` PR.
6. Workflow publishes to npm and creates GitHub Releases.
7. Verify the GitHub Release against the changelog and correct any drift.

The [release announcement guidelines](../AGENTS.md#release-announcements) describe
the editorial format and when it is useful. Editing only the PR description does
not update the changelog that ships in the package or supplies GitHub Release notes.

## Changesets 3 compatibility

The release tooling requires Node `^22.11 || ^24 || >=26` and pnpm 10 or higher.
The release workflow uses Node 24 and the pnpm version pinned in `package.json`.
The CLI and GitHub changelog formatter are ES modules; the existing named
formatter configuration and CLI-based workflow continue to work.

Changesets action v2 requires CLI v3. The workflow uses its `github-token`,
`publish-script`, and `create-github-releases` inputs. The action supplies
`GITHUB_TOKEN` to the formatter and `CHANGESETS_OUTPUT` to the publish command;
custom release scripts must preserve these environment variables so it can
create tags and GitHub Releases. The root `pnpm release` script does this.
Publishing now uses the workspace package manager; the pinned pnpm 10 delegates
to npm, and Node 24 supplies the npm version needed for trusted publishing.

- `changeset version` now exits with code 1 when no unreleased changesets exist.
  Check `pnpm changeset status` before the manual version step; do not treat an
  empty queue as a successful version operation. The automated action selects
  its version or publish path according to whether changesets are pending.
- Peer dependency updates now trigger a patch bump for dependent packages by
  default. Assess compatibility explicitly and add a changeset for any breaking
  change, using the pre-1.0 bump policy above rather than relying on propagation.
- The tag-only command is now `pnpm changeset git-tag`. Ordinary publishing still
  creates tags through `pnpm release`.

The formatter's default output is unchanged. Its experimental `template` option
formats individual change lines; release-wide Highlights and Upgrade notes still
belong in the generated changelog on the release PR. The config uses automatic
formatter detection, which selects this repository's installed Prettier.

See the upstream [CLI changelog](https://github.com/changesets/changesets/blob/main/packages/cli/CHANGELOG.md),
[action changelog](https://github.com/changesets/action/blob/main/CHANGELOG.md),
and [GitHub formatter changelog](https://github.com/changesets/changesets/blob/main/packages/changelog-github/CHANGELOG.md).

## Pre-release Verification

Code-changing PRs must pass the complete release surface before their
changesets reach `main`:

- formatting, lint, typechecking, and the SQLite/PGlite test suite;
- the PostgreSQL integration suite;
- every numbered SQLite and PostgreSQL example;
- the documentation build, rendered internal links and anchors, and TypeGraph
  imports extracted from current documentation code blocks;
- strict packed-consumer tests, API-report checks, and the API-surface
  compatibility check against the last published tag.

The generated Version Packages PR only changes release metadata, so CI skips
those heavy jobs after verifying that its changes are limited to changesets,
changelogs, and the package version. Any other package manifest or source
change runs the complete gate. After the Version Packages PR merges, the
release workflow still builds and smoke-imports the npm tarball before
publishing.

The corresponding local commands are:

```bash
pnpm fix && pnpm typecheck && pnpm test
pnpm test:postgres
pnpm test:examples
pnpm test:docs:release
pnpm --filter @nicia-ai/typegraph test:api-surface
```

Run `pnpm test:examples:postgres` with `POSTGRES_URL` set when validating the
PostgreSQL example outside CI.

## Release Notes Quality Checklist

For each changeset, include:

1. What changed.
2. Why users should care.
3. Breaking change details (if any).
4. Migration steps (if any).
5. Link to docs when relevant.

## Manual Maintainer Commands (Fallback)

Use only if automation is unavailable:

```bash
pnpm install
pnpm fix && pnpm typecheck && pnpm test
pnpm test:postgres
pnpm test:examples
pnpm test:docs:release
pnpm changeset status
pnpm version-packages
pnpm release
```
