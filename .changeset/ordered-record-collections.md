---
"@nicia-ai/typegraph": minor
---

Add ordered record collections with `expr.collect({ field: scalarExpression }, { orderBy, filter })`. Explicit flat record projections retain named scalar fields, decode Date and Boolean values, and preserve admitted SQL NULL fields as `undefined`. Record collections work through relation composition, prepared execution, and `batchOnce()`.

Custom `DialectAdapter` implementations must add the required `orderedRecordJsonArray` method when upgrading. This method emits the ordered, optionally filtered JSON record aggregate and returns `[]` for empty input.

Consumers inspecting expression ASTs must narrow `CollectExpressionNode.operand`: it can now be a scalar expression or a `CollectRecordOperand` with `kind: "record"` and named `fields`.
