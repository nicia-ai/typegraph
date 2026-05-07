---
"@nicia-ai/typegraph": minor
---

Add `eager` option to `Store.evolve()` for one-call schema-commit + index-materialize. Closes the eager-mode follow-up from #101 / PR 6.

```typescript
// All-in-one: commit the schema and materialize all declared indexes.
const evolved = await store.evolve(extension, { eager: true });

// Pass through MaterializeIndexesOptions for finer control. v1
// runtime extensions don't carry relational indexes, so the kinds
// filter only meaningfully restricts to compile-time kinds.
const evolved = await store.evolve(extension, {
  eager: { kinds: ["Document"], stopOnError: true },
});
```

## Semantics

- Eager mode runs `materializeIndexes()` AFTER the schema commit succeeds. The schema-version write is **not** rolled back if materialization produces failed entries — eager is a convenience, not a transaction.
- On per-index failure, `evolve()` throws `EagerMaterializationError` AFTER the new `Store` is constructed and `ref.current` is updated. The caller can recover via the ref handle:

```typescript
const ref = { current: store };
try {
  await store.evolve(extension, { ref, eager: true });
} catch (error) {
  if (error instanceof EagerMaterializationError) {
    // Schema is committed; ref.current is the new store.
    log.warn(
      { failed: error.failedIndexNames },
      "indexes did not materialize; will retry",
    );
    await ref.current.materializeIndexes();
  } else {
    throw error;
  }
}
```

- `eager: false` (the default) preserves the existing behavior — `evolve()` returns the new `Store` immediately and the consumer calls `materializeIndexes()` separately if they need to.
- `eager` accepts `boolean | MaterializeIndexesOptions`. Passing an object lets you scope to specific kinds or set `stopOnError`.

## API additions

- `Store.evolve(extension, options?)` — `options.eager?: boolean | MaterializeIndexesOptions`.
- `EagerMaterializationError` — new error class exported from `@nicia-ai/typegraph`. Carries `materialization: MaterializeIndexesResult` (full result) and `failedIndexNames: readonly string[]` (convenience). `code: "EAGER_MATERIALIZATION_FAILED"`.

## When to use eager

The flag is dev-loop convenience and one-off scripts. Production code that wants nuanced failure handling (per-index retries, alerting on specific failures, deferred materialization) should keep the explicit two-call pattern: `await store.evolve(ext)` then `await store.materializeIndexes()` separately. The single-call shape pays for itself when the surrounding code doesn't care about distinguishing schema commits from index materializations — a single throw / no-throw signal is enough.
