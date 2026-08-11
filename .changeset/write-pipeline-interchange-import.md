---
"@nicia-ai/typegraph": patch
---

Route interchange import through the write pipeline: its hand-built write
context and its own `runInWriteTransaction` call are gone, and all six write
legs — the batched and per-row node creates, the node update, the batched and
per-row edge creates, and the edge update — now run as session calls under one
write plan whose identity participation the executor acquires. Import's
hand-rolled `insertNodesBatch === undefined` / `insertEdgesBatch === undefined`
probes converge on the insert dispatch that already owns that decision, and its
edge update states the five immutable identity components and the window
guard's stored lower bound as a fence record with required keys instead of a
spread convention. The write-pipeline exemption list has no migration debt left:
every remaining entry is a step, sidecar or reasoned carve-out. No public API,
behavior, error type, statement or lock scope changes.
