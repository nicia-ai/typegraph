---
"@nicia-ai/typegraph": minor
---

A uniqueness claim is now released by the node that holds it, and a claim taken from a stored row is keyed from the value the row stores, with its date text read back as a `Date`. A write keyed its claim from the props it validated, where a date is a `Date` (keyed as its JSON-quoted ISO text), but an update, a soft delete and several batch and lookup paths keyed the row they read back, where the same date is unquoted ISO text and a PostgreSQL `jsonb` object has its keys reordered. The release then named a claim the write never took: the old value stayed reserved, a later create of it was refused with a `UniquenessError` naming a node that no longer held it, and `findByConstraint()` / `getOrCreateByConstraint()` could answer with that node. This held for every update that changed a unique date (`update()`, `upsertById()`, `bulkUpsertById()`, `bulkReplaceById()`, an import under `onConflict: "update"`), for a soft delete wherever it released per key, and for a date behind `z.lazy()` or inside a union with `null`.

Every update, soft delete, resurrection, upsert, set update, batch write, import update, merge apply and provenance close or reopen now gives back "the claims this node holds for this constraint" (for an update, those other than the key it now claims), selected by owner, never a key recomputed from the before-image. A claim keyed in any other form, such as a raw-text date or an object in another key order, is released by the same statement.

A claim is keyed from the value the row stores. A write that validated its props keys them, as before. A path that has only a stored row (the row an update replaces, a tombstone that `getOrCreateByConstraint()` or a provenance reopen revives, a merge's after-image and its probes, graph-merge blocking signatures) keys the stored props with their `z.date()` text revived to a `Date`, the one place a stored value and its validated form differ, and never parses them through the schema again: a schema whose parse does not reproduce its own output (a transform that appends to its input) would key a value the row does not hold. An import under `onUnknownProperty: "allow"` writes the document's properties verbatim and keys its claims from that written value the same way. A `Date` keys exactly as before, so claims written by `create()` keep matching.

An update compares, per constraint, the key the row holds as stored with the key of the props it is about to write, and touches only the constraints where the key or whether the constraint applies differs. An update that moves no key issues no claim statement, whichever fields it names, as before this change. Comparing keys rather than the fields a patch names matters because an update parses and rewrites the whole props object: under a transform, a field the patch does not name still changes value, and its claim moves with it.

`releaseUniquesByOwner` on the bundled backends splits a release into statements by constraint under the backend's declared bind budget, and lists the kept claims as one flat row-value list, so a write moving many constraints neither exceeds a 100-bind limit nor nests the predicate past SQLite's expression-depth limit.

### Upgrade notes

- **A hand-written backend must implement `releaseUniquesByOwner`** (#1011). `GraphBackend.releaseUniquesByOwner(params: ReleaseUniquesByOwnerParams): Promise<void>` is a new required member of the custom-backend contract, on the root backend and on every `TransactionBackend` it hands out; a backend object without it no longer type-checks. Backends built by the bundled factories implement it, and no schema change is needed. A hand-assembled SQL operation strategy must likewise supply `CommonOperationStrategy.buildReleaseUniquesByOwner(params, timestamp)`; the bundled backend sizes each call it makes to that builder to its bind budget. The contract:
  - **What it deletes:** every live (`deleted_at` unset) uniqueness entry with the given `graphId` whose owner is `(concreteKind, nodeId)` and whose constraint is one of `constraintNames`, at every axis (`node_kind`), except an entry whose `(constraintName, key)` pair is listed in `keep`. Match on owner and constraint only; compare no key other than those in `keep`, and never touch another owner's entry.
  - **How:** tombstone the entry (set `deleted_at`), as `deleteUnique` does. It must stop being returned by `checkUnique` and still be returned, with its key and owner, under `includeDeleted`, because `getOrCreateByConstraint()` finds a soft-deleted node through it.
  - **Where:** on the target the store calls it on. Inside a write that is the frame's `TransactionBackend`, so the statement commits or rolls back with the row write it follows.
  - **Size:** split a release your engine cannot bind in one statement by constraint, keeping each constraint's `keep` entries in the statement that names it.
  - **Returns:** nothing; the store ignores the value. A release that matches no entry succeeds.
  - **Idempotent:** a second call with the same params changes nothing. An empty `constraintNames` releases nothing and needs no statement.

  A reference implementation over one SQL table with the bundled column names, where `execute` runs on the connection the member is called on (`$n` placeholders; adapt them to your driver):

  ```typescript
  import type { GraphBackend } from "@nicia-ai/typegraph/backend";

  type Execute = (sql: string, parameters: readonly unknown[]) => Promise<void>;

  function releaseUniquesByOwnerOn(
    execute: Execute,
  ): GraphBackend["releaseUniquesByOwner"] {
    return async (params) => {
      if (params.constraintNames.length === 0) return;
      const parameters: unknown[] = [
        new Date().toISOString(),
        params.graphId,
        params.concreteKind,
        params.nodeId,
      ];
      const bind = (value: unknown): string => {
        parameters.push(value);
        return `$${parameters.length}`;
      };
      const constraints = params.constraintNames.map((name) => bind(name));
      const kept = params.keep.map(
        (claim) => `(${bind(claim.constraintName)}, ${bind(claim.key)})`,
      );
      const keepTerm =
        kept.length === 0 ? "" : (
          ` AND (constraint_name, key) NOT IN (VALUES ${kept.join(", ")})`
        );
      await execute(
        `UPDATE typegraph_node_uniques SET deleted_at = $1
          WHERE graph_id = $2 AND concrete_kind = $3 AND node_id = $4
            AND deleted_at IS NULL
            AND constraint_name IN (${constraints.join(", ")})${keepTerm}`,
        parameters,
      );
    };
  }
  ```

  Index `(graph_id, concrete_kind, node_id)` so the statement does not scan; the bundled schema already has that index. The store now calls `deleteUnique` only to undo a claim a failed write just took, always with `nodeKind`. See "Releasing claims by owner" in the backend-authoring guide.
- **Statement cost of a node write on a kind with a unique constraint.** An update (`update()`, `upsertById()`, an import under `onConflict: "update"`) issues no claim statement for a constraint whose key it does not move, as before. For each constraint whose key moves, it probes the new key once and claims it, and then issues one release statement covering all of those constraints, where before it issued one release per key. A resurrection issues one more release statement. A soft delete issues one release statement instead of one per claim, and no longer re-reads the row after its tombstone. A probe that finds the node's own key held by another node (a duplicate an earlier release let in) refuses the update with `UniquenessError`.
- Not repaired: a claim an earlier release left keyed in another form does not collide with a new claim of the same value. A database written by an import under `onUnknownProperty: "allow"`, or by a provenance revival, before this release can hold a date claim under its unquoted ISO text, and a create of the same date is then admitted beside it. An update that leaves the key where it was leaves such a claim as it is, even when it restates the field. To re-key it, move the holder's value off and back (two updates); the update back claims the value as a create does and refuses with `UniquenessError` when a duplicate was already admitted, in which case resolve the duplicate, for example by hard-deleting one of the two nodes, and update the holder again. Until a holder is re-keyed, `getOrCreateByConstraint()` does not resurrect a soft-deleted holder whose released claim has the other form; it creates a new node.
- Not repaired: a date the stored-props reading cannot reach, under `z.lazy()`, a union, or a pipe such as `z.string().pipe(z.coerce.date())`, keys a stored row from its ISO text, while a create keys the `Date`. Such a value imported under `"allow"`, or revived by a provenance reopen, holds a text-keyed claim that a create of the same date does not collide with, and `getOrCreateByConstraint()` creates a new node rather than resurrecting a soft-deleted holder of it. Releases are unaffected.
- Not repaired: `getOrCreateByConstraint()` and `bulkGetOrCreateByConstraint()` with `ifExists: "update"`, or resurrecting a match, hand the matched row the props the lookup validated, which the update parses again as input. A schema whose parse does not accept its own output refuses (`z.string().pipe(z.coerce.date())`), and one that does not reproduce it stores the value parsed twice. This is unchanged from earlier releases.
- Not repaired: an import under `"allow"` keys a node's claims and an edge's match identity from the document's text, so a value whose parse differs from its text keys as the text: an object-valued unique property exported from PostgreSQL (in `jsonb` key order) does not collide with a create of the value, and an edge identity field given `"REF"` under `z.string().toLowerCase()` admits a create of `"REF"` (identity `"ref"`) as a second edge. A later `update()` of such an edge re-validates the row and is refused with `ValidationError` as a change of an identity field. This is unchanged from earlier releases.
- Not repaired: a unique value whose validated key order follows its input (a `z.record()`, or the extra keys of a `z.looseObject()`) keys differently when two writers state its keys in different orders. On PostgreSQL an export and import of such a value is one such pair, because `jsonb` returns the keys in its own order: the imported claim does not collide with a create of the value in its original order. Declare unique constraints over `z.object()` values, whose validated keys follow the schema, or over scalars.
