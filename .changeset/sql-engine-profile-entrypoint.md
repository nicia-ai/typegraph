---
"@nicia-ai/typegraph": minor
---

Add a new entrypoint, `@nicia-ai/typegraph/adapters/drizzle/engine`, exporting
`createSqlBackend` and the `SqlEngineProfile` types. `createPostgresBackend`
and `createSqliteBackend` are now each `createSqlBackend` applied to a
profile built by `buildPostgresEngineProfile` / `buildSqliteEngineProfile`.
Emitted SQL, capabilities, marks, transaction framing, and error paths are
unchanged for every configuration the two factories accepted before.

Two construction-time narrowings apply to the bundled factories as well as
to third-party profiles, because both now run through `createSqlBackend`:

- A backend whose resolved capabilities carry no `writeFence`
  declaration is refused with a `ConfigurationError`
  (`ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION`) that prints the one
  declaration line to add. Omitting `writeFence` from a `capabilities`
  override is unaffected (the factory's own declaration applies); passing
  `capabilities: { writeFence: undefined }` explicitly, which previously
  built a backend that resolved every write fence through a dialect fallback,
  now throws at construction.
- A backend whose declaration resolves `unfenced` no longer earns
  the schema-fenced-insert eligibility mark, so a schema-managed first write
  on it now refuses with `WRITE_FENCE_UNAVAILABLE` instead of fusing the
  insert. Schema commits on such a backend already refused, so a working
  configuration is unaffected.
