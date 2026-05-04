---
"@nicia-ai/typegraph": patch
---

Internal: dependency bump pass (patch/minor only — TypeScript and `@types/node` held back as separate majors).

Notable runtime/peer-relevant moves: `nanoid` 5.1.9 → 5.1.11 (only published runtime dep); dev/peer `zod` 4.3.6 → 4.4.3, `@libsql/client` 0.17.2 → 0.17.3.

Also drops the `export` keyword on 14 types that were never reachable through any public entry point (`src/index.ts`, `./schema`, `./indexes`, `./sqlite`, `./postgres`, etc.) and had no internal importers. These were leaked-internal types surfaced by a sensitivity change in `knip` 6.11. No symbol on the documented API surface changed; consumers importing only via the package's declared `exports` paths are unaffected.
