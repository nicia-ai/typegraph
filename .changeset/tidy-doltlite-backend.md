---
"@nicia-ai/typegraph": minor
---

Add an experimental DoltLite backend and managed store with recorded history, native branch working copies merged through TypeGraph, and exact cosine/L2 vector search. The backend requires a DoltLite Node binding that preserves extended SQLite errors and enables vec1; those fixes are merged upstream and await a release, so the repository includes a pinned, checksum-verified source build of the unmodified upstream binding. ANN indexing and browser/WASM support are not provided.
