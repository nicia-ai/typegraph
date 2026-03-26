---
"@nicia-ai/typegraph": minor
---

### Breaking: default recursive traversal depth lowered from 100 to 10

Unbounded `.recursive()` traversals are now capped at 10 hops instead of 100. Graphs with branching factor *B* produce O(*B*^depth) rows before cycle detection can prune them — the previous default of 100 made exponential blowup easy to trigger accidentally.

If your traversals relied on the implicit 100-hop cap, add an explicit `.maxHops(100)` call. The `MAX_EXPLICIT_RECURSIVE_DEPTH` ceiling (1000) is unchanged.

### Schema parse validation

Serialized schema documents read from the database are now validated against a Zod schema at the parse boundary. Malformed, truncated, or incompatible schema documents will throw a `DatabaseOperationError` with path-level detail instead of propagating silently. Enum fields (`temporalMode`, `cardinality`, `deleteBehavior`, etc.) are validated against the known literal unions.

### Type safety improvements

- Added `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, and `noImplicitReturns` to tsconfig
- Drizzle row mappers now use runtime type checks (`asString`/`asNumber`) instead of unsafe `as` casts
- `NodeMeta` and `EdgeMeta` are now derived from row types via mapped types
- All non-null assertions (`!`) eliminated from source code
- Hardcoded constants extracted to shared `constants.ts`
- Duplicate `fnv1aBase36` function consolidated into `utils/hash.ts`
