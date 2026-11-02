---
"@nicia-ai/typegraph": minor
---

**An omitted unique-constraint `scope` or `collation` now has one meaning everywhere.** The typed API requires both members, but an untyped caller could leave them out. The store then enforced the constraint across the kind's subclass component (any scope but `"kind"` reads as subclass-wide), the serializer dropped the keys, and the stored-schema parser read them back as `scope: "kind"`, so a schema migration of such a graph reported "Unique constraints changed" for a constraint nobody touched. The serializer and `defineGraph` now write `scope: "kindWithSubClasses"` and `collation: "binary"`, the values the store has always enforced, into a declaration that omits them, and the parser and the stored-document hash read an omitted member the same way. A row an earlier release wrote without them hashes equal to today's serialization, so a redeploy stays unchanged and no stored row is rewritten. A `scope` or `collation` stated outside its domain is refused at `defineGraph` with `ConfigurationError` (`UNIQUE_CONSTRAINT_OPTION_INVALID`); it previously produced a stored schema the loader rejected. A graph-extension document keeps its own default, `scope: "kind"`.

**`migrateSchema` re-keying an edge kind's match identity on a backend without `commitSchemaVersionWithPreflight` now refuses with `EDGE_MATCH_IDENTITY_REQUIRES_ATOMIC_BACKEND`**, with `details.edgeKinds` naming the re-keyed kinds as initial adoption already does. It refused with `IDENTITY_REQUIRES_ATOMIC_BACKEND`, naming identity on a graph that may have none.

### Breaking

- A stored unique constraint that omits `scope` now parses as `"kindWithSubClasses"`, not `"kind"`: `getActiveSchema`, schema diffs and introspection of such a document report the scope the store enforced. Enforcement is unchanged. To make such a constraint kind-scoped, declare `scope: "kind"`. That redeploy reshapes the constraint, so the uniqueness gate refuses it while the kind holds rows (`unique-constraint-requires-empty-kind`, cause `constraint-reshaped`): export and delete the kind's rows, commit the schema, then import them again.
