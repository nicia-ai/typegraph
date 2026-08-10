---
"@nicia-ai/typegraph": minor
---

Add `repairInvertedValidityWindows`, the explicit operator action that makes
rows an older version stored with a backwards window (`valid_from > valid_to`)
observable again. Such a row is readable at no coordinate at all; upgrading
deliberately rewrites nothing, so repairing is a decision an operator takes
rather than a side effect of a deploy.

`mode: "report"` counts and writes nothing — it reads through `execute`, a
required backend member, so detection works on every backend including a
history-capturing one and one with no statement-execution support.
`mode: "apply"` normalizes the rows it counted to no lower bound ("ended at T,
start unknown"), the shape today's write paths store, and is idempotent and
convergent. `relations` is required and takes `"live"` or `"live-and-recorded"`;
`"live-and-recorded"` is recommended, because repairing only the live axis
leaves the recorded twin inverted and re-materializes the invisible row at any
`asOfRecorded` coordinate.

The repair mints no revision, bumps no `version` and does not move `updated_at`:
it normalizes storage for rows that were never observable, so it is not a
logical write. Run it with writers stopped, and re-baseline outstanding merge
branches afterwards — `valid_from` is part of the `base@V` content fingerprint.
`apply` refuses rather than guessing on the states it cannot honor: a backend
without statement execution, a recorded-capture backend, and (on SQLite, where
bounds compare as text) a relation holding non-canonical bounds it cannot
classify.
