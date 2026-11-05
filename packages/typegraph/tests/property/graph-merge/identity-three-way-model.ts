/**
 * A reference model of the identity three-way merge, written from the
 * documented rules rather than from `identity-three-way.ts`, so the law suite
 * can compare the merged ledger to an independent expectation instead of only
 * checking that whatever happened was self-consistent.
 *
 * Scope: branch histories of identity writes (assert same/different, retract,
 * import an assertion under a chosen id) and node deletions after the fork,
 * over Agent-only endpoints, so no canonicalization, retyping or same-id fold
 * enters the picture. A deletion reaches the ledger the way a retraction does:
 * the deleting side's rows over the node end at its delete, and those ends
 * are staged like any other. Inside that scope the model decides, from the
 * ledgers each side holds at merge time:
 *
 *  - STAGING: each side's change since the fork — on an incremental merge the
 *    advanced target is a side too, so its own new rows meet the branches'.
 *  - REFUSAL: opposing relations staged for one pair with overlapping windows;
 *    a retract/reassert race (the branches retracting a pair are not exactly
 *    the branches reasserting it with a current row); one id staged for two
 *    truths, or a surviving id the target holds with other truth; or a merged
 *    ledger — the target's own history included — that, at some instant,
 *    holds two nodes both same and different.
 *  - DELETION: a surviving current assertion over a node the merge deletes is
 *    refused; an ended one lands as history, unless the advanced target is
 *    the side that deleted the node and does not already hold the row.
 *  - SURVIVOR: per dedupe group, an id the target already holds with the exact
 *    staged truth, else the earliest `validFrom`, ties to the smaller id.
 *  - RETRACTION: a target row several branches ended ends at the EARLIEST of
 *    their instants.
 *  - RESULT: the target's current rows minus the retracted ones, plus every
 *    current survivor; bounded survivors land as history rows.
 */

type ModelRef = Readonly<{ kind: string; id: string }>;

export type ModelRow = Readonly<{
  id: string;
  relation: "same" | "different";
  a: ModelRef;
  b: ModelRef;
  validFrom: string;
  validTo?: string | undefined;
}>;

type ModelSide = Readonly<{
  branchId: string;
  /** Every tracked row the side holds, ended rows included. */
  rows: ReadonlyMap<string, ModelRow>;
  /** The nodes the side deleted since the fork. */
  deleted: readonly ModelRef[];
  /** True for the advanced target of an incremental merge. */
  isTarget: boolean;
}>;

export type ModelInput = Readonly<{
  /** The fork point's rows — the ancestor every side is diffed against. */
  fork: ReadonlyMap<string, ModelRow>;
  /** The merge target's rows (the fork point itself on a snapshot merge). */
  target: ReadonlyMap<string, ModelRow>;
  /**
   * The sides whose changes since the fork are staged: the branches, plus —
   * on an incremental merge — the advanced target itself.
   */
  sides: readonly ModelSide[];
}>;

/**
 * The rule a refusal comes from, in the order the merge applies them: the
 * three-way classifier's opposing-relations, race and one-id-one-truth checks,
 * then a survivor over a deleted node, then the merged-ledger contradiction,
 * then a surviving id the target already holds with other truth.
 */
export type ModelRefusalRule =
  | "opposing"
  | "race"
  | "one-id-two-truths"
  | "deleted-endpoint"
  | "contradiction"
  | "id-held-other-truth";

export type ModelVerdict =
  | Readonly<{ kind: "refused"; rule: ModelRefusalRule; reason: string }>
  | Readonly<{
      kind: "merged";
      /** The current rows after the merge, by id. */
      current: ReadonlyMap<string, ModelRow>;
      /** Target rows the merge ends, with the instant each must end at. */
      ended: ReadonlyMap<string, string>;
      /** Bounded survivors the merge must carry as history, by id. */
      history: ReadonlyMap<string, ModelRow>;
      /** Ids reported dropped as duplicates. */
      duplicates: ReadonlySet<string>;
    }>
  /** The model makes no claim about this shape (see the reason). */
  | Readonly<{ kind: "undetermined"; reason: string }>;

function refKey(ref: ModelRef): string {
  return `${ref.kind}\u0000${ref.id}`;
}

function pairKey(row: ModelRow): string {
  const [first, second] = [refKey(row.a), refKey(row.b)].toSorted();
  return `${first}\u0001${second}`;
}

function semanticKey(row: ModelRow): string {
  return `${row.relation}\u0002${pairKey(row)}`;
}

function dedupeKey(row: ModelRow): string {
  return row.validTo === undefined ?
      semanticKey(row)
    : `${semanticKey(row)}\u0002${row.validFrom}\u0002${row.validTo}`;
}

function truthKey(row: ModelRow): string {
  return JSON.stringify([
    row.relation,
    pairKey(row),
    row.validFrom,
    row.validTo ?? null,
  ]);
}

/** Everything but `validTo`: a retraction changes only the end. */
function identityKey(row: ModelRow): string {
  return JSON.stringify([row.relation, pairKey(row), row.validFrom]);
}

function isCurrent(row: ModelRow): boolean {
  return row.validTo === undefined;
}

/** Half-open `[validFrom, validTo)` windows; an empty window overlaps nothing. */
function windowsOverlap(left: ModelRow, right: ModelRow): boolean {
  const leftEnd = left.validTo ?? "￿";
  const rightEnd = right.validTo ?? "￿";
  if (left.validFrom >= leftEnd || right.validFrom >= rightEnd) return false;
  return left.validFrom < rightEnd && right.validFrom < leftEnd;
}

/** The first `different` that some `same` chain joins at one instant, if any. */
function contradiction(rows: readonly ModelRow[]): string | undefined {
  for (const instant of new Set(rows.map((row) => row.validFrom))) {
    const holding = rows.filter(
      (row) =>
        row.validFrom <= instant &&
        (row.validTo === undefined || instant < row.validTo),
    );
    const violated = contradictionAmong(holding);
    if (violated !== undefined) return `${violated} at ${instant}`;
  }
  return undefined;
}

function contradictionAmong(rows: readonly ModelRow[]): string | undefined {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while ((parent.get(root) ?? root) !== root) {
      root = parent.get(root) ?? root;
    }
    return root;
  };
  for (const row of rows) {
    if (row.relation === "same")
      parent.set(find(refKey(row.a)), find(refKey(row.b)));
  }
  const violated = rows.find(
    (row) =>
      row.relation === "different" &&
      find(refKey(row.a)) === find(refKey(row.b)),
  );
  return violated?.id;
}

type Staged = Readonly<{ branchId: string; row: ModelRow }>;
type StagedEnd = Readonly<{ branchId: string; row: ModelRow; end: string }>;

function stage(input: ModelInput): Readonly<{
  staged: readonly Staged[];
  ends: readonly StagedEnd[];
}> {
  const staged: Staged[] = [];
  const ends: StagedEnd[] = [];
  for (const side of input.sides) {
    for (const row of side.rows.values()) {
      const ancestor = input.fork.get(row.id);
      if (ancestor !== undefined && truthKey(ancestor) === truthKey(row)) {
        continue;
      }
      if (
        ancestor !== undefined &&
        isCurrent(ancestor) &&
        row.validTo !== undefined &&
        identityKey(ancestor) === identityKey(row)
      ) {
        ends.push({ branchId: side.branchId, row: ancestor, end: row.validTo });
        continue;
      }
      // A window that closed at the instant it opened never held: there is
      // nothing for the merge to carry.
      if (row.validTo === row.validFrom) continue;
      // Anything else the branch changed — a fresh id, or an id the ancestor
      // had already ended that the branch re-opened — is a staged assertion.
      staged.push({ branchId: side.branchId, row });
    }
  }
  return { staged, ends };
}

type Refusal = Readonly<{ rule: ModelRefusalRule; reason: string }>;

function opposingRefusal(staged: readonly Staged[]): Refusal | undefined {
  for (const left of staged) {
    for (const right of staged) {
      if (left.row.relation !== "same" || right.row.relation !== "different") {
        continue;
      }
      if (pairKey(left.row) !== pairKey(right.row)) continue;
      if (windowsOverlap(left.row, right.row)) {
        return {
          rule: "opposing",
          reason: `opposing ${left.row.id} / ${right.row.id}`,
        };
      }
    }
  }
  return undefined;
}

function raceRefusal(
  staged: readonly Staged[],
  ends: readonly StagedEnd[],
): Refusal | undefined {
  const keys = new Set(ends.map((entry) => semanticKey(entry.row)));
  for (const key of keys) {
    const retracting = new Set(
      ends
        .filter((entry) => semanticKey(entry.row) === key)
        .map((entry) => entry.branchId),
    );
    const reasserting = new Set(
      staged
        .filter(
          (entry) => isCurrent(entry.row) && semanticKey(entry.row) === key,
        )
        .map((entry) => entry.branchId),
    );
    if (reasserting.size === 0) continue;
    const agree =
      retracting.size === reasserting.size &&
      [...retracting].every((branchId) => reasserting.has(branchId));
    if (!agree) return { rule: "race", reason: `race on ${key}` };
  }
  return undefined;
}

function oneIdOneTruthRefusal(staged: readonly Staged[]): Refusal | undefined {
  const truthById = new Map<string, string>();
  for (const { row } of staged) {
    const previous = truthById.get(row.id);
    if (previous !== undefined && previous !== truthKey(row)) {
      return {
        rule: "one-id-two-truths",
        reason: `id ${row.id} staged for two truths`,
      };
    }
    truthById.set(row.id, truthKey(row));
  }
  return undefined;
}

function deletedEndpointRefusal(
  input: ModelInput,
  survivors: readonly ModelRow[],
  committed: (row: ModelRow) => boolean,
): Refusal | undefined {
  const deleted = new Set(
    input.sides.flatMap((side) => side.deleted.map((ref) => refKey(ref))),
  );
  const targetDeleted = new Set(
    input.sides
      .filter((side) => side.isTarget)
      .flatMap((side) => side.deleted.map((ref) => refKey(ref))),
  );
  for (const survivor of survivors) {
    for (const endpoint of [survivor.a, survivor.b]) {
      const key = refKey(endpoint);
      if (!deleted.has(key)) continue;
      if (!isCurrent(survivor) && !targetDeleted.has(key)) continue;
      if (!isCurrent(survivor) && committed(survivor)) continue;
      return {
        rule: "deleted-endpoint",
        reason: `survivor ${survivor.id} names deleted ${endpoint.id}`,
      };
    }
  }
  return undefined;
}

export function modelIdentityThreeWay(input: ModelInput): ModelVerdict {
  const { staged, ends } = stage(input);
  const refusal =
    opposingRefusal(staged) ??
    raceRefusal(staged, ends) ??
    oneIdOneTruthRefusal(staged);
  if (refusal !== undefined) return { kind: "refused", ...refusal };

  const committed = (row: ModelRow): boolean => {
    const held = input.target.get(row.id);
    return held !== undefined && truthKey(held) === truthKey(row);
  };
  const groups = new Map<string, ModelRow[]>();
  for (const { row } of staged) {
    const group = groups.get(dedupeKey(row)) ?? [];
    group.push(row);
    groups.set(dedupeKey(row), group);
  }
  const survivors: ModelRow[] = [];
  const duplicates = new Set<string>();
  for (const group of groups.values()) {
    const ranked = group.toSorted((left, right) => {
      if (committed(left) !== committed(right)) return committed(left) ? -1 : 1;
      if (left.validFrom !== right.validFrom) {
        return left.validFrom < right.validFrom ? -1 : 1;
      }
      return (
        left.id < right.id ? -1
        : left.id > right.id ? 1
        : 0
      );
    });
    const survivor = ranked[0];
    if (survivor === undefined) continue;
    survivors.push(survivor);
    for (const loser of ranked.slice(1)) {
      if (truthKey(loser) === truthKey(survivor) && loser.id === survivor.id) {
        continue;
      }
      duplicates.add(loser.id);
    }
  }
  const deletedRefusal = deletedEndpointRefusal(input, survivors, committed);
  if (deletedRefusal !== undefined)
    return { kind: "refused", ...deletedRefusal };
  const endedAt = new Map<string, string>();
  for (const entry of ends) {
    const held = input.target.get(entry.row.id);
    if (held === undefined) {
      return {
        kind: "undetermined",
        reason: `retraction of ${entry.row.id}, which the target does not hold`,
      };
    }
    // A retraction of a row the target already ended ends no current row: the
    // row keeps the target's own end.
    if (!isCurrent(held)) continue;
    const previous = endedAt.get(entry.row.id);
    if (previous === undefined || entry.end < previous) {
      endedAt.set(entry.row.id, entry.end);
    }
  }

  const current = new Map<string, ModelRow>();
  for (const row of input.target.values()) {
    if (isCurrent(row) && !endedAt.has(row.id)) current.set(row.id, row);
  }
  const heldSemantics = new Set(
    [...current.values()].map((row) => semanticKey(row)),
  );
  const history = new Map<string, ModelRow>();
  for (const survivor of survivors) {
    if (!isCurrent(survivor)) {
      history.set(survivor.id, survivor);
      continue;
    }
    if (current.has(survivor.id)) continue;
    // No side can restate a pair the target still holds without retracting
    // it first (the store answers `existing`), so this arm only guards the
    // model's own assumptions.
    if (heldSemantics.has(semanticKey(survivor))) {
      return {
        kind: "undetermined",
        reason: `survivor ${survivor.id} restates a pair the target holds under another id`,
      };
    }
    current.set(survivor.id, survivor);
  }
  // The target's history is part of the ledger the merge leaves behind: rows
  // it had already ended, and the rows this merge ends, at their new end.
  const targetHistory = [...input.target.values()].flatMap((row) => {
    if (!isCurrent(row)) return [row];
    const end = endedAt.get(row.id);
    return end === undefined ? [] : [{ ...row, validTo: end }];
  });
  const contradicted = contradiction([
    ...current.values(),
    ...history.values(),
    ...targetHistory,
  ]);
  if (contradicted !== undefined) {
    return {
      kind: "refused",
      rule: "contradiction",
      reason: `merged ledger contradicts itself at ${contradicted}`,
    };
  }
  for (const survivor of survivors) {
    const held = input.target.get(survivor.id);
    if (held !== undefined && truthKey(held) !== truthKey(survivor)) {
      return {
        kind: "refused",
        rule: "id-held-other-truth",
        reason: `survivor ${survivor.id} names other target truth`,
      };
    }
  }
  return { kind: "merged", current, ended: endedAt, history, duplicates };
}
