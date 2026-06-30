# Temporal read coordinate + collection read/write split

Status: **implemented and merged via `feat/store-view`/#185**. Sequencing:
this work precedes Unit 2 (recorded time). Recorded-time is the forcing
function — if it lands without this coordinate seam, it replicates the
temporal-injection split across a bitemporal surface that is strictly worse to
unwind.

Locked decisions:

1. **Normalize `find`/`count` temporal options to a trailing `QueryOptions` arg** (yes).
   Shape: `find(filter?, temporal?: QueryOptions)`. Only three signatures change (node
   `find`, edge `find`, edge `count`); node `count`/`getById`/`getByIds` and edge
   `getById`/`getByIds`/`findFrom`/`findTo`/`findByEndpoints` already take a trailing
   `QueryOptions`. Blast radius is tiny — zero `src/`
   callers pass inline temporal to `find`/`count`; only `collection-api.test.ts`, the
   StoreView property test, the `test-d` negatives, and the StoreView internals (rewritten
   here) need updating. Old-shape callers become compile errors (excess `temporalMode` key).
2. **Current-only reads follow the search rule** (generalize): delegate on a `current`
   view, refuse with `*_UNSUPPORTED` on a temporal pin.
3. **Accept the small non-public `Store` seam** for query sealing (yes).

Goal (from the StoreView review): make the view's completeness structural rather than
hand-maintained, and route the pin through one seam so a future temporal axis cannot
split by surface. Three moving parts:

1. `ReadCoordinate` — one opaque, extensible coordinate object.
2. `withCoordinate(coord)` — the single injection helper every surface calls.
3. A read/write split of the live collection interfaces, so the view surface derives.

Plus: seal `view.query()` so the pin cannot be overridden.

---

## 1. Method inventory — there are THREE buckets, not two

A read/write split is necessary but **not sufficient**. The reads divide further:

### NodeCollection

- Writes (excluded from view): `create`, `createFromRecord`, `update`, `delete`,
  `hardDelete`, `upsertById`, `upsertByIdFromRecord`, `bulkCreate`, `bulkUpsertById`,
  `bulkInsert`, `bulkDelete`, `getOrCreateByConstraint`, `bulkGetOrCreateByConstraint`.
- **Temporal reads** (pin-honoring): `getById`, `getByIds`, `find`, `count`.
- **Current-only reads** (no temporal axis): `findByConstraint`,
  `bulkFindByConstraint`, `bulkFindByIndex`. These always read live/current state.

### EdgeCollection

- Writes (excluded): `create`, `update`, `delete`, `hardDelete`, `bulkCreate`,
  `bulkUpsertById`, `bulkInsert`, `bulkDelete`, `getOrCreateByEndpoints`,
  `bulkGetOrCreateByEndpoints`.
- **Temporal reads**: `getById`, `getByIds`, `find`, `count`, `findFrom`, `findTo`,
  `findByEndpoints`.
- **Batch/deferred reads** (absent from `StoreView`; require `store.batch()` context):
  `batchFindFrom`, `batchFindTo`, `batchFindByEndpoints`.
- **Current-only reads**: none. Endpoint parity has landed; `findByEndpoints` honors the
  temporal coordinate like `findFrom` / `findTo`.

The current-only bucket is the crux. On a `current` view these reads equal the live store.
On an `asOf` / `includeEnded` / `includeTombstones` pin they **cannot** honor the
coordinate and would silently return current data while every sibling method is pinned — a
lie. Today that bucket is node constraint/index reads only; edge endpoint reads moved to the
temporal bucket once endpoint parity landed. The split forces an explicit policy (§5).

---

## 2. ReadCoordinate + withCoordinate — the Unit-2 seam (unambiguous win)

```ts
// Opaque, extensible. Valid-time and recorded-time live in one coordinate so
// pinned reads do not thread each temporal dimension separately.
export type ReadCoordinate = Readonly<{
  valid: Readonly<{ mode: TemporalMode; asOf?: string }>;
  recorded?: Readonly<{ asOf: RecordedInstant }>;
}>;

type InternalReadParams = QueryOptions & Readonly<{ recordedAsOf?: string }>;

// THE single flattening point: coordinate -> the concrete option fields an internal
// pinned read expects. Public QueryOptions stays valid-time-only.
export function withCoordinate(coord: ReadCoordinate): InternalReadParams {
  return {
    temporalMode: coord.valid.mode,
    ...(coord.valid.asOf !== undefined && { asOf: coord.valid.asOf }),
    ...(coord.recorded?.asOf !== undefined && {
      recordedAsOf: coord.recorded.asOf,
    }),
  };
}
```

Every pinned surface replaces its ad-hoc `{ ...options, ...pin }` /
`.temporal(mode, asOf)` with `withCoordinate(this.#coord)` spread into the
internal read options it passes onward. When recorded-time lands, the axis
appears at all reconstructing surfaces or none — by construction. **This part
holds up with one caveat:** `recordedAsOf` must not be added to public
`QueryOptions`, or live collection methods would grow an unofficial recorded-time
escape hatch. The recorded field is internal to pinned
StoreView/RecordedStoreView plumbing and query compilation.

---

## 3. View-type derivation — holds up, but only after normalizing `find`

Source split (in `store/types.ts`):

```ts
type NodeReads<N, CN>  = NodeTemporalReads<N> & NodeCurrentReads<N, CN>;
export type NodeCollection<N, CN = string> = NodeReads<N, CN> & NodeWrites<N>;
```

Derive the view by stripping the per-call temporal axis from each temporal read:

```ts
type Pinned<R> = { readonly [K in keyof R]: Depin<R[K]> };
export type StoreViewNodeCollection<N> = Pinned<NodeTemporalReads<N>>;
```

**The wrinkle Unit 1 fixed:** `Depin` is only clean if every temporal read passes
its coordinate the same way. Before the StoreView slice, they did not:

| method | temporal passed via | depin = |
| --- | --- | --- |
| `getById/getByIds/findFrom/findTo/findByEndpoints` | trailing `options?: QueryOptions` | drop trailing arg |
| node `count` | `options?: QueryOptions` | drop trailing arg |
| node `find` | **inline** `{ where, limit, offset, temporalMode, asOf }` | `Omit<…,"temporalMode"\|"asOf">` |
| edge `find` / `count` | **inline** `{ from, to, …, temporalMode, asOf }` | `Omit<…,"temporalMode"\|"asOf">` |

So `find`/`count` mix temporal and non-temporal fields in one bag, and a single generic
`Depin` must branch on "is the trailing arg exactly `QueryOptions`?" — doable with variadic
tuples + an `Omit` fallback, but brittle and hard to debug when the next method doesn't fit.

**Recommendation: normalize first.** Move the inline `temporalMode`/`asOf` on `find`/`count`
to the same trailing `QueryOptions` arg the other reads already use (or nest them under one
`temporal` key). Then `Depin` is uniformly "drop the trailing `QueryOptions` arg" — simple,
robust, and future-proof. This is a **small breaking change** to `find`/`count` signatures,
and **now (pre-Unit-2) is the time** — every axis added later inherits the clean shape.

Completeness guarantee: add a method to `NodeTemporalReads` and it auto-appears (pinned) in
the view; forget to wrap it and `Pinned` still includes it so the implementation fails to
satisfy the type. Back this with a `test-d` conformance check (`keyof StoreViewNodeCollection`
⊇ `keyof NodeTemporalReads`) so drift is a build break.

Verdict: derivation holds up because `find`/`count` normalization landed. Without
it, Unit 2 would have needed to hand-special-case `find` and `count` on the
recorded surface.

---

## 4. Sealed query — falls out of coordinate-in-config

`Omit<QueryBuilder, "temporal">` does NOT seal a fluent chain: `.from()` returns the full
`QueryBuilder<…>` again, re-exposing `.temporal()`. The only thing that seals is state that
**propagates through every clone**. `#config` is threaded verbatim
(`new QueryBuilder(this.#config, {...this.#state})`); `#state` is spread. So the
seal belongs in **config**:

```ts
// CreateQueryBuilderOptions / QueryBuilderConfig gains:
sealedCoordinate?: ReadCoordinate;

// temporal() guards on it:
temporal(mode, asOf) {
  if (this.#config.sealedCoordinate !== undefined)
    throw new ConfigurationError("temporal() is not available on a pinned StoreView query …");
  …
}
```

`view.query()` builds the sealed query, seeding initial `state.temporalMode/asOf` from the
coordinate. Because config is never rebuilt mid-chain, the seal survives `.from().where().traverse()…`.

**Trade-off to accept:** sealing needs a small internal seam on `Store` (e.g. a view-only
`#sealedQuery(coord)`), so the view is no longer built *purely* on the public Store surface.
That's the honest cost of capability-safety; acceptable.

---

## 5. Current-only reads — generalize the existing search rule

`search` already does the right thing: read methods delegate on a `current` view, refuse on a
temporal pin. The current-only node collection reads (`findByConstraint`,
`bulkFindByConstraint`, `bulkFindByIndex`) are the **same class** — current-index-only reads.
So apply the same rule rather than blanket-omitting them:

- On a `current` view: expose and delegate (fixes review finding E2).
- On a temporal pin: refuse with a clear `*_UNSUPPORTED` error (not the misleading
  read-only code), reusing the search-refusal infra.

This keeps the policy honest and uses one mechanism for both search and constraint/index
reads. Endpoint parity has landed, so `findByEndpoints` is already in the temporal bucket.

---

## Touch surface + open decisions

Unit 1 touched: `store/types.ts` (split + derived view types), `store/store-view.ts`
(`withCoordinate`, `ReadCoordinate`, current-only refusal), `query/builder` config +
`temporal()` seal, `store.ts` (internal sealed-query seam),
`collections/temporal-read-params.ts`, plus `test-d` conformance tests and runtime tests for
the seal + current-only refusal.

Unit 2 extends the same seam:

1. `ReadCoordinate.recorded?: { asOf: string }`.
2. Internal read params carry `recordedAsOf`; public `QueryOptions` remains valid-time-only.
3. Query builder state, `QueryAst`, compile options, prepared queries, aggregate queries, and
   union/set-operation paths carry the recorded axis.
4. A narrow `RecordedStoreView` derives from `StoreView` and exposes only reconstructing-safe
   surfaces.

Resolved decisions:

1. **Normalize `find`/`count` temporal shape:** yes.
2. **Current-only reads:** generalize the search rule for node constraint/index reads.
3. **Seal cost:** accept the small non-public Store seam for capability-safety.
4. **Coordinate shape:** keep nested `valid` plus sibling `recorded`; do not widen
   `TemporalMode`.
