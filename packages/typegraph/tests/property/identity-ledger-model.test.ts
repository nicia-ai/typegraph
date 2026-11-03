/**
 * Model-based property for the live identity ledger: random command sequences
 * (assert same/different, bulk asserts, retractions, bulk retractions, node
 * deletion, and same-id peers of another kind joining and leaving) run against
 * a store and against a small union-find model side by side, under both
 * same-id profiles. After every command the store must agree with the model
 * on `areSame`, `areDifferent` and `membersOf` for every live pair, refuse an
 * assertion exactly when the model says it would contradict the ledger, and
 * pass `validateIdentity`.
 *
 * The model is written from the documented semantics, not from the store's
 * code: a class is the transitive closure of current `same` assertions (and,
 * under `"fold"`, of live nodes sharing an id across kinds); a `different`
 * lifts to the two classes its endpoints sit in; deleting a node ends every
 * assertion that touches it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  IdentityContradictionError,
  type Store,
} from "../../src";
import { asIdentityAssertionId } from "../../src/identity/types";
import { storeRuntime } from "../../src/store/runtime-port";
import { compareStrings } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

const Person = defineNode("Person", { schema: z.object({}) });
const Robot = defineNode("Robot", { schema: z.object({}) });

function defineLedgerGraph(profile: "fold" | "ignore") {
  return defineGraph({
    id: `identity_ledger_model_${profile}`,
    nodes: { Person: { type: Person }, Robot: { type: Robot } },
    edges: {},
    identity: { sameIdAcrossKinds: profile },
  });
}

type LedgerGraph = ReturnType<typeof defineLedgerGraph>;
type LedgerStore = Store<LedgerGraph>;
type Kind = "Person" | "Robot";
type Ref = Readonly<{ kind: Kind; id: string }>;
type Relation = "same" | "different";

const IDS = ["n0", "n1", "n2"] as const;
const REFS: readonly Ref[] = (["Person", "Robot"] as const).flatMap((kind) =>
  IDS.map((id) => ({ kind, id })),
);

const RUNS = propertyRuns({ ci: 40, local: 80 });
const MAX_COMMANDS = 25;

function refKey(ref: Ref): string {
  return `${ref.kind}:${ref.id}`;
}

function pairKey(left: Ref, right: Ref): string {
  return [refKey(left), refKey(right)].toSorted().join("|");
}

type ModelAssertion = Readonly<{ relation: Relation; a: Ref; b: Ref }>;

class LedgerModel {
  readonly live = new Set<string>();
  /** Current assertions by the id the store minted for them. */
  readonly assertions = new Map<string, ModelAssertion>();

  constructor(readonly profile: "fold" | "ignore") {}

  liveRefs(): readonly Ref[] {
    return REFS.filter((ref) => this.live.has(refKey(ref)));
  }

  /** Each live ref's class root under `extra` hypothetical `same` links. */
  classes(extra: readonly ModelAssertion[] = []): (ref: Ref) => string {
    const parent = new Map<string, string>();
    const find = (key: string): string => {
      let root = key;
      while ((parent.get(root) ?? root) !== root) {
        root = requireDefined(parent.get(root));
      }
      return root;
    };
    const union = (left: string, right: string) => {
      const [first, second] = [find(left), find(right)].toSorted();
      if (first !== second)
        parent.set(requireDefined(second), requireDefined(first));
    };
    for (const assertion of [...this.assertions.values(), ...extra]) {
      if (assertion.relation === "same") {
        union(refKey(assertion.a), refKey(assertion.b));
      }
    }
    if (this.profile === "fold") {
      for (const id of IDS) {
        const person: Ref = { kind: "Person", id };
        const robot: Ref = { kind: "Robot", id };
        if (this.live.has(refKey(person)) && this.live.has(refKey(robot))) {
          union(refKey(person), refKey(robot));
        }
      }
    }
    return (ref) => find(refKey(ref));
  }

  separated(classOf: (ref: Ref) => string, left: Ref, right: Ref): boolean {
    const [first, second] = [classOf(left), classOf(right)];
    return [...this.assertions.values()].some(
      (assertion) =>
        assertion.relation === "different" &&
        ((classOf(assertion.a) === first && classOf(assertion.b) === second) ||
          (classOf(assertion.a) === second && classOf(assertion.b) === first)),
    );
  }

  /** Whether adding `candidates` (in order) leaves some class holding a `different`. */
  contradicts(candidates: readonly ModelAssertion[]): boolean {
    const classOf = this.classes(
      candidates.filter((candidate) => candidate.relation === "same"),
    );
    return [...this.assertions.values(), ...candidates].some(
      (assertion) =>
        assertion.relation === "different" &&
        classOf(assertion.a) === classOf(assertion.b),
    );
  }

  directAssertion(candidate: ModelAssertion): string | undefined {
    for (const [id, assertion] of this.assertions) {
      if (
        assertion.relation === candidate.relation &&
        pairKey(assertion.a, assertion.b) === pairKey(candidate.a, candidate.b)
      ) {
        return id;
      }
    }
    return undefined;
  }

  removeNode(ref: Ref): void {
    this.live.delete(refKey(ref));
    for (const [id, assertion] of this.assertions) {
      if (
        refKey(assertion.a) === refKey(ref) ||
        refKey(assertion.b) === refKey(ref)
      ) {
        this.assertions.delete(id);
      }
    }
  }

  /** The current assertion ids in a stable order, for index-based picks. */
  assertionIds(): readonly string[] {
    return [...this.assertions.keys()].toSorted();
  }
}

type Real = Readonly<{ store: LedgerStore }>;
type LedgerCommand = fc.AsyncCommand<LedgerModel, Real>;

function identityRef(ref: Ref) {
  return { kind: ref.kind, id: ref.id } as const;
}

async function verifyAgainstModel(model: LedgerModel, store: LedgerStore) {
  const classOf = model.classes();
  const live = model.liveRefs();
  for (const ref of live) {
    const stored = await store.identity.membersOf(identityRef(ref));
    const members = stored
      .map((member) => `${member.kind}:${member.id}`)
      .toSorted((left, right) => compareStrings(left, right));
    const expected = live
      .filter((other) => classOf(other) === classOf(ref))
      .map((other) => refKey(other))
      .toSorted((left, right) => compareStrings(left, right));
    expect(members, `membersOf ${refKey(ref)}`).toEqual(expected);
  }
  for (const [index, left] of live.entries()) {
    for (const right of live.slice(index + 1)) {
      const label = `${refKey(left)} / ${refKey(right)}`;
      expect(
        await store.identity.areSame(identityRef(left), identityRef(right)),
        `areSame ${label}`,
      ).toBe(classOf(left) === classOf(right));
      expect(
        await store.identity.areDifferent(
          identityRef(left),
          identityRef(right),
        ),
        `areDifferent ${label}`,
      ).toBe(model.separated(classOf, left, right));
    }
  }
  await storeRuntime(store).validateIdentity();
}

/**
 * Runs a write the model predicts refused (an `IdentityContradictionError`)
 * or accepted, and fails on any other outcome.
 */
async function expectVerdict<T>(
  label: string,
  refused: boolean,
  write: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await write();
    expect(
      refused,
      `${label}: the model refuses it, the store accepted it`,
    ).toBe(false);
    return result;
  } catch (error) {
    if (!(error instanceof IdentityContradictionError)) throw error;
    expect(
      refused,
      `${label}: the model accepts it, the store refused it`,
    ).toBe(true);
    return undefined;
  }
}

async function applyAssert(
  relation: Relation,
  left: Ref,
  right: Ref,
  model: LedgerModel,
  real: Real,
): Promise<void> {
  const label = `assert ${relation}(${refKey(left)}, ${refKey(right)})`;
  const candidate = { relation, a: left, b: right };
  if (model.live.has(refKey(left)) && model.live.has(refKey(right))) {
    const existing = model.directAssertion(candidate);
    const refused = existing === undefined && model.contradicts([candidate]);
    const result = await expectVerdict(label, refused, () =>
      relation === "same" ?
        real.store.identity.assertSame(identityRef(left), identityRef(right))
      : real.store.identity.assertDifferent(
          identityRef(left),
          identityRef(right),
        ),
    );
    if (result !== undefined) {
      expect(result.action, `${label}: action`).toBe(
        existing === undefined ? "created" : "existing",
      );
      if (existing !== undefined) expect(result.assertion.id).toBe(existing);
      model.assertions.set(result.assertion.id, candidate);
    }
  }
  await verifyAgainstModel(model, real.store);
}

async function applyBulkAssert(
  relation: Relation,
  requested: readonly (readonly [Ref, Ref])[],
  label: string,
  model: LedgerModel,
  real: Real,
): Promise<void> {
  const pairs = requested.filter(
    ([left, right]) =>
      model.live.has(refKey(left)) && model.live.has(refKey(right)),
  );
  if (pairs.length > 0) {
    const candidates = pairs.map(([a, b]) => ({ relation, a, b }));
    const refused = model.contradicts(
      candidates.filter(
        (candidate) => model.directAssertion(candidate) === undefined,
      ),
    );
    const input = pairs.map(([a, b]) => ({
      a: identityRef(a),
      b: identityRef(b),
    }));
    const results = await expectVerdict(label, refused, () =>
      relation === "same" ?
        real.store.identity.bulkAssertSame(input)
      : real.store.identity.bulkAssertDifferent(input),
    );
    if (results !== undefined) {
      expect(results).toHaveLength(candidates.length);
      for (const [index, result] of results.entries()) {
        model.assertions.set(
          result.assertion.id,
          requireDefined(candidates[index]),
        );
      }
    }
  }
  await verifyAgainstModel(model, real.store);
}

async function applyRetract(
  picks: readonly number[],
  model: LedgerModel,
  real: Real,
): Promise<void> {
  const ids = model.assertionIds();
  if (ids.length > 0) {
    const chosen = [
      ...new Set(picks.map((pick) => requireDefined(ids[pick % ids.length]))),
    ];
    if (chosen.length === 1) {
      const id = requireDefined(chosen[0]);
      const ended = await real.store.identity.retractAssertion(
        asIdentityAssertionId(id),
      );
      expect(ended?.id, `retract ${id}`).toBe(id);
    } else {
      const ended = await real.store.identity.bulkRetractAssertions(
        chosen.map((id) => asIdentityAssertionId(id)),
      );
      expect(
        ended.map((row) => row.id).toSorted(),
        "bulk retraction ends exactly the requested rows",
      ).toEqual(chosen.toSorted());
    }
    for (const id of chosen) model.assertions.delete(id);
  }
  await verifyAgainstModel(model, real.store);
}

class AssertCommand implements LedgerCommand {
  constructor(
    readonly relation: Relation,
    readonly left: Ref,
    readonly right: Ref,
  ) {}

  check(): true {
    return true;
  }

  run(model: LedgerModel, real: Real): Promise<void> {
    return applyAssert(this.relation, this.left, this.right, model, real);
  }

  toString(): string {
    return `assert ${this.relation}(${refKey(this.left)}, ${refKey(this.right)})`;
  }
}

class BulkAssertCommand implements LedgerCommand {
  constructor(
    readonly relation: Relation,
    readonly pairs: readonly (readonly [Ref, Ref])[],
  ) {}

  check(): true {
    return true;
  }

  run(model: LedgerModel, real: Real): Promise<void> {
    return applyBulkAssert(
      this.relation,
      this.pairs,
      this.toString(),
      model,
      real,
    );
  }

  toString(): string {
    return `bulk ${this.relation} [${this.pairs
      .map(([left, right]) => `${refKey(left)}~${refKey(right)}`)
      .join(", ")}]`;
  }
}

class RetractCommand implements LedgerCommand {
  constructor(readonly picks: readonly number[]) {}

  check(): true {
    return true;
  }

  run(model: LedgerModel, real: Real): Promise<void> {
    return applyRetract(this.picks, model, real);
  }

  toString(): string {
    return `retract #${this.picks.join(",#")}`;
  }
}

class DeleteNodeCommand implements LedgerCommand {
  constructor(readonly ref: Ref) {}

  check(model: Readonly<LedgerModel>): boolean {
    return model.live.has(refKey(this.ref));
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    if (this.ref.kind === "Person") {
      await real.store.nodes.Person.delete(
        asNodeId<typeof Person>(this.ref.id),
      );
    } else {
      // A hard delete, so the same Robot id can be created again later.
      const id = asNodeId<typeof Robot>(this.ref.id);
      await real.store.nodes.Robot.delete(id);
      await real.store.nodes.Robot.hardDelete(id);
    }
    model.removeNode(this.ref);
    await verifyAgainstModel(model, real.store);
  }

  toString(): string {
    return `delete ${refKey(this.ref)}`;
  }
}

class CreateRobotCommand implements LedgerCommand {
  constructor(readonly id: string) {}

  check(model: Readonly<LedgerModel>): boolean {
    return !model.live.has(refKey({ kind: "Robot", id: this.id }));
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    await real.store.nodes.Robot.create({}, { id: this.id });
    model.live.add(refKey({ kind: "Robot", id: this.id }));
    await verifyAgainstModel(model, real.store);
  }

  toString(): string {
    return `create Robot:${this.id}`;
  }
}

const refArb = fc.constantFrom(...REFS);
const pairArb = fc
  .tuple(refArb, refArb)
  .filter(([left, right]) => refKey(left) !== refKey(right));
const relationArb = fc.constantFrom<Relation>("same", "different");

const commandArbs: fc.Arbitrary<LedgerCommand>[] = [
  fc
    .tuple(relationArb, pairArb)
    .map(
      ([relation, [left, right]]) => new AssertCommand(relation, left, right),
    ),
  fc
    .tuple(
      relationArb,
      fc.uniqueArray(pairArb, {
        minLength: 2,
        maxLength: 3,
        selector: ([left, right]) => pairKey(left, right),
      }),
    )
    .map(([relation, pairs]) => new BulkAssertCommand(relation, pairs)),
  fc
    .array(fc.nat({ max: 7 }), { minLength: 1, maxLength: 3 })
    .map((picks) => new RetractCommand(picks)),
  refArb.map((ref) => new DeleteNodeCommand(ref)),
  fc.constantFrom(...IDS).map((id) => new CreateRobotCommand(id)),
];

describe.each(["fold", "ignore"] as const)(
  "identity ledger against a union-find model [%s]",
  (profile) => {
    const graph = defineLedgerGraph(profile);

    it("agrees on classes, separations, refusals and integrity after every command", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.commands(commandArbs, { maxCommands: MAX_COMMANDS, size: "max" }),
          async (commands) => {
            const [store] = await createStoreWithSchema(
              graph,
              createTestBackend(),
            );
            const model = new LedgerModel(profile);
            for (const id of IDS) {
              await store.nodes.Person.create({}, { id });
              model.live.add(refKey({ kind: "Person", id }));
            }
            // One Robot peer from the start, so the fold arm is live in
            // every run rather than only after a create command.
            await store.nodes.Robot.create({}, { id: "n0" });
            model.live.add(refKey({ kind: "Robot", id: "n0" }));
            await fc.asyncModelRun(
              () => ({ model, real: { store } }),
              commands,
            );
          },
        ),
        { numRuns: RUNS },
      );
    }, 120_000);
  },
);
