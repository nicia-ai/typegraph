---
"@nicia-ai/typegraph": patch
---

A `Date` for a `z.date()` property is now accepted in an `updateWhere()` or `compareAndSet()` patch and stored as the same ISO text `create()` and `update()` store, at any depth of a nested object or array. Both refused it with `ConfigurationError` ("contains a non-JSON value (Date instance)"), and since a date property also refuses its ISO text, a set update could not write one at all. A `compareAndSet()` `expected` value may now be a `Date` too (and `CompareAndSetExpected` admits one); it matches the stored text of that `Date`. Text you state for a date property is still refused.

`importGraph()` now accepts the stored date text `exportGraph()` writes. Import parsed each row as create input, where `z.date()` refuses a string, so every row of a kind with a date property was reported as an error and the round trip lost it. Import now turns that text back into a `Date` before parsing, by the same rule an update applies to a stored row: only canonical ISO text (`YYYY-MM-DDTHH:mm:ss.sssZ`, years 0001 to 9999), only where the schema accepts nothing but a `Date` (including inside `.optional()` and similar wrappers, a nested `z.object()` or a `z.array()`). Other text still refuses the row. Under `onUnknownProperty: "allow"` the stored bytes are unchanged and a uniqueness constraint over a date property claims the same key the store's own writes claim.

The `ConfigurationError` for a value that is not JSON, such as a `Map` in a set-update patch or in a durable operation document, no longer says "Annotations must be JSON-serializable" when no annotation is involved; it names the value and the JSON types allowed.
