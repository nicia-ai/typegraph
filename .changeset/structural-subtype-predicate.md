---
"@nicia-ai/typegraph": minor
---

Add `isStructuralSubtype(child, parent)` to the `@nicia-ai/typegraph/schema` entrypoint: a pure structural-subtyping check over TypeGraph's projected JSON Schema fragment that answers whether every value satisfying `child` is guaranteed to satisfy `parent`. It returns a three-way verdict — `subtype`, `not-subtype` with the deepest failing reason and path, or `incomparable` when either side carries a construct the projection cannot judge (`$ref`, `allOf`, `not`, unmodeled JSON Schema keywords, or nesting past the depth guard) — so an unjudgeable pair is refused rather than accepted. Width subtyping is allowed (a child may add properties), required parent properties must stay required and narrower in the child, `integer` narrows `number`, unions match member-wise with sibling keywords ANDed, and `format` is compared as a constraint because the Zod projection emits it without a `pattern` for validators such as `z.url()`.

This is a different question from the migration classifier's `isBreakingPropertyChange`, which asks whether existing rows stay valid after a schema edit; the two disagree in both directions and the module documents why. The predicate is the foundation for validating `subClassOf` declarations against their schemas; that enforcement lands separately.
