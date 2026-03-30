---
"@nicia-ai/typegraph": patch
---

fix: dispose serialized execution queue on backend close to prevent unhandled rejections

When the SQLite backend's underlying database is destroyed while operations are still queued (e.g., during Cloudflare Workers test teardown), the serialized execution queue now properly disposes pending promises. Calling `backend.close()` signals the queue to suppress errors from in-flight tasks and reject new operations with `BackendDisposedError`.

Fixes #72
