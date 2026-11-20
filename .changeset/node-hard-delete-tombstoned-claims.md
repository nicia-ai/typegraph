---
"@nicia-ai/typegraph": patch
---

A node `hardDelete` or `bulkHardDelete` now releases the cardinality and composition claim rows of the node's soft-deleted edges. The node's removal deletes every connected edge row, soft-deleted ones included, but released claims only for the live edges its delete behavior removed; a soft edge delete releases no claim, so the claims of those soft-deleted edges outlived them. They never refused a later write, since a claim whose edge is gone is taken over, but they stayed in the claims table for good. The release has one owner on every path: the single delete, each composition cascade member, the batch's set-wise path and its per-node fallback, and an import's purge of an unattached required part.
