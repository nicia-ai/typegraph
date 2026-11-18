---
"@nicia-ai/typegraph": patch
---

Types that the public API names can now be imported from a semver-covered entrypoint, and a module that exports an inferred graph now emits declarations without extra imports.

**Exported graphs emit declarations.** With `declaration: true`, a file that does `export const graph = defineGraph({...})` (or exports a node, edge, ontology relation, store or query built from one) failed with TS2742/TS2883: "the inferred type cannot be named without a reference to `.../dist/store-entry.d-<hash>`". The types those inferred types are spelled with are now re-exported, type-only, from the package root: `DeleteBehavior`, `EdgeInGraph`, `EmbeddingSchema`, `EmbeddingValue`, `ExecutableQuery`, `ExtensionEdgeDef`, `ExtensionIndex`, `ExtensionNodeDef`, `ExtensionOntologyRelation`, `GraphAnnotations`, `GraphExtensionVersion`, `KindAnnotations`, `SearchableSchema`, `TemporalMode` and `TypedOntologyRelation`. A consumer that imports from the root no longer needs to import `/core`, `/graph-extension`, `/query` or `/store` only so TypeScript can name these types. The root gains no runtime exports.

**Types named by covered signatures are importable from covered entrypoints.** In 0.75.0 these types appeared in covered signatures but could only be imported from `/backend`, which semver does not cover. They are now type-only exports of the covered entrypoint that owns the concept:

- `@nicia-ai/typegraph/store`: `EngineRevision`, `EntityKey`, `LineageDelta` (named by `changesSince`, `lineageRevisionNow` and the read-set fence), `TransactionOptions`, `FulltextQueryMode`, `VectorMetric`, `VectorIndexType`, `MisassignedEdgeEndpointRow`.
- `@nicia-ai/typegraph/query`: `JsonPointer`, `ValueType`, `SqlDialect`, `SqlTableNames`.
- `@nicia-ai/typegraph/schema`: `ContributionProbeResult`, `ContributionProbeEntry`, `ContributionProbeState`, `ContributionProbeContribution`, `ContributionRebuildResult`, `ContributionRebuildScope`, `EdgeCardinalityDeclaration`, `CompositionClaimScope`, `SchemaVersionRow`.
- `@nicia-ai/typegraph/indexes`: `IndexDeclarationBase`, `IndexWhereLiteral`, `IndexWhereOp`, `IndexWhereOperand`, `RelationalIndexMethod`.
- `@nicia-ai/typegraph/core`: `MetaEdgeName`, plus `ALL_META_EDGE_NAMES` as a type-only export (`typeof ALL_META_EDGE_NAMES`).
- `@nicia-ai/typegraph/graph-extension`: `ExtensionPropertyModifiers`.

If you extracted one of these types from a method parameter or imported it from `/backend`, import it from the entrypoint above instead. The `/backend` exports are unchanged.

**The move map is corrected.** `etc/root-export-moves.json` in 0.75.0 sent `ContributionDiagnostic`, `ContributionDiagnosticState`, `ContributionRepairEntry` and `ContributionRepairResult` to `/backend`, although `/schema` already exported them. It now points them to `/schema`. It also points to the new covered homes listed above: `EngineRevision`, `EntityKey`, `LineageDelta`, `TransactionOptions`, `FulltextQueryMode` and `MisassignedEdgeEndpointRow` go to `/store`; `JsonPointer`, `SqlDialect` and `SqlTableNames` to `/query`; and `ContributionProbeResult`, `ContributionProbeEntry`, `ContributionProbeState`, `ContributionProbeContribution`, `ContributionRebuildResult`, `ContributionRebuildScope`, `EdgeCardinalityDeclaration`, `CompositionClaimScope` and `SchemaVersionRow` to `/schema`.
