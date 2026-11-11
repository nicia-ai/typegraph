---
"@nicia-ai/typegraph": minor
---

**`importGraph()`, `importGraphStream()`, `exportGraph()` and `exportGraphStream()` refuse an option they do not declare** instead of silently dropping it, as graph merge already does. A misspelled `validateReference: false` used to import with reference validation still on; it now throws `ConfigurationError` with `details.code: "INTERCHANGE_OPTION_UNKNOWN"`, `details.operation` naming the entry point and `details.option` the first unknown key, before anything is read or written.

### Breaking

- An options object carrying a key the entry point does not declare is refused with `ConfigurationError` `INTERCHANGE_OPTION_UNKNOWN`. Remove the key, or correct its spelling. `batchSize` and `idleTimeoutMs` are `exportGraphStream()` options and are refused by `exportGraph()`.
