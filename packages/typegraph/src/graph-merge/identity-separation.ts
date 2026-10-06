/**
 * The identity SEPARATION VETO.
 *
 * A `store.identity.assertDifferent(a, b)` is an integrity fact, not a recall
 * heuristic, so the veto is ON for every identity-enabled merge. Without it a
 * candidate match between two entities the ledger holds apart survives planning
 * and dies in the commit on the separation relation's ordered-pair CHECK — a
 * constraint violation at the wrong phase, naming table columns rather than the
 * two entities and the assertions that separated them.
 *
 * The facts are captured ONCE, before planning, from the merge target's own
 * identity context together with the `different` assertions the merged
 * branches carry, and consumed by three application points that all read
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
 * Points 2 and 3 run AFTER the guards on purpose. A forced base match whose
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
import { requireDefined } from "../utils/presence";
import type { MergeKey } from "./node-key";
import { idOf, kindOf, mergeKeyOf } from "./node-key";
import type {
  GraphDef,
  IdentityTransferAssertion,
  PlainNodeRef,
  Store,
} from "./typegraph-internal";
import {
  bulkIsSeparated,
  currentClassKey,
  identityReferenceKeyOf,
  loadCurrentStructuralClasses,
  loadSpanningDifferentAssertion,
  separationClassPairKey,
  separationFactsEmpty,
  storeRuntime,
} from "./typegraph-internal";

/**
 * The separation facts one merge plan is judged against: each candidate
 * participant's current identity CLASS key, and the ordered class-key pairs the
 * ledger holds as `different`.
 *
 * Evidence bound to the resource that earned it: the classes come from the
 * merge target's own identity context, the separations from that context's
 * ledger and from the assertions this plan itself is about to land, all read
 * before planning and consumed only by that plan.
 */
export type IdentitySeparationFacts = Readonly<{
  /** Class key per candidate participant, from the target's current closure. */
  classKeyOf: ReadonlyMap<MergeKey, string>;
  /**
   * NUL-joined, code-point-ordered class-key pairs held apart, by the target's
   * relation or by a `different` assertion a merged branch carries.
   */
  separatedClassPairs: ReadonlySet<string>;
  /**
   * For each separated pair, the `different` assertion held across it — the
   * target ledger's where it has one, a merged branch's otherwise — the
   * WITNESS a refusal names, so a caller reads WHICH assertion forbade
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
        const key = separationClassPairKey(first, second);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ first, second });
      }
    }
  }
  return pairs;
}

/**
 * Resolves every candidate participant to its current identity class and
 * decides which of the pairs the plan could fuse are held apart: by the
 * target's ledger ({@link bulkIsSeparated}), or by a `different` assertion
 * among `stagedAssertions`.
 *
 * `groups` are the participant sets a fusion could occur WITHIN — the connected
 * components of the candidate-edge graph. Passing the flat participant list as
 * one group is correct but quadratic; passing the components keeps the probe
 * proportional to what the plan can actually merge.
 *
 * `stagedAssertions` are the assertions the merged branches add. A `different`
 * among them is not in the target's ledger yet, and is as binding on the merge
 * that lands it as one that is: it separates the target classes of its two
 * endpoints, a node the target does not hold being its own class.
 *
 * @throws {ConfigurationError} `IDENTITY_STORAGE_MISSING` when the separation
 * relation this graph's veto reads has never been provisioned or filled —
 * `bulkIsSeparated`'s refusal, surfaced here rather than answered "not
 * separated".
 */
export async function captureIdentitySeparationFacts<G extends GraphDef>(
  target: Store<G>,
  groups: readonly (readonly MergeKey[])[],
  stagedAssertions: readonly IdentityTransferAssertion[],
): Promise<IdentitySeparationFacts> {
  const participants = [...new Set(groups.flat())];
  if (participants.length === 0) return NO_IDENTITY_SEPARATION_FACTS;
  const stagedDifferent = stagedAssertions.filter(
    (assertion) => assertion.relation === "different",
  );
  const ctx = storeRuntime(target).identityContext();
  // A graph holding no `different` assertion can separate nothing, so the whole
  // capture — the class resolution AND the within-component pair enumeration,
  // which is quadratic in component size — is skipped for one existence probe.
  // That is the STEADY state of every graph that uses only `assertSame`, and
  // the state where the veto's cost would otherwise be pure waste.
  //
  // The probe is the ledger's answer NOW (`separationFactsEmpty`), paid on
  // every plan. A fact an earlier call on this Store handle settled cannot
  // stand in for it: a `different` asserted since — by this handle or any
  // other — is exactly what the veto exists to honor.
  //
  // Consequence, deliberately: a legacy store whose separation relation was
  // never provisioned is not refused when it holds no `different` assertion
  // either. Refusing there would be a false alarm — there is nothing for the
  // veto to read, and the identity module already treats "no live `different`
  // assertion" as proof that an empty relation is correct. A store that does
  // hold one still reaches the refusal below.
  const ledgerSeparatesNothing = await separationFactsEmpty(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    ctx.registry,
  );
  if (ledgerSeparatesNothing && stagedDifferent.length === 0) {
    return NO_IDENTITY_SEPARATION_FACTS;
  }
  const stagedEndpoints = stagedDifferent.flatMap((assertion) => [
    mergeKeyOf(assertion.a),
    mergeKeyOf(assertion.b),
  ]);
  const resolved = [...new Set([...participants, ...stagedEndpoints])];
  const classes = await loadCurrentStructuralClasses(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    resolved.map((key) => ({ kind: kindOf(key), id: idOf(key) })),
  );
  const classKeyOf = new Map<MergeKey, string>();
  const membersByClassKey = new Map<string, readonly PlainNodeRef[]>();
  for (const key of resolved) {
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
  const separatedClassPairs = new Set<string>();
  const separatingAssertionIdOf = new Map<string, string>();
  const pairs = ledgerSeparatesNothing ? [] : fusionPairs(groups, classKeyOf);
  if (pairs.length > 0) {
    const verdicts = await bulkIsSeparated(
      ctx.backend,
      ctx.schema,
      ctx.graphId,
      pairs,
      ctx.registry,
    );
    for (const [index, pair] of pairs.entries()) {
      if (verdicts[index] !== true) continue;
      const pairKey = separationClassPairKey(pair.first, pair.second);
      separatedClassPairs.add(pairKey);
      const witness = await loadSpanningDifferentAssertion(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        membersByClassKey.get(pair.first) ?? [],
        membersByClassKey.get(pair.second) ?? [],
      );
      if (witness !== undefined) {
        separatingAssertionIdOf.set(pairKey, witness.id);
      }
    }
  }
  for (const assertion of stagedDifferent) {
    const first = requireDefined(classKeyOf.get(mergeKeyOf(assertion.a)));
    const second = requireDefined(classKeyOf.get(mergeKeyOf(assertion.b)));
    // An assertion inside one class is a contradiction, not a separation; the
    // plan's identity reconciliation owns that refusal.
    if (first === second) continue;
    const pairKey = separationClassPairKey(first, second);
    separatedClassPairs.add(pairKey);
    if (!separatingAssertionIdOf.has(pairKey)) {
      separatingAssertionIdOf.set(pairKey, assertion.id);
    }
  }
  return { classKeyOf, separatedClassPairs, separatingAssertionIdOf };
}

/** The class-pair key for two participants, or undefined when either is unresolved or both share a class. */
function separatedPairKey(
  facts: IdentitySeparationFacts,
  a: MergeKey,
  b: MergeKey,
): string | undefined {
  const first = facts.classKeyOf.get(a);
  const second = facts.classKeyOf.get(b);
  if (first === undefined || second === undefined || first === second) {
    return undefined;
  }
  return separationClassPairKey(first, second);
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
  const key = separatedPairKey(facts, a, b);
  const witness =
    key === undefined ? undefined : facts.separatingAssertionIdOf.get(key);
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
  const key = separatedPairKey(facts, a, b);
  return key !== undefined && facts.separatedClassPairs.has(key);
}
