---
"@nicia-ai/typegraph": minor
---

`store.clear({ preserveContributionMaterializations: true })` no longer falls back to `clearGraph` on a custom backend that does not implement `clearGraphPreservingContributionMaterializations`, where it could delete the markers it was asked to keep. `store.clear()` with the option omitted is unchanged: it prefers the preserving member and otherwise clears through the backend's own `clearGraph`. Bundled backends implement the member and are unaffected.

### Breaking

- A custom backend that does not implement `clearGraphPreservingContributionMaterializations` refuses `store.clear({ preserveContributionMaterializations: true })` with `UnsupportedBackendCapabilityError` before anything is deleted. Implement the member, or drop the option.
