---
"@nicia-ai/typegraph": patch
---

`store.clear({ preserveContributionMaterializations: true })` is now refused with `UnsupportedBackendCapabilityError` on a custom backend that does not implement `clearGraphPreservingContributionMaterializations`, before anything is deleted. It previously fell back to `clearGraph` and could delete the markers it was asked to keep. `store.clear()` with the option omitted is unchanged: it prefers the preserving member and otherwise clears through the backend's own `clearGraph`. Bundled backends implement the member and are unaffected.
