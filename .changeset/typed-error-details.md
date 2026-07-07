---
"@nicia-ai/typegraph": patch
---

Every `TypeGraphError` subclass with a fixed-shape `details` payload now
declares a narrowed `readonly details` type (e.g.
`RestrictedDeleteError.details` is `RestrictedDeleteErrorDetails`, not the
base class's `Readonly<Record<string, unknown>>`), so reading structured
fields like `error.details.edgeCount` no longer requires a cast. The new
`XxxErrorDetails` types (`NodeNotFoundErrorDetails`,
`EdgeNotFoundErrorDetails`, `KindNotFoundErrorDetails`,
`NodeConstraintNotFoundErrorDetails`, `NodeIndexNotFoundErrorDetails`,
`EndpointNotFoundErrorDetails`, `EndpointErrorDetails`,
`UniquenessErrorDetails`, `CardinalityErrorDetails`, `DisjointErrorDetails`,
`RestrictedDeleteErrorDetails`, `VersionConflictErrorDetails`,
`SchemaMismatchErrorDetails`, `MigrationErrorDetails`,
`EagerMaterializationErrorDetails`, `StaleVersionErrorDetails`,
`SchemaContentConflictErrorDetails`, `StoreNotInitializedErrorDetails`,
`DatabaseOperationErrorDetails`, `EmbeddingDimensionChangedErrorDetails`) are
exported from the package root alongside the existing
`ValidationErrorDetails`. Classes with intentionally open, per-call-site
details (`ConfigurationError`, `UnsupportedPredicateError`,
`CompilerInvariantError`, `BackendDisposedError`) are unchanged.
