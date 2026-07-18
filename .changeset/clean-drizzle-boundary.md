---
"@nicia-ai/typegraph": minor
---

Move query compilation behind TypeGraph-owned backend and SQL-fragment
abstractions so strict consumers no longer typecheck unused Drizzle dialect
declarations. Add a Drizzle-free `core` entrypoint and managed full-Store
entrypoints for local SQLite and PGlite, with packed TypeScript 5 and 6
regression coverage for both databases.

The portable `@nicia-ai/typegraph/indexes` entrypoint is also Drizzle-free.
Direct Drizzle index-builder helpers moved to
`@nicia-ai/typegraph/adapters/drizzle/indexes`.

Advanced adapter APIs now use TypeGraph's `SqlFragment` instead of Drizzle
`SQL`: this includes query `compile()` results, custom `GraphBackend`
implementations, and custom fulltext/vector strategies. Use `toSQL()` for a
dialect-rendered `{ sql, params }` result, or `renderSqlite()` /
`renderPostgres()` when rendering a fragment directly.

Custom backend and strategy authors can import the complete, Drizzle-free
contract vocabulary from `@nicia-ai/typegraph/backend`. This entrypoint names
every operation parameter, row, strategy payload, dialect port, SQL fragment
chunk, and supporting schema/index type referenced by those contracts. API
Extractor enforces zero forgotten exports for new entrypoints and fingerprints
the complete pre-existing debt set so added or removed leaks cannot pass
silently.

The default `Store<G>` is now the portable TypeGraph surface. It keeps the full
graph API and graph-owned transactions while omitting adapter-native handles and
caller-owned transaction adoption. Drizzle integration entrypoints return
`AdapterStore<G, TNativeTransaction>` when precisely typed `tx.sql`,
`withTransaction`, or `withRecordedTransaction` interoperability is required.
`createStore`, `createStoreWithSchema`, and `createVerifiedStore` now return the
portable contract; use their `createAdapterStore`,
`createAdapterStoreWithSchema`, and `createVerifiedAdapterStore` counterparts
when the application deliberately needs adapter-native interoperability.

`GraphBackend` is now the portable TypeGraph backend port. Native transaction
adoption lives on `AdapterBackend<TNativeTransaction>`, so a capability-less
backend cannot be passed to an adapter-store factory. Portable transaction
contexts and adapter transaction contexts both expose the same runtime-enforced
read-only `TransactionReadBackend`. Adapter contexts add only the precisely
typed native `sql` handle; TypeGraph internals reach the full transaction
backend through a non-public, non-enumerable runtime port. Backend functions
are now receiver-free (`this: void`); custom backends must close over their
state instead of depending on method receivers.

PostgreSQL adapter stores now expose and accept `AnyPgTransaction` for native
transaction interoperability. A root Drizzle PostgreSQL database is rejected
at compile time and runtime; pass only the transaction handle received by a
caller-owned `db.transaction(...)`. SQLite adoption remains database-handle
based so its documented manual-`BEGIN` integration continues to work.

Public `TransactionOptions` now contains only caller-selectable isolation and
access modes. TypeGraph's temporary-write authorization is an internal,
globally branded capability and is no longer expressible through the public
transaction contract. Fulltext and vector strategy members are readonly
function properties, closing TypeScript's method-bivariance loophole for
third-party implementations. Dialect adapter members use the same receiver-free
function-property contract, and `TransactionOptions` is exported from the root
entrypoint for portable transaction consumers.

Managed SQLite and PGlite factories preserve the precise live, history, or
recorded-read Store flavor selected by their options, including when options
are widened before the call. This keeps unavailable write and native-adapter
capabilities unrepresentable instead of relying on runtime failures.

Every Store flavor exposes the safe, Drizzle-free `store.capabilities`
descriptor for runtime feature checks without exposing backend operations.
`AdapterHistoryStore.backend` exposes the narrower `HistoryStoreBackend`, which
omits raw SQL, native import, graph clearing, and nested backend transactions so
capture-bypassing writes are absent at both type and runtime levels.

Backend capability narrowing now uses an exhaustive runtime allowlist instead
of default-forwarding proxy overlays. New `GraphBackend` members must be
classified explicitly, preventing adapter capabilities from leaking through a
history wrapper. Store evolution also preserves each refined Store flavor and
accepts invariant `StoreRef` values for that exact replacement surface.

Add checked-in API Extractor reports derived from every package export. CI now
fails when the emitted public declaration surface changes without an
intentional report update.

Direct SQL fragment values now pass through the same dialect binding
normalization as placeholders and compiled queries. Runtime store,
transaction, schema, and recorded-read ports use versioned global symbols so
mixed ESM/CJS or duplicated bundle instances interoperate safely. Dialect
policies outside the compiler are exhaustive records or switches, so adding a
new SQL dialect cannot silently inherit SQLite behavior.

Remove the transitional `SQL`, `SqlRenderDialect`, and `AdoptedTransaction`
aliases. Import `SqlFragment` and `SqlDialect` directly. The constructors that
brand arbitrary fragments as executable SQL are now internal; public compiled
SQL values come from TypeGraph's query compiler. Managed local stores now live
at `/sqlite/local` and `/postgres/pglite`; bring-your-own-connection APIs live
under `/adapters/drizzle/sqlite...` and `/adapters/drizzle/postgres...`.
