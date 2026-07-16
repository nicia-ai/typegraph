---
"@nicia-ai/typegraph": minor
---

TypeGraph's base-relation indexes are now **system-index declarations** — a
single declared list (`SYSTEM_INDEX_DECLARATIONS`) that both dialect schemas
derive from and that materializes onto already-initialized databases.

Previously the base indexes were hand-written twice (once per dialect schema)
and applied only by first-boot bootstrap DDL, so an index added in a newer
library version never reached an existing database without manual DDL (the
gap #282 exposed). Now:

- **Single source, parity by construction.** `createSqliteTables` /
  `createPostgresTables` build their node/edge/recorded-relation indexes from
  the same declarations, and a cross-dialect extraction test asserts the two
  generated DDL scripts' full index sets stay identical.
- **Upgrade path.** `createStoreWithSchema` brings a database's system
  indexes up to the running library version at boot — `CREATE INDEX
  CONCURRENTLY` on PostgreSQL, riding the same status table, drift
  signatures, invalid-leftover healing, and cross-caller claim protocol as
  graph-declared indexes. A database whose indexes all exist settles from
  one catalog read (scoped to the session `search_path`, so schema-per-
  tenant databases never observe each other's indexes) with no DDL and no
  writes; a system index that is physically absent or invalid is rebuilt
  even when a stale success row survives (dump/restore, manual drop).
  Failures — including status-table infrastructure errors — degrade to a
  warning: indexes are a performance concern and the store still boots.
  Deployments that must not run index builds inline at boot pass
  `systemIndexes: "skip"` to `createStoreWithSchema` and materialize
  out-of-band.
- **New API: `store.materializeSystemIndexes()`** for deployments that boot
  without `createStoreWithSchema` (zero-DDL attach) — call once under a
  DDL-capable role after upgrading. Strict where the boot path is lenient:
  throws `ConfigurationError` on backends without DDL/status primitives.
- `IndexEntity` gains a `"system"` member; system status rows carry the
  relation key (e.g. `"recordedNodes"`) in their `kind` column.

Generated DDL is unchanged for default and short custom table names — same
index names, columns, and order — so existing databases and drizzle-kit
migrations are unaffected. Names that would exceed PostgreSQL's 63-char
identifier bound (very long custom table names) are now deterministically
truncated + hash-suffixed instead of being silently truncated by the engine
into collisions. System index names are reserved: a graph-declared index
using one is rejected at table definition and by `materializeIndexes()`
(previously its `CREATE INDEX IF NOT EXISTS` silently no-opped against the
differently-shaped system index while recording success). Legacy databases
that predate the recorded relations skip those indexes cleanly instead of
attempting failing DDL at every boot.
