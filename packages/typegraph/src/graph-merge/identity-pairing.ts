/**
 * The identity SEPARATION VETO — the plan-time half of identity reconciliation.
 *
 * A `store.identity.assertDifferent(a, b)` is an integrity fact, not a recall
 * heuristic, so the veto is ON for every identity-enabled merge regardless of
 * `identity.pairing`. Without it a candidate match between two entities the
 * ledger holds apart survives planning and dies in the commit on the
 * separation relation's ordered-pair CHECK — a constraint violation at the
 * wrong phase, naming table columns rather than the two entities and the
 * assertions that separated them.
 *
 * The facts are captured ONCE, before planning, from the merge target's own
 * identity context, and consumed by three application points that all read
 * this single fact set:
 *
 *   1. the candidate-edge veto, which DROPS a scored edge (recall the ledger
 *      forbids) and reports it as a typed `separation` conflict;
 *   2. the surviving-edge refusal, which fails the plan on a DEFINITIONAL edge
 *      that outlived the base and diameter guards; and
 *   3. the post-cluster assertion, which catches a TRANSITIVE fusion — `a`–`b`
 *      and `b`–`c` each clearing the threshold while `a` and `c` are held
 *      apart, so no single candidate edge is separated yet the cluster fuses
 *      all three.
 *
 * Points 2 and 3 run AFTER the guards on purpose. A forced base pairing whose
 * component the base guard severs never fuses anything, so refusing it up
 * front would fail a merge that is harmless; only an edge (or a cluster) that
 * survives the guards can actually collapse two separated classes.
 *
 * Capturing once is what lets the later points stay synchronous inside plan
 * construction, and what makes it structurally impossible for them to
 * disagree.
 *
 * ONE OWNER. The class-lifted `different` decision is `bulkIsSeparated`
 * (`src/identity/separation.ts`) — this module resolves each participant to its
 * current identity class and asks that one predicate, never its own SQL and
 * never a re-derivation of what "class-lifted difference" means.
 */
import type { MergeKey } from "./node-key";
import { compareStrings, idOf, kindOf } from "./node-key";
import type { GraphDef, PlainNodeRef, Store } from "./typegraph-internal";
import {
  bulkIsSeparated,
  currentClassKey,
  identityReferenceKeyOf,
  loadCurrentStructuralClasses,
  loadSpanningDifferentAssertion,
  storeRuntime,
} from "./typegraph-internal";

/**
 * The separation facts one merge plan is judged against: each candidate
 * participant's current identity CLASS key, and the ordered class-key pairs the
 * ledger holds as `different`.
 *
 * Evidence bound to the resource that earned it: both halves come from the
 * merge target's own identity context, read before planning, and are consumed
 * only by that plan.
 */
export type IdentitySeparationFacts = Readonly<{
  /** Class key per candidate participant, from the target's current closure. */
  classKeyOf: ReadonlyMap<MergeKey, string>;
  /** NUL-joined, code-point-ordered class-key pairs the relation separates. */
  separatedClassPairs: ReadonlySet<string>;
  /**
   * For each separated pair, the `different` assertion the ledger holds across
   * it — the WITNESS a refusal names, so a caller reads WHICH assertion forbade
   * the match rather than only that something did. Resolved eagerly, but only
   * for the pairs the probe actually reported separated: a separation among
   * fusion candidates is an exceptional state, never the steady one.
   */
  separatingAssertionIdOf: ReadonlyMap<string, string>;
}>;

/** The empty facts an identity-disabled graph is judged against: nothing is separated. */
export const NO_IDENTITY_SEPARATION_FACTS: IdentitySeparationFacts = {
  classKeyOf: new Map(),
  separatedClassPairs: new Set(),
  separatingAssertionIdOf: new Map(),
};

/**
 * The single spelling of an ordered class-key pair, shared by the capture and
 * every lookup so the two can never key the same separation differently. NUL
 * joins the halves: a class key is JSON, which escapes NUL, so no two distinct
 * pairs can collide on the joined string.
 */
function classPairKey(first: string, second: string): string {
  return compareStrings(first, second) <= 0 ?
      `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}

/**
 * Every distinct unordered pair of participants that could FUSE, grouped so the
 * probe stays bounded by what the plan can actually merge.
 *
 * A merge only ever fuses within a connected component of the candidate-edge
 * graph, and the base/diameter guards only SPLIT components further — so the
 * within-group pairs are a superset of every pair the plan can put in one
 * cluster, and a strict subset of the quadratic all-participants enumeration.
 */
function fusionPairs(
  groups: readonly (readonly MergeKey[])[],
  classKeyOf: ReadonlyMap<MergeKey, string>,
): readonly Readonly<{ first: string; second: string }>[] {
  const seen = new Set<string>();
  const pairs: Readonly<{ first: string; second: string }>[] = [];
  for (const group of groups) {
    for (const [index, left] of group.entries()) {
      for (const right of group.slice(index + 1)) {
        const first = classKeyOf.get(left);
        const second = classKeyOf.get(right);
        if (first === undefined || second === undefined) continue;
        if (first === second) continue;
        const key = classPairKey(first, second);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ first, second });
      }
    }
  }
  return pairs;
}

/**
 * Resolves every candidate participant to its current identity class and asks
 * {@link bulkIsSeparated} which of the pairs the plan could fuse are held
 * apart.
 *
 * `groups` are the participant sets a fusion could occur WITHIN — the connected
 * components of the candidate-edge graph. Passing the flat participant list as
 * one group is correct but quadratic; passing the components keeps the probe
 * proportional to what the plan can actually merge.
 *
 * @throws {ConfigurationError} `IDENTITY_STORAGE_MISSING` when the separation
 * relation this graph's veto reads has never been provisioned or filled —
 * `bulkIsSeparated`'s refusal, surfaced here rather than answered "not
 * separated".
 */
export async function captureIdentitySeparationFacts<G extends GraphDef>(
  target: Store<G>,
  groups: readonly (readonly MergeKey[])[],
): Promise<IdentitySeparationFacts> {
  const participants = [...new Set(groups.flat())];
  if (participants.length === 0) return NO_IDENTITY_SEPARATION_FACTS;
  const ctx = storeRuntime(target).identityContext();
  const classes = await loadCurrentStructuralClasses(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    participants.map((key) => ({ kind: kindOf(key), id: idOf(key) })),
  );
  const classKeyOf = new Map<MergeKey, string>();
  const membersByClassKey = new Map<string, readonly PlainNodeRef[]>();
  for (const key of participants) {
    const ref = { kind: kindOf(key), id: idOf(key) };
    // `loadCurrentStructuralClasses` keys on the identity module's OWN
    // reference key — reached here rather than re-spelled — and coalesces an
    // unclosed node onto itself, so a node belonging to no class is still
    // answered, as its own singleton class.
    const members = classes.get(identityReferenceKeyOf(ref)) ?? [ref];
    const classKey = currentClassKey(members);
    classKeyOf.set(key, classKey);
    membersByClassKey.set(classKey, members);
  }
  const pairs = fusionPairs(groups, classKeyOf);
  if (pairs.length === 0) {
    return {
      classKeyOf,
      separatedClassPairs: new Set(),
      separatingAssertionIdOf: new Map(),
    };
  }
  const verdicts = await bulkIsSeparated(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    pairs,
    ctx.registry,
  );
  const separatedClassPairs = new Set<string>();
  const separated: Readonly<{ first: string; second: string }>[] = [];
  for (const [index, pair] of pairs.entries()) {
    if (verdicts[index] !== true) continue;
    separatedClassPairs.add(classPairKey(pair.first, pair.second));
    separated.push(pair);
  }
  const separatingAssertionIdOf = new Map<string, string>();
  for (const pair of separated) {
    const witness = await loadSpanningDifferentAssertion(
      ctx.backend,
      ctx.schema,
      ctx.graphId,
      membersByClassKey.get(pair.first) ?? [],
      membersByClassKey.get(pair.second) ?? [],
    );
    if (witness !== undefined) {
      separatingAssertionIdOf.set(
        classPairKey(pair.first, pair.second),
        witness.id,
      );
    }
  }
  return { classKeyOf, separatedClassPairs, separatingAssertionIdOf };
}

/**
 * The `different` assertion ids a refusal should name for this pair — empty
 * when the relation reported a separation the ledger's witness could not be
 * resolved for (a mismatch the identity module's own rebuild guard owns).
 */
export function separatingAssertionIds(
  facts: IdentitySeparationFacts,
  a: MergeKey,
  b: MergeKey,
): readonly string[] {
  const first = facts.classKeyOf.get(a);
  const second = facts.classKeyOf.get(b);
  if (first === undefined || second === undefined) return [];
  const witness = facts.separatingAssertionIdOf.get(
    classPairKey(first, second),
  );
  return witness === undefined ? [] : [witness];
}

/**
 * Whether the ledger holds these two candidate participants' identity classes
 * apart. A pure lookup into facts already captured — never a read — so a plan
 * builder can ask it synchronously.
 */
export function isSeparatedPair(
  facts: IdentitySeparationFacts,
  a: MergeKey,
  b: MergeKey,
): boolean {
  const first = facts.classKeyOf.get(a);
  const second = facts.classKeyOf.get(b);
  if (first === undefined || second === undefined || first === second) {
    return false;
  }
  return facts.separatedClassPairs.has(classPairKey(first, second));
}
