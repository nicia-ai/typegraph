---
"@nicia-ai/typegraph": minor
---

Add format versioning to `RuntimeGraphDocument`. Sets up future format evolution for the runtime-extension document so older runtimes can refuse newer-major documents with an actionable error instead of silently misreading them.

## Public API

- `RuntimeGraphDocument.version?: 1` — optional major-version tag. The validator stamps the current version on every consumer-supplied document, so `defineRuntimeExtension(doc)` always returns `{ version: 1, ... }` even when `doc` doesn't include it.
- `CURRENT_RUNTIME_DOCUMENT_VERSION = 1` — exported constant for tooling that wants to pre-flight check documents.
- `RuntimeDocumentVersion` — type alias.
- New issue code: `RUNTIME_EXTENSION_VERSION_UNSUPPORTED`. Surfaces when a document declares a version higher than the current major.

## Forward-compat policy

- **Additive minor changes** (new optional property modifier, new `format` value, new top-level slice) ride forward via `.loose()` on every nested object schema. An older runtime reading a newer document silently ignores unknown fields and continues working.
- **Breaking changes** bump `version` to a higher major. An older runtime reading a higher-version document fails fast with `RUNTIME_EXTENSION_VERSION_UNSUPPORTED` and an actionable error pointing the operator at upgrading the library — there is no automatic downgrade path.

## Hash invariance

The persisted `runtimeDocument`'s `version` field is omitted from the canonical form when it equals the current major (today: `1`). This means:

- Documents persisted by older library versions (no `version` field) hash byte-identically to documents persisted by this version (`version: 1`).
- Future v2+ documents will emit `version: 2` explicitly because that value differs from the current default.
- Existing deployments see no schema-version bump on upgrade.

Mirrors the omit-when-default rule already applied to `indexes`, `annotations`, and `deprecatedKinds`.

## Validation

- Absent `version` → treated as current major.
- Integer equal to current major → accepted.
- Integer higher than current major → `RUNTIME_EXTENSION_VERSION_UNSUPPORTED`.
- Non-integer / non-positive → `INVALID_DOCUMENT_SHAPE` with path `/version`.

## Tests

- 4 new validator tests pinning version stamping, accept-current, reject-future, reject-bogus.
- New restart-parity test confirming a stored document committed by an earlier (pre-versioning) library version still loads — the loader treats absent `version` as `1`.
- Existing same-hash idempotent re-evolve test still passes (proves canonical-form omission works).
