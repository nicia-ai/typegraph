---
"@nicia-ai/typegraph": patch
---

Update `nanoid` to 6.0, which requires Node.js 22 or later, matching the package's existing `engines` range. `ExportOptionsSchema.signal` keeps its declared `ZodCustom<AbortSignal, AbortSignal>` type, so the published declarations stay valid across the whole `zod ^4.0.0` peer range.
