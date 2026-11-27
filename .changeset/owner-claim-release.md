---
"@nicia-ai/typegraph": minor
---

A uniqueness claim is now released by the node that holds it, and its key is derived from validated props only. A write keyed its claim from the props it validated, where a date is a `Date` (keyed as its JSON-quoted ISO text), but an update, a soft delete and several batch and lookup paths keyed the row they read back, where the same date is unquoted ISO text and a PostgreSQL `jsonb` object has its keys reordered. The release then named a claim the write never took: the old value stayed reserved, a later create of it was refused with a `UniquenessError` naming a node that no longer held it, and `findByConstraint()` / `getOrCreateByConstraint()` could answer with that node. This held for every update that changed a unique date (`update()`, `upsertById()`, `bulkUpsertById()`, `bulkReplaceById()`, an import under `onConflict: "update"`), for a soft delete wherever it released per key, and for a date behind `z.lazy()` or inside a union with `null`, which no schema reading could see.

Every update, soft delete, resurrection, upsert, set update, batch write, import update, merge apply and provenance close or reopen now gives back "the claims this node holds for this constraint" (for an update, those other than the key it now claims), selected by owner, never a key recomputed from the before-image. A claim keyed in any other form — a raw-text date, an object in another key order — is released by the same statement. Keys are computed by the one key function from validated props on every path that claims or looks up: create, upsert, the update after-image, import under every `onUnknownProperty` mode (under `"allow"` the document's properties are still written verbatim, and the claim is keyed from the value the schema produced), the set-update rebuild, merge apply, resurrection, `getOrCreateByConstraint()`, `findByConstraint()` and graph-merge blocking signatures. A path that has only the stored row (provenance revival, a lookup asking whether a released claim's node still holds the key, a merge plan's probe) validates it through the kind's schema first. A `Date` keys exactly as before, so claims written by `create()` keep matching.

Also fixed: `getOrCreateByConstraint()` and `bulkGetOrCreateByConstraint()` with `ifExists: "update"`, or resurrecting a soft-deleted match, re-parsed the already validated value through the schema, which a schema whose input differs from its output refuses (`z.string().pipe(z.coerce.date())` takes text and yields a `Date`); the update leg now merges the caller's own props, as `update()` does. An import under `onUnknownProperty: "allow"` of an object-valued unique property no longer admits a duplicate of a create on PostgreSQL. An edge imported under `"allow"` now holds its match identity keyed from the schema's parse of its properties, as a create keys it, while its properties are still written verbatim: an identity field whose validated value differs from the document's text (`z.string().toLowerCase()` given `"REF"`) no longer lets a create of the same value in beside it as a second edge. Graph merge reads a candidate edge's identity the same way.

An `update()` whose patch states no field a unique constraint reads (its `fields`, or the field its `where` tests) cannot change that constraint's key or whether it applies, so it now leaves the constraint's claim alone and issues no statement for it, exactly as before this change.

### Upgrade notes

- **A hand-written backend must implement `releaseUniquesByOwner`** (#1011). `GraphBackend.releaseUniquesByOwner(params: ReleaseUniquesByOwnerParams): Promise<void>` is a new required member of the custom-backend contract, on the root backend and on every `TransactionBackend` it hands out; a backend object without it no longer type-checks. Backends built by the bundled factories implement it, and no schema change is needed. A hand-assembled SQL operation strategy must likewise supply `CommonOperationStrategy.buildReleaseUniquesByOwner(params, timestamp)`. The contract:
  - **What it deletes:** every live (`deleted_at` unset) uniqueness entry with the given `graphId` whose owner is `(concreteKind, nodeId)` and whose constraint is one of `constraintNames`, at every axis (`node_kind`), except an entry whose `(constraintName, key)` pair is listed in `keep`. Match on owner and constraint only; compare no key other than those in `keep`, and never touch another owner's entry.
  - **How:** tombstone the entry (set `deleted_at`), as `deleteUnique` does. It must stop being returned by `checkUnique` and still be returned, with its key and owner, under `includeDeleted`, because `getOrCreateByConstraint()` finds a soft-deleted node through it.
  - **Where:** on the target the store calls it on. Inside a write that is the frame's `TransactionBackend`, so the statement commits or rolls back with the row write it follows.
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
        (claim) =>
          ` AND NOT (constraint_name = ${bind(claim.constraintName)} AND key = ${bind(claim.key)})`,
      );
      await execute(
        `UPDATE typegraph_node_uniques SET deleted_at = $1
          WHERE graph_id = $2 AND concrete_kind = $3 AND node_id = $4
            AND deleted_at IS NULL
            AND constraint_name IN (${constraints.join(", ")})${kept.join("")}`,
        parameters,
      );
    };
  }
  ```

  Index `(graph_id, concrete_kind, node_id)` so the statement does not scan; the bundled schema already has that index. The store now calls `deleteUnique` only to undo a claim a failed write just took, always with `nodeKind`. See "Releasing claims by owner" in the backend-authoring guide.
- **Statement cost of a node write on a kind with a unique constraint.** An `update()` whose patch states no field a constraint reads issues no claim statement for it, as before. For each constraint whose fields (or `where` field) the patch states, the update probes its key once and claims it when it changed, and the update then issues one release statement covering all of those constraints. A wholesale replacement (`bulkReplaceById()`, an import under `onConflict: "update"`) treats every constraint as stated. A key change therefore costs what it cost before (probe, claim, release). A patch that restates a constrained field with its current value, or a replacement that keeps the key, now costs one probe per constraint and one release, where before it cost nothing. A resurrection issues one more release statement. A soft delete issues one release statement instead of one per claim, and no longer re-reads the row after its tombstone. A probe that finds the node's own key held by another node (a duplicate an earlier release let in) refuses the update with `UniquenessError`.
- A provenance reopen now validates the stored props of the fact it revives before keying its claims, and refuses with `ValidationError` when they no longer validate. The row is still written back exactly as stored.
- Not repaired: a claim an earlier release left keyed in another form does not collide with a new claim of the same value. A database written by an import under `onUnknownProperty: "allow"`, or by a provenance revival, before this release can hold a date claim under its unquoted ISO text, and a create of the same date is then admitted beside it. An update that states the constrained field, even with its current value (for example `update(id, { at: node.at })`), re-keys its claim from validated props and surfaces such a duplicate as a `UniquenessError`; resolve the duplicate, for example by hard-deleting one of the two nodes, and update the owner again. An update whose patch states no constrained field leaves the claim as it is. Until a holder is re-keyed, `getOrCreateByConstraint()` does not resurrect a soft-deleted holder whose released claim has the other form; it creates a new node.
- Not repaired: a unique value whose validated key order follows its input (a `z.record()`, or the extra keys of a `z.looseObject()`) keys differently when two writers state its keys in different orders. On PostgreSQL an export and import of such a value is one such pair, because `jsonb` returns the keys in its own order: the imported claim does not collide with a create of the value in its original order. Declare unique constraints over `z.object()` values, whose validated keys follow the schema, or over scalars.
- Not repaired: an edge imported under `"allow"` whose identity field's document text differs from its validated value keeps the text in its row, and an `update()` of that edge re-validates the row and is refused with `ValidationError` as a change of an identity field. This is unchanged from earlier releases.
