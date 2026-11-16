---
"@nicia-ai/typegraph": patch
---

`defineNode` and `defineEdge` refuse a property schema that is not a Zod object with a typed `ConfigurationError` (`details.code: "NODE_SCHEMA_NOT_OBJECT"` / `"EDGE_SCHEMA_NOT_OBJECT"`, with `details.nodeType` / `details.edgeType` and `details.schemaType`, the type received). This covers a union, discriminated union, intersection or record, an object behind `.transform()` / `.pipe()`, `.optional()`, `.readonly()` or `z.lazy()`, and a value that is not a Zod schema. These schemas could never back a kind: before this release each one crashed inside `defineNode` / `defineEdge` with a raw `TypeError: Cannot convert undefined or null to object`. The suggestion says to declare `z.object({...})`, to model alternatives as a property inside one object or as separate kinds, and to apply transforms to individual fields. Objects wrapped by `.refine()` / `.superRefine()` or built with `.extend()`, `z.strictObject` and `z.looseObject` are unchanged.
