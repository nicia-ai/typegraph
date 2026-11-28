/**
 * Which uniqueness claims no longer fence the value their holder stores.
 *
 * A claim fences a value only while its key bytes are the ones a create of
 * that value derives, because the claim relation's primary key is what makes
 * two claimants collide. A claim an earlier release keyed in another form (an
 * object in its `.default()` literal's key order, a date under its unquoted
 * ISO text) holds the same value under bytes no create derives, so a create
 * of the value is admitted beside it, and an update that moves no key leaves
 * it alone. Scanning the claim relation alone cannot see this: the stale
 * claim and the duplicate's claim sit on two different rows. Each holder's
 * key is therefore derived again from the row it stores, through the one key
 * owner every write uses ({@link nodeClaimEntries} → `uniqueConstraintKey`),
 * and compared with the claims it holds.
 *
 * This module plans; it writes nothing. `verifyConstraintFences` reports the
 * plan's findings and `repairUniquenessClaims` applies them
 * (`./uniqueness-claim-repair.ts`), so the audit and the repair cannot
 * disagree about what is stale.
 *
 * Reads run through `execute` against the backend's own `tableNames` (the
 * claim relation) and `findNodesByKind` (every node row of a constrained kind,
 * live and soft-deleted, in keyset pages). The claims are read before the
 * nodes: a write that commits between the two reads then shows its row with
 * or without its claims, never claims whose row the audit has not read, so a
 * fresh claim is never mistaken for one whose holder is gone.
 */
import { type GraphBackend, rowPropsToObject } from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { createSqlSchema } from "../../query/compiler/schema";
import { sql } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { type KindRegistry } from "../../registry/kind-registry";
import { groupBy } from "../../utils/array";
import { compareStrings } from "../../utils/compare";
import { encodeTupleKey } from "../../utils/tuple-key";
import { pageNodesByKind } from "../row-fetch";
import {
  type ClaimOwner,
  claimOwnerKey,
  type ClaimTarget,
  DISJOINT_CONSTRAINT_NAME,
  uniquenessProbeKinds,
} from "./axis";
import { isUniquenessClaimEntry, nodeClaimEntries } from "./node-claims";

/** Rows per claim-relation page. */
const CLAIM_PAGE_SIZE = 1000;
/** Node rows per `findNodesByKind` page. */
const NODE_PAGE_SIZE = 500;

/**
 * A live claim whose key is not the one its owner derives today: an old-form
 * key, a claim of a soft-deleted holder, a claim whose `where` predicate no
 * longer holds, or a claim whose holder row is gone. It reserves its bytes
 * for nothing a create derives.
 */
export type UniquenessClaimStaleFinding = Readonly<{
  family: "nodeUniquenessClaimStale";
  /** The stored claim row: its axis and key as they sit in the relation. */
  target: ClaimTarget;
  owner: ClaimOwner;
  /**
   * The key the owner derives for this constraint today, or `undefined` when
   * it owes no live claim (soft-deleted, gone, or its `where` fails).
   */
  expectedKey: string | undefined;
}>;

/**
 * A claim a holder owes and does not hold: a live holder with no live claim
 * of the key it derives (so a create of its value is admitted), or, with
 * `released: true`, a soft-deleted holder whose released claim was keyed in
 * another form, so `getOrCreateByConstraint()` cannot find it to resurrect it.
 */
export type UniquenessClaimMissingFinding = Readonly<{
  family: "nodeUniquenessClaimMissing";
  /** The claim owed: the constraint's axis and the key the owner derives. */
  target: ClaimTarget;
  owner: ClaimOwner;
  /** `true` when the holder is soft-deleted and the owed claim is a released one. */
  released: boolean;
}>;

/** A stale or missing claim. */
export type UniquenessClaimFinding =
  UniquenessClaimStaleFinding | UniquenessClaimMissingFinding;

/**
 * Two or more live nodes that store the same value under one constraint,
 * whatever claims they hold: the duplicates an old-form claim let in.
 */
export type UniquenessValueDuplicate = Readonly<{
  family: "nodeUniqueness";
  /** The claim every holder derives: the constraint's axis and the value's key. */
  target: ClaimTarget;
  owners: readonly ClaimOwner[];
}>;

/** The holder's state, as the planned work needs it. */
type HolderState = "live" | "deleted" | "absent";

/**
 * The claim work one owner's constraint needs. `group` names the constraint
 * at its axis: a duplicate in a group blocks every item of the group.
 */
export type UniquenessClaimWork = Readonly<{
  owner: ClaimOwner;
  constraintName: string;
  group: string;
  /** The constraint's claim axis for the owner's kind. */
  axis: string;
  holder: HolderState;
  /** The key the owner derives, when its `where` holds. */
  derivedKey: string | undefined;
  /** The live claims to release. */
  stale: readonly StoredUniquenessClaim[];
  /** The claim to take, live or released, when one is owed. */
  missing: "live" | "released" | undefined;
}>;

/** What the audit found and what a repair would do about it. */
export type UniquenessClaimPlan = Readonly<{
  work: readonly UniquenessClaimWork[];
  duplicates: readonly (UniquenessValueDuplicate & { group: string })[];
}>;

/** One row of the claim relation. */
export type StoredUniquenessClaim = Readonly<{
  axis: string;
  constraintName: string;
  key: string;
  owner: ClaimOwner;
  released: boolean;
}>;

/** The graph, its registry, and where to read. */
export type UniquenessClaimAuditContext = Readonly<{
  graph: GraphDef;
  registry: KindRegistry;
  graphId: string;
  backend: Pick<GraphBackend, "execute" | "tableNames" | "findNodesByKind">;
}>;

type StoredClaimRow = Readonly<{
  node_kind: string;
  constraint_name: string;
  key: string;
  node_id: string;
  concrete_kind: string;
  released: number | string;
}>;

/** THE identity of a constraint at its axis — what a duplicate blocks. */
function constraintGroup(constraintName: string, axis: string): string {
  return encodeTupleKey([constraintName, axis]);
}

function claimRowIdentity(
  axis: string,
  constraintName: string,
  key: string,
): string {
  return encodeTupleKey([axis, constraintName, key]);
}

/** Every uniqueness claim of the graph, live and released, in keyset pages. */
async function readStoredClaims(
  ctx: UniquenessClaimAuditContext,
): Promise<readonly StoredUniquenessClaim[]> {
  const table = sql.identifier(
    createSqlSchema(ctx.backend.tableNames).tables.uniques,
  );
  const claims: StoredUniquenessClaim[] = [];
  let cursor: StoredUniquenessClaim | undefined;
  for (;;) {
    const after =
      cursor === undefined ?
        sql.empty()
      : sql`AND (node_kind, constraint_name, key) > (${cursor.axis}, ${cursor.constraintName}, ${cursor.key})`;
    const rows = await ctx.backend.execute<StoredClaimRow>(
      asCompiledRowsSql(sql`
        SELECT node_kind, constraint_name, key, node_id, concrete_kind,
          CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS released
        FROM ${table}
        WHERE graph_id = ${ctx.graphId}
          AND constraint_name <> ${DISJOINT_CONSTRAINT_NAME}
          ${after}
        ORDER BY node_kind, constraint_name, key
        LIMIT ${CLAIM_PAGE_SIZE}
      `),
    );
    for (const row of rows) {
      cursor = {
        axis: row.node_kind,
        constraintName: row.constraint_name,
        key: row.key,
        owner: { concreteKind: row.concrete_kind, nodeId: row.node_id },
        released: Number(row.released) === 1,
      };
      claims.push(cursor);
    }
    if (rows.length < CLAIM_PAGE_SIZE) return claims;
  }
}

/** A soft-deleted holder competing to own a released claim nobody holds. */
type ReleasedCandidate = Readonly<{ itemIndex: number; deletedAt: string }>;

/** Mutable while the audit builds it; frozen into {@link UniquenessClaimWork}. */
type WorkDraft = {
  -readonly [K in keyof UniquenessClaimWork]: UniquenessClaimWork[K];
};

/**
 * THE audit: every stale claim, every missing claim, and every value two live
 * holders store under one constraint, for every kind that declares a unique
 * constraint. A graph that declares none reads nothing.
 */
export async function planUniquenessClaimRepair(
  ctx: UniquenessClaimAuditContext,
): Promise<UniquenessClaimPlan> {
  const constrainedKinds = Object.entries(ctx.graph.nodes)
    .filter(([, registration]) => (registration.unique ?? []).length > 0)
    .toSorted(([left], [right]) => compareStrings(left, right));
  if (constrainedKinds.length === 0) return { work: [], duplicates: [] };

  const claims = await readStoredClaims(ctx);
  const claimsByOwner = groupBy(claims, (claim) => claimOwnerKey(claim.owner));
  const claimRows = new Set(
    claims.map((claim) =>
      claimRowIdentity(claim.axis, claim.constraintName, claim.key),
    ),
  );
  const readOwners = new Set<string>();
  const work: WorkDraft[] = [];
  const holdersByValue = new Map<
    string,
    { target: ClaimTarget; group: string; owners: ClaimOwner[] }
  >();
  const releasedCandidates = new Map<string, ReleasedCandidate>();

  for (const [kind, registration] of constrainedKinds) {
    const constraints = registration.unique ?? [];
    const pages = pageNodesByKind(
      ctx.backend,
      { graphId: ctx.graphId, kind, excludeDeleted: false },
      NODE_PAGE_SIZE,
    );
    for await (const page of pages) {
      for (const row of page) {
        const owner: ClaimOwner = { concreteKind: kind, nodeId: row.id };
        const ownerKey = claimOwnerKey(owner);
        readOwners.add(ownerKey);
        const live = row.deleted_at === undefined;
        const derivedKeys = new Map(
          nodeClaimEntries(
            ctx.registry,
            kind,
            row.id,
            rowPropsToObject(row.props),
            constraints,
            "create",
          )
            .filter((entry) => isUniquenessClaimEntry(entry))
            .map((entry) => [entry.constraintName, entry.key] as const),
        );
        const owned = claimsByOwner.get(ownerKey) ?? [];
        for (const constraint of constraints) {
          const probeAxes = uniquenessProbeKinds(
            kind,
            constraint.scope,
            ctx.registry,
          );
          const axis = probeAxes[0] ?? kind;
          const group = constraintGroup(constraint.name, axis);
          const derivedKey = derivedKeys.get(constraint.name);
          const held = owned.filter(
            (claim) => claim.constraintName === constraint.name,
          );
          const stale = held.filter(
            (claim) => !claim.released && (!live || claim.key !== derivedKey),
          );
          let missing: WorkDraft["missing"];
          if (live && derivedKey !== undefined) {
            const target: ClaimTarget = {
              relation: "uniques",
              graphId: ctx.graphId,
              axis,
              constraintName: constraint.name,
              key: derivedKey,
            };
            const valueIdentity = claimRowIdentity(
              axis,
              constraint.name,
              derivedKey,
            );
            const holders = holdersByValue.get(valueIdentity) ?? {
              target,
              group,
              owners: [],
            };
            holders.owners.push(owner);
            holdersByValue.set(valueIdentity, holders);
            const fenced = held.some(
              (claim) =>
                !claim.released &&
                claim.key === derivedKey &&
                probeAxes.includes(claim.axis),
            );
            if (!fenced) missing = "live";
          }
          const item: WorkDraft = {
            owner,
            constraintName: constraint.name,
            group,
            axis,
            holder: live ? "live" : "deleted",
            derivedKey,
            stale,
            missing,
          };
          // A soft-deleted holder whose claims were keyed in another form,
          // and whose value's key no row holds: `getOrCreateByConstraint()`
          // would find it through a released claim of that key, had a delete
          // released one. When several such holders store one value, the
          // last deleted takes it, as a later delete's release would have.
          const releasedOwed =
            !live &&
            derivedKey !== undefined &&
            row.deleted_at !== undefined &&
            held.some((claim) => claim.key !== derivedKey) &&
            !probeAxes.some((probeAxis) =>
              claimRows.has(
                claimRowIdentity(probeAxis, constraint.name, derivedKey),
              ),
            );
          if (releasedOwed) {
            const valueIdentity = claimRowIdentity(
              axis,
              constraint.name,
              derivedKey,
            );
            const incumbent = releasedCandidates.get(valueIdentity);
            const deletedAt = row.deleted_at;
            if (
              incumbent === undefined ||
              compareStrings(deletedAt, incumbent.deletedAt) > 0
            ) {
              releasedCandidates.set(valueIdentity, {
                itemIndex: work.length,
                deletedAt,
              });
            }
          }
          work.push(item);
        }
      }
    }
  }

  for (const candidate of releasedCandidates.values()) {
    const item = work[candidate.itemIndex];
    if (item !== undefined) item.missing = "released";
  }

  // Claims whose holder row no longer exists at all.
  const constraintsByKind = new Map(
    constrainedKinds.map(([kind, registration]) => [
      kind,
      registration.unique ?? [],
    ]),
  );
  for (const [ownerKey, owned] of claimsByOwner) {
    if (readOwners.has(ownerKey)) continue;
    const owner = owned[0]?.owner;
    if (owner === undefined) continue;
    const constraints = constraintsByKind.get(owner.concreteKind) ?? [];
    for (const constraint of constraints) {
      const stale = owned.filter(
        (claim) => !claim.released && claim.constraintName === constraint.name,
      );
      if (stale.length === 0) continue;
      const axis =
        uniquenessProbeKinds(
          owner.concreteKind,
          constraint.scope,
          ctx.registry,
        )[0] ?? owner.concreteKind;
      work.push({
        owner,
        constraintName: constraint.name,
        group: constraintGroup(constraint.name, axis),
        axis,
        holder: "absent",
        derivedKey: undefined,
        stale,
        missing: undefined,
      });
    }
  }

  return {
    work: work.filter(
      (item) => item.stale.length > 0 || item.missing !== undefined,
    ),
    duplicates: [...holdersByValue.values()]
      .filter((holders) => holders.owners.length > 1)
      .map((holders) => ({
        family: "nodeUniqueness" as const,
        target: holders.target,
        group: holders.group,
        owners: holders.owners.toSorted(
          (left, right) =>
            compareStrings(left.concreteKind, right.concreteKind) ||
            compareStrings(left.nodeId, right.nodeId),
        ),
      })),
  };
}

/** The findings one work item reports, unsorted. */
export function uniquenessClaimFindings(
  graphId: string,
  item: UniquenessClaimWork,
): readonly UniquenessClaimFinding[] {
  const stale = item.stale.map((claim): UniquenessClaimStaleFinding => ({
    family: "nodeUniquenessClaimStale",
    target: {
      relation: "uniques",
      graphId,
      axis: claim.axis,
      constraintName: claim.constraintName,
      key: claim.key,
    },
    owner: item.owner,
    expectedKey: item.holder === "live" ? item.derivedKey : undefined,
  }));
  if (item.missing === undefined || item.derivedKey === undefined) return stale;
  return [
    ...stale,
    {
      family: "nodeUniquenessClaimMissing",
      target: {
        relation: "uniques",
        graphId,
        axis: item.axis,
        constraintName: item.constraintName,
        key: item.derivedKey,
      },
      owner: item.owner,
      released: item.missing === "released",
    },
  ];
}
