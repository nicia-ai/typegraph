# 0.55 generic type regressions

## Cause and scope

The source-dependent target implementation in #604 changed endpoint-taking
collection methods from flat parameters to distributive unions of argument
tuples and bulk items. A concrete registration reduces to its permitted pairs.
For `G extends GraphDef` and `K extends EdgeKinds<G>`, the extracted pair type
remains deferred. TypeScript cannot prove that an independently assembled
argument tuple satisfies that conditional, even when the graph is constrained to
array-valued targets. This is a declaration-level regression, not a write-engine
failure. #605 supplied the changeset; it did not introduce the implementation.

The compiler reproduction compared installed 0.54.0 and 0.55.0 artifacts with
TypeScript 5.9.3 and 7.0.2. The original report used `props: unknown`; that input
fails on both releases. Correcting it to the edge schema's `z.input` makes the
0.54 program pass and the 0.55 program fail, isolating the endpoint regression.

| Consumer | 0.54 | 0.55 | Disposition |
| --- | --- | --- | --- |
| Generic `getOrCreateByEndpoints`, `findByEndpoints` | Compiles | Rejected | Dynamic lookup with schema-preserving `E` |
| Generic `create`, `batchFindByEndpoints` | Compiles | Rejected | Same dynamic collection |
| Generic `bulkCreate`, `bulkInsert`, `bulkUpsertById`, `bulkGetOrCreateByEndpoints` | Compiles | Rejected | Same dynamic collection |
| Generic valid-time view `findByEndpoints` | Compiles | Rejected | Pinned dynamic view lookup |
| Generic `EdgeCollection<E, From, To>` and typed registration annotations | Compiles in checked calls | Rejected in checked calls | `DynamicEdgeCollection<E>` for runtime endpoints |
| Generic node factory followed by traversal `.to(targetKind)` | Compiles | Rejected | Direct target-kind projection without schema inference |
| Concrete array registrations and concrete kind union | Compiles | Compiles | Preserve static surface |
| Concrete map registration with an undeclared pair | Feature absent | Rejected | Preserve rejection |
| Broad `EdgeRegistration.to` assumed to be an array | Array shape | Array/map shape | Narrow with `isEdgeTargetMap`, or declare an explicit Cartesian fourth argument |
| Recorded view `findByEndpoints` | Absent | Absent | Not a regression; reconstructing views intentionally lack it |
| `props: unknown` on the typed API | Rejected | Rejected | Parse or carry the schema's input type |

The audit covered the endpoint aliases and their collection/view consumers, graph
registration defaults, target extraction, and the adjacent traversal/registration
changes in #604. A second regression affects query factories whose target node
schema remains generic: outgoing target extraction began inferring a node type
through nested array/map conditionals, leaving the known target kind deferred.
An installed-artifact query reproduction compiles on 0.54 and fails on 0.55.
Directly projecting the kind through numeric keys repairs this without changing
the traversal API. Distributing the projection over target declarations preserves
unions of maps with disjoint source keys. Positive and negative compiler cases
cover both this factory and the map-union case. The broad-registration target
shape change is deliberate. This is a
bounded consumer audit, not proof of compatibility for every possible TypeScript
program.

## Why the existing checks missed it

- The feature's type assertions exercised concrete registrations and concrete
  endpoint literals. They demonstrated pair safety but did not compile helpers
  abstracted over a graph, edge key, endpoint type parameter, or generic node
  schema inside a graph factory.
- Runtime unit tests, property tests, and runtime mutation tests run JavaScript.
  They can find invalid writes but cannot observe erased generic relationships.
  Increasing their case count would not exercise the failing compiler contract.
- Packed smoke tests used real declarations, but their calls were also concrete.
  Packaging coverage did not imply coverage of generic abstraction shapes.
- API reports and the surface compatibility checker inventory structural
  members. These methods still existed; their conditional signatures became
  uncallable in generic contexts without a structural removal.
- The tsd command installed the requested `typescript` beside tsd. However, tsd
  imports its own `@tsd/typescript`. That step did not vary its compiler as its
  old logging suggested. Source and consumer checks did vary their compilers,
  but lacked the necessary fixture. Missing TS 7 was not the root cause: the
  failure reproduces on 5.9.3 too.
- Release notes described the feature and runtime compatibility, but omitted
  generic dispatch and the broad `.to` annotation migration.

## API decision and prevention

Do not flatten the distributive aliases: experimentally removing their condition
made generic calls compile while also accepting an undeclared concrete pair.
The conditional already distributes; that distribution is load-bearing.
Compatibility overloads that infer whether endpoint evidence has been erased add
another inference-sensitive contract to every method.

Keep concrete `.edges` calls correlated. Extend the existing runtime lookup
boundary instead: `DynamicEdgeCollection<E>` preserves property input and result
types, accepts runtime endpoints and string IDs, and uses the same underlying
collections and validators. Transaction lookups resolve the transaction/scope
wrappers, and valid-time view lookups resolve pinned wrappers. No independent
write implementation is introduced. Broad registration defaults are not reverted
merely to recreate the previous shape. Hand-authored transaction and view mocks
must implement the new lookups; this is an intentional pre-1.0 minor API change
recorded by exact member in the compatibility exception ledger.

The consumer fixture now compiles generic graph/key helpers and explicit dynamic
collection annotations, generic query factories, and map-union traversals
alongside concrete positive and negative pair checks,
required properties, temporal set/clear exclusivity, and read-only view checks.
It runs against source and packed declarations. The compiler matrix includes a
TS 7 packed-consumer lane, and tsd logging states its actual compiler ownership.
Shared backend cases verify transaction rollback, invalid bulk-pair atomicity,
receipt/scoped receipt attribution, and pinned reads, with and without history.

The load-bearing checks were exercised in an isolated copy of the source:
routing scoped dynamic lookups through the root collections failed both history
variants; restoring the context-owned lookup passed. Replacing the dynamic
collection's selected property schema with `AnyEdgeType` made the fixture's
property and required-input negative assertions unused; restoring `E` compiled.
The original installed-artifact comparison independently establishes the generic
call regression rather than relying on a newly introduced lookup being absent.

Restoring the original query target alias in the isolated source made the generic
factory and mixed array/map traversal assertions fail; restoring the direct and
distributive projections compiled. The direct array projection is necessary for
a generic schema whose kind is known, while the distributive projection retains
every range when selecting among differently shaped declarations.
