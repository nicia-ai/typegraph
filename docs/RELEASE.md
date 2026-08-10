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
   `minor`: new backward-compatible features.
   `major`: breaking API/behavior changes.
3. Commit the generated `.changeset/*.md` file in the same PR.
4. Do not edit package versions manually.

## What happens on `main`

1. CI passes.
2. Release workflow runs `changesets/action`.
3. If unreleased changesets exist, the action creates or updates a `Version Packages` PR.
4. Review and edit generated changelog wording in that PR for clarity.
5. Merge the `Version Packages` PR.
6. Workflow publishes to npm and creates GitHub Releases.

## Pre-release Verification

Code-changing PRs must pass the complete release surface before their
changesets reach `main`:

- formatting, lint, typechecking, and the SQLite/PGlite test suite;
- the PostgreSQL integration suite;
- every numbered SQLite and PostgreSQL example;
- the documentation build, rendered internal links and anchors, and TypeGraph
  imports extracted from current documentation code blocks;
- strict packed-consumer tests and API-report checks.

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
pnpm version-packages
pnpm release
```
