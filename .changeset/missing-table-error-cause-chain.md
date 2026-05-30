---
"@nicia-ai/typegraph": patch
---

Fix `isMissingTableError` missing DrizzleQueryError-wrapped Postgres
"relation does not exist" errors, breaking fresh/partial Postgres boot (#153).

`isMissingTableError` (the shared "relation not bootstrapped yet"
discriminant for `loadActiveSchemaWithBootstrap`, `readActiveSchemaPure`,
and the #135 durable-marker gate) classified failures by inspecting only
`error.message`. On Postgres, drizzle-orm wraps every query-builder call
(`db.select()`, `db.insert()`, …) in a `DrizzleQueryError` whose `.message`
is the failed SQL text; the real driver error — carrying both
`relation "…" does not exist` and SQLSTATE `42P01` — is preserved on
`error.cause`, which the helper never walked. So the helper returned
`false` and a benign "not bootstrapped yet" surfaced as a hard fault.

This regressed `createStoreWithSchema` after the #149/#152 read-only
pre-check: `ensureRuntimeContributions` now calls `getMarker` (a
query-builder read) on the possibly-absent
`typegraph_contribution_materializations` table *before* `ensureMarkerTable()`.
On Postgres that read throws a `DrizzleQueryError`, the helper missed it,
and the open rethrew instead of materializing — breaking seed, first boot,
and test global-setup on any fresh or partial Postgres database (base
tables present, marker table absent — e.g. drizzle-kit-managed schemas).
SQLite was unaffected because better-sqlite3 throws a raw error whose
`.message` literally contains `no such table`.

`isMissingTableError` now walks the `error.cause` chain (cycle-safe) and
additionally keys on the locale-independent SQLSTATE `42P01`, rather than
matching only the outermost `.message`. Existing message patterns are
retained, so all prior matches still hold; the fix applies uniformly to
all three call sites, including the latent slow-path blind spot in
`loadActiveSchemaWithBootstrap` / `readActiveSchemaPure`.
