/**
 * The candidate planning scope decision: one case per reason a candidate is
 * planned against the whole target, plus the candidate scope itself.
 *
 * Each case pins three behaviors of `planCandidateWriteSet`: the default call
 * still plans (or fails) exactly as the whole-target path does and reports the
 * decided scope beside the plan; `planningScope: "candidate"` refuses with
 * `CandidatePlanningScopeError` naming the same reason before any staging
 * backend is created; and the static decision agrees with
 * `candidatePlanningScope` for the causes it can see without the candidate.
 * The cross-row causes (composition, acyclic, target-side cardinality) are
 * also pinned on every backend in the shared review suite.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { projectBackendWithout } from "../../src/backend/derive-backend";
import type { MergeError } from "../../src/graph-merge";
import {
  type CandidatePlanningScope,
  CandidatePlanningScopeError,
  type CandidateWriteSet,
  CandidateWriteSetError,
  type CandidateWriteSetPlan,
  captureCandidateWriteSetTarget,
  InvalidMergeOptionsError,
  MergePlanCapabilityError,
  planCandidateWriteSet,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
} from "../../src/graph-merge";
import { canonicalMergePlanJson } from "../../src/graph-merge/plan-canonical";
import { isErr, type Result } from "../../src/graph-merge/result";
import { candidatePlanningScope } from "../../src/graph-merge/sparse-candidate-branch";
import type { GraphDef } from "../../src/graph-merge/typegraph-internal";
import type { MakeBackend } from "../../src/graph-merge/working-copy";
import { storeRuntime } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";
import { createSqliteMergeBackend } from "./test-utils";

const validFrom = "2026-01-01T00:00:00.000Z";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const link = defineEdge("link", { schema: z.object({}) });
const matched = defineEdge("matched", {
  schema: z.object({ code: z.string() }),
});

const plainGraph = defineGraph({
  id: "scope_plain",
  nodes: { Person: { type: Person } },
  edges: {},
});
const compositionGraph = defineGraph({
  id: "scope_composition",
  nodes: { Person: { type: Person } },
  edges: {
    link: { type: link, from: [Person], to: [Person], cardinality: "one" },
  },
  ontology: [partOf(Person, Person, { via: link, partSide: "from" })],
});
const acyclicGraph = defineGraph({
  id: "scope_acyclic",
  nodes: { Person: { type: Person } },
  edges: {
    link: { type: link, from: [Person], to: [Person], acyclic: true },
  },
});
const targetCardinalityGraph = defineGraph({
  id: "scope_target_cardinality",
  nodes: { Person: { type: Person } },
  edges: {
    link: {
      type: link,
      from: [Person],
      to: [Person],
      targetCardinality: "one",
    },
  },
});
const oneActiveGraph = defineGraph({
  id: "scope_one_active",
  nodes: { Person: { type: Person } },
  edges: {
    link: {
      type: link,
      from: [Person],
      to: [Person],
      cardinality: "oneActive",
    },
  },
});
const matchIdentityGraph = defineGraph({
  id: "scope_match_identity",
  nodes: { Person: { type: Person } },
  edges: {
    matched: {
      type: matched,
      from: [Person],
      to: [Person],
      matchIdentity: { name: "code", fields: ["code"] },
    },
  },
});
const identityGraph = defineGraph({
  id: "scope_identity",
  identity: { sameIdAcrossKinds: "fold" },
  nodes: { Person: { type: Person } },
  edges: {},
});

type PlanArgs = Readonly<{
  makeBackend: MakeBackend;
  planningScope?: "candidate";
}>;

/** A target and candidate, closed over so cases with different graphs share one table. */
type Arranged = Readonly<{
  staticScope: () => CandidatePlanningScope;
  plan: (args: PlanArgs) => Promise<Result<CandidateWriteSetPlan, MergeError>>;
}>;

async function arranged<G extends GraphDef>(
  target: Store<G>,
  candidate: Omit<CandidateWriteSet, "formatVersion" | "sourceId" | "target">,
): Promise<Arranged> {
  const writeSet: CandidateWriteSet = {
    formatVersion: 1,
    sourceId: "scope-source",
    target: await captureCandidateWriteSetTarget(target),
    ...candidate,
  };
  return {
    staticScope: () => candidatePlanningScope(target),
    plan: (args) => planCandidateWriteSet({ target, writeSet, ...args }),
  };
}

const PERSON_CANDIDATE = {
  nodes: [
    {
      kind: "Person",
      id: "candidate",
      properties: { name: "Candidate" },
      validFrom,
    },
  ],
  edges: [],
} as const satisfies Omit<
  CandidateWriteSet,
  "formatVersion" | "sourceId" | "target"
>;

function matchedCandidate(code: string | number) {
  return {
    nodes: [],
    edges: [
      {
        kind: "matched",
        id: "candidate-edge",
        from: { kind: "Person", id: "source" },
        to: { kind: "Person", id: "peer" },
        properties: { code },
        validFrom,
      },
    ],
  };
}

async function matchIdentityTarget(backend: GraphBackend) {
  const [target] = await createStoreWithSchema(matchIdentityGraph, backend, {
    revisionTracking: true,
  });
  const source = await target.nodes.Person.create(
    { name: "Source" },
    { id: "source" },
  );
  const peer = await target.nodes.Person.create(
    { name: "Peer" },
    { id: "peer" },
  );
  return { target, source, peer };
}

type ScopeCase = Readonly<{
  name: string;
  expected: CandidatePlanningScope;
  /** Whether the static decision already names `expected`, before the candidate is read. */
  decidedStatically: boolean;
  /** The whole-target path's own refusal, when the default call cannot plan either. */
  defaultRefusal?: typeof MergeError;
  arrange: (backend: GraphBackend) => Promise<Arranged>;
}>;

async function revisionTrackedTarget<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>> {
  const [target] = await createStoreWithSchema(graph, backend, {
    revisionTracking: true,
  });
  return target;
}

const SCOPE_CASES: readonly ScopeCase[] = [
  {
    name: "a revision-tracked graph without cross-row constraints",
    expected: { scope: "candidate" },
    decidedStatically: true,
    arrange: async (backend) =>
      arranged(
        await revisionTrackedTarget(plainGraph, backend),
        PERSON_CANDIDATE,
      ),
  },
  {
    name: "a target without revision tracking",
    expected: { scope: "whole-target", reason: "revision-tracking-disabled" },
    decidedStatically: true,
    defaultRefusal: MergePlanCapabilityError,
    arrange: async (backend) => {
      const [target] = await createStoreWithSchema(plainGraph, backend, {
        revisionTracking: false,
      });
      return arranged(target, PERSON_CANDIDATE);
    },
  },
  {
    name: "a composition pair",
    expected: { scope: "whole-target", reason: "composition" },
    decidedStatically: true,
    arrange: async (backend) =>
      arranged(
        await revisionTrackedTarget(compositionGraph, backend),
        PERSON_CANDIDATE,
      ),
  },
  {
    name: "an acyclic edge",
    expected: { scope: "whole-target", reason: "acyclic-relation" },
    decidedStatically: true,
    arrange: async (backend) =>
      arranged(
        await revisionTrackedTarget(acyclicGraph, backend),
        PERSON_CANDIDATE,
      ),
  },
  {
    name: "a target-side cardinality",
    expected: { scope: "whole-target", reason: "target-side-cardinality" },
    decidedStatically: true,
    arrange: async (backend) =>
      arranged(
        await revisionTrackedTarget(targetCardinalityGraph, backend),
        PERSON_CANDIDATE,
      ),
  },
  {
    name: "a oneActive edge on a backend without the active source read",
    expected: { scope: "whole-target", reason: "missing-active-source-read" },
    decidedStatically: true,
    arrange: async (backend) =>
      arranged(
        await revisionTrackedTarget(
          oneActiveGraph,
          projectBackendWithout(backend, ["findActiveEdgesBySourceV1"]),
        ),
        PERSON_CANDIDATE,
      ),
  },
  {
    name: "a match-identity edge on a backend without the keyed owner read",
    expected: { scope: "whole-target", reason: "missing-match-identity-read" },
    decidedStatically: true,
    arrange: async (backend) =>
      arranged(
        await revisionTrackedTarget(
          matchIdentityGraph,
          projectBackendWithout(backend, ["findEdgesByMatchIdentity"]),
        ),
        PERSON_CANDIDATE,
      ),
  },
  {
    name: "an identity graph whose runtime lacks the scoped identity reads",
    expected: {
      scope: "whole-target",
      reason: "missing-scoped-identity-reads",
    },
    decidedStatically: true,
    arrange: async (backend) => {
      const target = await revisionTrackedTarget(identityGraph, backend);
      const runtime = storeRuntime(target);
      Reflect.deleteProperty(runtime, "identityAssertionsTouchingAtTarget");
      Reflect.deleteProperty(
        runtime,
        "interchangeIdentityAssertionsByIdsAtTarget",
      );
      return arranged(target, PERSON_CANDIDATE);
    },
  },
  {
    name: "a candidate edge whose match-identity owner key cannot be derived",
    expected: {
      scope: "whole-target",
      reason: "match-identity-owners-unavailable",
    },
    decidedStatically: false,
    defaultRefusal: CandidateWriteSetError,
    arrange: async (backend) => {
      const { target } = await matchIdentityTarget(backend);
      return arranged(target, matchedCandidate(42));
    },
  },
  {
    name: "a match-identity owner excluded from the clone projection",
    expected: {
      scope: "whole-target",
      reason: "match-identity-owner-not-clone-visible",
    },
    decidedStatically: false,
    arrange: async (backend) => {
      const { target, source, peer } = await matchIdentityTarget(backend);
      const deletedOwner = await target.edges.matched.create(
        source,
        peer,
        { code: "reusable" },
        { id: "deleted-owner" },
      );
      await target.edges.matched.delete(deletedOwner.id);
      return arranged(target, matchedCandidate("reusable"));
    },
  },
];

describe("candidate planning scope", () => {
  let cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
  });

  function sqliteBackend(): GraphBackend {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  function stagingBackend() {
    return vi.fn(() => Promise.resolve(sqliteBackend()));
  }

  describe.each(SCOPE_CASES)("$name", (testCase) => {
    it("reports the decided scope beside the default plan", async () => {
      const subject = await testCase.arrange(sqliteBackend());
      expect(subject.staticScope()).toEqual(
        testCase.decidedStatically ? testCase.expected : { scope: "candidate" },
      );

      const planned = await subject.plan({ makeBackend: stagingBackend() });
      if (testCase.defaultRefusal !== undefined) {
        if (!isErr(planned))
          throw new Error("expected the default call to fail");
        expect(planned.error).toBeInstanceOf(testCase.defaultRefusal);
        return;
      }
      if (isErr(planned)) throw planned.error;
      expect(planned.data.planningScope).toEqual(testCase.expected);
    });

    it("applies or refuses an explicit candidate planning scope", async () => {
      const subject = await testCase.arrange(sqliteBackend());
      const makeBackend = stagingBackend();

      const scoped = await subject.plan({
        makeBackend,
        planningScope: "candidate",
      });

      if (testCase.expected.scope === "candidate") {
        if (isErr(scoped)) throw scoped.error;
        const unscoped = await subject.plan({ makeBackend: stagingBackend() });
        if (isErr(unscoped)) throw unscoped.error;
        expect(scoped.data.planningScope).toEqual(testCase.expected);
        expect(canonicalMergePlanJson(scoped.data.plan)).toBe(
          canonicalMergePlanJson(unscoped.data.plan),
        );
        return;
      }
      if (!isErr(scoped)) {
        throw new Error(
          `expected a planning scope refusal, planned with ${JSON.stringify(scoped.data.planningScope)}`,
        );
      }
      expect(scoped.error).toBeInstanceOf(CandidatePlanningScopeError);
      expect(scoped.error.code).toBe("GRAPH_MERGE_CANDIDATE_PLANNING_SCOPE");
      expect(scoped.error.details).toEqual({
        planningScope: testCase.expected,
      });
      expect(makeBackend).not.toHaveBeenCalled();
    });
  });

  it("forwards an explicit candidate planning scope through both review entry points", async () => {
    const target = await revisionTrackedTarget(acyclicGraph, sqliteBackend());
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "scope-source",
      target: await captureCandidateWriteSetTarget(target),
      ...PERSON_CANDIDATE,
    };
    const policy = { id: "scope-review", context: {} };
    const expected = {
      planningScope: { scope: "whole-target", reason: "acyclic-relation" },
    };

    const reviewBackend = stagingBackend();
    const refusedReview = await planCandidateWriteSetReview({
      target,
      writeSet,
      makeBackend: reviewBackend,
      policy,
      planningScope: "candidate",
    });
    if (!isErr(refusedReview)) throw new Error("expected a review refusal");
    expect(refusedReview.error).toBeInstanceOf(CandidatePlanningScopeError);
    expect(refusedReview.error.details).toEqual(expected);
    expect(reviewBackend).not.toHaveBeenCalled();

    const review = await planCandidateWriteSetReview({
      target,
      writeSet,
      makeBackend: stagingBackend(),
      policy,
    });
    if (isErr(review)) throw review.error;
    const revalidateBackend = stagingBackend();
    const refusedRevalidation = await revalidateCandidateWriteSetReview({
      target,
      review: review.data,
      makeBackend: revalidateBackend,
      policy,
      planningScope: "candidate",
    });
    if (!isErr(refusedRevalidation))
      throw new Error("expected a revalidation refusal");
    expect(refusedRevalidation.error).toBeInstanceOf(
      CandidatePlanningScopeError,
    );
    expect(refusedRevalidation.error.details).toEqual(expected);
    expect(revalidateBackend).not.toHaveBeenCalled();
  });

  it("refuses an unsupported planning scope value", async () => {
    const subject = await requireDefined(SCOPE_CASES[0]).arrange(
      sqliteBackend(),
    );
    const makeBackend = stagingBackend();
    const refused = await subject.plan({
      makeBackend,
      planningScope: "whole-target" as "candidate",
    });
    if (!isErr(refused)) throw new Error("expected an options refusal");
    expect(refused.error).toBeInstanceOf(InvalidMergeOptionsError);
    expect(refused.error.details).toEqual({ planningScope: "whole-target" });
    expect(makeBackend).not.toHaveBeenCalled();
  });
});
