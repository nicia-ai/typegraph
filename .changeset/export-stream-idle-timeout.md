---
"@nicia-ai/typegraph": minor
---

Add an opt-in `idleTimeoutMs` safety bound to `exportGraphStream`. The timeout
measures how long a delivered chunk remains unacknowledged, then rolls back the
snapshot transaction, releases the serialized stream lease, and reports the new
typed `ExportStreamIdleTimeoutError`. Time spent waiting for the backend does
not count as consumer idleness, and existing `AbortSignal` and cooperative
`break`/`return` cancellation behavior is unchanged.
