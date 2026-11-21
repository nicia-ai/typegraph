/**
 * Pins the read-path bind-budget constants against today's actual fixed
 * statement shape.
 *
 * Each constant below reserves headroom for the fixed (non-chunked) binds a
 * budgeted statement always carries, so a variable-width chunk (ids, edge
 * kinds, node kinds) can be sized to fit the backend's bind-parameter
 * ceiling. None of these constants are computed from a rendered statement
 * today; they are hand-maintained integers. This file is the guard that
 * catches them drifting from the SQL they describe.
 *
 * Two measurement techniques are used, both driven off real (non-mocked)
 * production code paths:
 *
 * - **Direct count**: build the exact fixed fragment the constant describes
 *   and count its own bound parameters.
 * - **Linear fit**: call the real budgeted operation at two chunk sizes and
 *   solve `total = fixed + slope * n` for the two unknowns. This is used
 *   whenever the fixed fragment is produced by a private function reachable
 *   only through the operation's own chunk-sizing math.
 *
 * Where a constant reserves more binds than the statement it chunks for
 * actually needs, that is documented rather than silently pinned as if it
 * were exact: an over-reservation only shrinks the chunk sizes the math
 * computes (safe), but it is stale, and the comment says so instead of
 * re-deriving the doc comment's number.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  createRecordedInstant,
  type ReadCoordinate,
} from "../src/core/temporal";
import {
  identityAssertionSnapshotSource,
  identitySqlCoordinate,
} from "../src/identity/historical-sql";
import { readIdentityAssertionPageAtTarget } from "../src/identity/interchange-read";
import { separationRebuildRequired } from "../src/identity/separation";
import {
  loadAssertionsTouching,
  loadHistoricalClasses,
} from "../src/identity/service-read";
import {
  createRecordedReadBinding,
  createSqlSchema,
  recordedRelation,
} from "../src/query/compiler/schema";
import { renderPostgres, type SqlFragment } from "../src/query/sql-fragment";
import { buildKindRegistry } from "../src/registry";
import { recordedAnchorOwner } from "../src/store/recorded-anchor-origin";
import { createRecordedReadService } from "../src/store/recorded-read-service";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend, disableTransactions } from "./test-utils";

const FAKE_NOW = "2026-01-01T00:00:00.000Z";

/**
 * Recorded reads refuse an anchor that does not name the graph's allocation
 * owner, so every recorded coordinate below carries one fixed owner, and the
 * capture backends answer the origin probe with the same origin.
 */
const REVISION_ORIGIN = "bind-budget-origin";
const RECORDED_OWNER = await recordedAnchorOwner(
  createSqlSchema(),
  REVISION_ORIGIN,
);
const RECORDED_AS_OF = createRecordedInstant(1, FAKE_NOW, RECORDED_OWNER);

/** Whether `statement` is the revision-origin probe a recorded read runs. */
function isRevisionOriginProbe(statement: string): boolean {
  return statement.includes('FROM "typegraph_revision_origins"');
}
const RECORDED_COORDINATE_CURRENT = {
  valid: { mode: "current" as const },
  recorded: {
    asOf: RECORDED_AS_OF,
  },
};
const RECORDED_COORDINATE_AS_OF = {
  valid: { mode: "asOf" as const, asOf: "2025-01-01T00:00:00.000Z" },
  recorded: {
    asOf: RECORDED_AS_OF,
  },
};

/**
 * The recorded-read service's origin session, answered with the fixed owner
 * without a statement, so the captured widths are only the point reads.
 */
function fixedRevisionOriginSession(): Promise<
  Readonly<{ owner: typeof RECORDED_OWNER; sharesSnapshot: boolean }>
> {
  return Promise.resolve({ owner: RECORDED_OWNER, sharesSnapshot: false });
}

describe("IDENTITY_SNAPSHOT_PARAMETERS (src/identity/separation.ts)", () => {
  // Doc comment: "graph_id, rel, and the validity instant twice
  // (valid_from <= and valid_to >)".
  const IDENTITY_SNAPSHOT_PARAMETERS = 4;

  it("equals identityAssertionSnapshotSource's own bind count at the current coordinate", () => {
    const schema = createSqlSchema();
    const coordinate = identitySqlCoordinate(undefined, FAKE_NOW);
    const fragment = identityAssertionSnapshotSource(
      schema,
      "bind-budget",
      coordinate,
      "different",
    );
    expect(renderPostgres(fragment).params.length).toBe(
      IDENTITY_SNAPSHOT_PARAMETERS,
    );
  });
});

describe("OWED_SEPARATION_PROBE_PARAMETERS (src/identity/separation.ts)", () => {
  // Doc comment: IDENTITY_SNAPSHOT_PARAMETERS + 2 (the two closure LEFT
  // JOINs' own `graph_id` binds) = 6.
  const OWED_SEPARATION_PROBE_PARAMETERS = 6;

  const Alpha = defineNode("Alpha", { schema: z.object({ name: z.string() }) });
  const Beta = defineNode("Beta", { schema: z.object({ name: z.string() }) });
  const graph = defineGraph({
    id: "bind-budget-owed-separation",
    nodes: { Alpha: { type: Alpha }, Beta: { type: Beta } },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });

  /** The probe statement widths at a given backend bind budget. */
  async function probeStatementWidths(
    maxBindParameters: number,
  ): Promise<readonly number[]> {
    const captured: number[] = [];
    const target = {
      dialect: "sqlite" as const,
      capabilities: { maxBindParameters },
      // Not a real backend: only the chunk math's `capabilities` field and
      // the width of what it sends to `execute` are under test. Reporting a
      // live `different` on the first call keeps `separationRebuildRequired`
      // running the real (non-early-exit) probe path.
      execute: (compiled: SqlFragment) => {
        captured.push(renderPostgres(compiled).params.length);
        return Promise.resolve([{ present: 1 }]);
      },
      executeStatement: () => Promise.resolve(undefined),
    };
    await separationRebuildRequired(
      target as unknown as Parameters<typeof separationRebuildRequired>[0],
      createSqlSchema(createTestBackend().tableNames),
      graph.id,
      { relationExists: false, registry: buildKindRegistry(graph) },
    );
    return captured;
  }

  it("solves to 6 fixed binds from the chunk-size-1 and chunk-size-2 statement widths", async () => {
    // Two identity-active kinds (Alpha, Beta): budget 8 forces a chunk of 1
    // kind per side, budget 10 forces both kinds into one chunk.
    const chunkOf1 = Math.max(...(await probeStatementWidths(8)));
    const chunkOf2 = Math.max(...(await probeStatementWidths(10)));
    const perKindMarginal = chunkOf2 - chunkOf1;
    const fixed = chunkOf1 - perKindMarginal;

    expect(fixed).toBe(OWED_SEPARATION_PROBE_PARAMETERS);
  });

  it("refuses a bind ceiling of 7 when one kind cannot fit", async () => {
    await expect(probeStatementWidths(7)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      details: { code: "IDENTITY_BIND_BUDGET_TOO_SMALL" },
    });
  });

  it.each([8, 9, 10, 11, 12])(
    "keeps every probe within a bind ceiling of %i",
    async (maxBindParameters) => {
      const widths = await probeStatementWidths(maxBindParameters);
      expect(widths.length).toBeGreaterThan(1);
      for (const width of widths) {
        expect(width).toBeLessThanOrEqual(maxBindParameters);
      }
    },
  );
});

describe("RECORDED_POINT_READ_FIXED_BIND_PARAMS (src/store/recorded-read-service.ts)", () => {
  // Measured, not the source constant (8): `recordedGetByIds`'s rendered
  // statement — graph_id, kind, and the temporal filter's two instant
  // binds, plus the recorded-read binding's own two recorded_from/
  // recorded_to binds — is 6, for both the TypeGraph-owned and external
  // binding kinds, in both current and asOf valid-time mode (the
  // engine-native binding's `predicate()` returns undefined, so its own
  // fixed cost is only 4, and is not pinned here — no engine-native
  // recorded read source is constructible without a live engine backend).
  // The source constant reserves 2 more binds than any binding kind
  // needs: safe to chunk against (an over-reservation only shrinks the id
  // chunk size, never widens a statement past the real ceiling), but
  // stale. Whichever step derives this constant from its statement should
  // land on the real number (6) rather than re-deriving the doc
  // comment's 8.
  const MEASURED_RECORDED_POINT_READ_FIXED_BIND_PARAMS = 6;

  it("solves to 6 fixed binds from a 1-id and a 2-id nodeGetByIds call", async () => {
    const schema = createSqlSchema();
    const recordedReadBinding = createRecordedReadBinding(schema);
    const captured: number[] = [];
    const backend = {
      dialect: "postgres" as const,
      capabilities: { maxBindParameters: 999 },
      execute: (query: unknown) => {
        captured.push(renderPostgres(query as SqlFragment).params.length);
        return Promise.resolve([]);
      },
    };
    const service = createRecordedReadService({
      graphId: "bind-budget-recorded-point-read",
      backend: backend as never,
      recordedReadBinding,
      revisionOriginSession: fixedRevisionOriginSession,
      mapRecordedNodeRow: (row) => row as never,
      mapRecordedEdgeRow: (row) => row as never,
    });

    await service.nodeGetByIds(
      "Person",
      [asNodeId("a")],
      RECORDED_COORDINATE_CURRENT,
    );
    const oneId = requireDefined(captured.at(-1));

    await service.nodeGetByIds(
      "Person",
      [asNodeId("a"), asNodeId("b")],
      RECORDED_COORDINATE_CURRENT,
    );
    const twoIds = requireDefined(captured.at(-1));

    const perIdMarginal = twoIds - oneId;
    const fixed = oneId - perIdMarginal;

    expect(fixed).toBe(MEASURED_RECORDED_POINT_READ_FIXED_BIND_PARAMS);
  });

  /**
   * The dangerous drift direction — the constant undercounting the real
   * statement, which overflows the chunk past the backend's ceiling — is
   * not something a direct-count or a linear-fit test alone rules out for
   * every mode and binding kind this read serves. This runs the real
   * service at a tight ceiling with more ids than fit in one chunk, and
   * checks every statement the chunking loop actually sends.
   */
  it.each([
    ["node", "current", "typegraph-capture"],
    ["node", "asOf", "typegraph-capture"],
    ["node", "current", "external"],
    ["node", "asOf", "external"],
    ["edge", "current", "typegraph-capture"],
    ["edge", "asOf", "typegraph-capture"],
    ["edge", "current", "external"],
    ["edge", "asOf", "external"],
  ] as const)(
    "keeps every chunk within the bind ceiling: %s / %s / %s",
    async (entity, mode, bindingKind) => {
      const schema = createSqlSchema();
      const recordedReadBinding =
        bindingKind === "typegraph-capture" ?
          createRecordedReadBinding(schema)
        : recordedRelation({ schema });
      const coordinate =
        mode === "current" ?
          RECORDED_COORDINATE_CURRENT
        : RECORDED_COORDINATE_AS_OF;
      const maxBindParameters = 10;
      const captured: number[] = [];
      const backend = {
        dialect: "postgres" as const,
        capabilities: { maxBindParameters },
        execute: (query: unknown) => {
          captured.push(renderPostgres(query as SqlFragment).params.length);
          return Promise.resolve([]);
        },
      };
      const service = createRecordedReadService({
        graphId: "bind-budget-recorded-point-read-fit",
        backend: backend as never,
        recordedReadBinding,
        revisionOriginSession: fixedRevisionOriginSession,
        mapRecordedNodeRow: (row) => row as never,
        mapRecordedEdgeRow: (row) => row as never,
      });

      // More ids than one chunk fits at this ceiling, so the loop's own
      // chunking runs more than once.
      if (entity === "node") {
        const ids = Array.from({ length: 5 }, (_, index) =>
          asNodeId(`n${index}`),
        );
        await service.nodeGetByIds("Person", ids, coordinate);
      } else {
        const ids = Array.from({ length: 5 }, (_, index) =>
          asEdgeId(`e${index}`),
        );
        await service.edgeGetByIds("knows", ids, coordinate);
      }

      for (const width of captured) {
        expect(width).toBeLessThanOrEqual(maxBindParameters);
      }
      expect(captured.length).toBeGreaterThan(1);
    },
  );
});

describe("RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH (src/store/algorithms/iterative-graph-operation.ts)", () => {
  // Doc-adjacent value: 12. `store.algorithms.reachable` with direction
  // "out" (branchCount = 1) refuses with "cannot fit its fixed filters"
  // whenever
  // `maxBindParameters < RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH + (branchCount + 2)`
  // and succeeds otherwise — an exact, load-bearing boundary at
  // `12 + 3 = 15` for one branch, chosen so the algorithm can still fit one
  // edge kind. The boundary test below pins that refusal arithmetic; it
  // never counts a bind in the SQL the algorithm actually sends.
  //
  // The capture tests further below measure the real statement, using a
  // canned-row backend overlay (real compiler, real `createOperation` chunk
  // math, no live database read) to capture the real rendered statement
  // widths the inline expansion path emits — at both the current coordinate
  // and a recorded pin, because a recorded pin's node and edge temporal
  // filters each bind 4 parameters (the valid-time window plus the recorded
  // binding's own `recorded_from`/`recorded_to` predicate)
  // instead of a current pin's 2, which is where the constant's slack is
  // smallest.
  const RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH = 12;
  const BRANCH_COUNT = 1;
  const boundary =
    RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH + (BRANCH_COUNT + 2);
  const RECORDED_AS_OF_REACHABLE = RECORDED_AS_OF;

  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const knows = defineEdge("knows");
  const likes = defineEdge("likes");
  const graph = defineGraph({
    id: "bind-budget-reserved-temporal",
    nodes: { Person: { type: Person } },
    edges: {
      knows: { type: knows, from: [Person], to: [Person] },
      likes: { type: likes, from: [Person], to: [Person] },
    },
  });

  /**
   * A single-direction reachability call at a given bind ceiling. Runs the
   * INLINE fallback path deliberately (`disableTransactions`): the default
   * working-table path never reaches `createOperation`'s chunk-sizing
   * refusal at all, so a backend with interactive transactions cannot
   * discriminate this boundary.
   */
  async function reachableAtBindCeiling(
    maxBindParameters: number,
  ): Promise<"ok" | "refused"> {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "alice" });
    const bob = await store.nodes.Person.create({ name: "bob" });
    await store.edges.knows.create(alice, bob);

    const limited = disableTransactions(
      deriveBackend(backend, {
        capabilities: { ...backend.capabilities, maxBindParameters },
      }),
    );
    const limitedStore = createStore(graph, limited);
    try {
      await limitedStore.algorithms.reachable(alice, {
        edges: ["knows"],
        maxHops: 1,
      });
      return "ok";
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("cannot fit its fixed filters")
      ) {
        return "refused";
      }
      throw error;
    }
  }

  it("refuses one bind below the boundary and succeeds exactly at it", async () => {
    expect(await reachableAtBindCeiling(boundary - 1)).toBe("refused");
    expect(await reachableAtBindCeiling(boundary)).toBe("ok");
  });

  /**
   * Every statement the one-hop reachability round actually sends, at a
   * given bind ceiling, captured through a canned-row backend overlay: the
   * real compiler and the real `createOperation` chunk math run, but the
   * seed lookup's `seedNodeCount` working-set rows are supplied rather than
   * read from a live database. The boundary test supplies eight rows so
   * `maxWorkingSetSize` chunking, rather than fixture size, limits each
   * statement. This canned-row technique also lets the recorded case run:
   * a `recordedRelation` binding reads an externally populated relation
   * that a plain write never fills.
   */
  async function expansionStatementWidths(
    edgeKinds: readonly string[],
    maxBindParameters: number,
    recorded: boolean,
    seedNodeCount = 1,
  ): Promise<readonly number[]> {
    const schema = createSqlSchema();
    const captured: number[] = [];
    const seedBackend = createTestBackend();
    const base = disableTransactions(
      deriveBackend(seedBackend, {
        capabilities: { ...seedBackend.capabilities, maxBindParameters },
        execute: <T>(query: unknown): Promise<readonly T[]> => {
          const rendered = renderPostgres(query as SqlFragment);
          // The origin probes bracketing a recorded read are answered, not
          // measured: the widths below are the algorithm's own statements.
          if (isRevisionOriginProbe(rendered.sql)) {
            return Promise.resolve([
              { origin: REVISION_ORIGIN },
            ] as unknown as readonly T[]);
          }
          captured.push(rendered.params.length);
          if (captured.length === 1) {
            return Promise.resolve(
              Array.from({ length: seedNodeCount }, (_, index) => ({
                id: `person-${index + 1}`,
                kind: "Person",
              })) as unknown as readonly T[],
            );
          }
          return Promise.resolve([]);
        },
      }),
    );
    const store = createStore(graph, base, {
      schema,
      ...(recorded ? { recordedRead: recordedRelation({ schema }) } : {}),
    });
    const target =
      recorded ? store.asOfRecorded(RECORDED_AS_OF_REACHABLE) : store;
    const rootRef = { kind: "Person", id: asNodeId("person-1") } as const;
    await target.algorithms.reachable(rootRef, {
      edges: edgeKinds as never,
      maxHops: 1,
      direction: "out",
    });
    return captured;
  }

  it.each([
    ["current", false],
    ["recorded", true],
  ] as const)(
    "keeps the real expansion statement within the backend's bind ceiling, at the boundary and beyond: %s",
    async (_label, recorded) => {
      for (const ceiling of Array.from(
        { length: 6 },
        (_, offset) => boundary + offset,
      )) {
        const widths = await expansionStatementWidths(
          ["knows"],
          ceiling,
          recorded,
          8,
        );
        expect(widths.length).toBeGreaterThan(2);
        for (const width of widths) {
          expect(width).toBeLessThanOrEqual(ceiling);
        }
      }
    },
  );

  it.each([
    ["current", false, 8],
    ["recorded", true, 12],
  ] as const)(
    "solves to the real per-branch fixed binds from a 1-edge-kind and a 2-edge-kind round: %s",
    async (_label, recorded, expectedFixed) => {
      // Held fixed across both calls: one working-set node (person-1), one
      // hop, direction "out". Only the edge-kind count varies, so the fit
      // isolates that marginal cost the same way the separation-probe fit
      // above does.
      const oneKindWidths = await expansionStatementWidths(
        ["knows"],
        999,
        recorded,
      );
      const twoKindWidths = await expansionStatementWidths(
        ["knows", "likes"],
        999,
        recorded,
      );
      // The last capture is the expansion round; the seed lookup precedes it
      // and does not vary with edge-kind count.
      const widthOneKind = requireDefined(oneKindWidths.at(-1));
      const widthTwoKinds = requireDefined(twoKindWidths.at(-1));
      const perKindMarginal = widthTwoKinds - widthOneKind;
      const fixed = widthOneKind - perKindMarginal;
      // Measured, not the source constant (12): the real per-branch fixed
      // cost at one working-set node is 8 at a current pin and 12 at a
      // recorded pin (each node's own two VALUES binds, graph_id, the edge
      // temporal filter, graph_id again for the target-node join, and the
      // node temporal filter — where each temporal filter binds 2
      // parameters at a current pin and 4 at a recorded one, because a
      // recorded pin's filter adds the binding's own `recorded_from`/
      // `recorded_to` predicate on top of the valid-time window).
      // `RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH` budgets only this
      // per-branch cost: the working-set node's own two VALUES binds are
      // excluded from it — `maxWorkingSetSize`'s own `/ 2` in
      // `iterative-graph-operation.ts` reserves for those separately.
      // Excluding them, the real per-branch cost is 6 at a current pin and
      // 10 at a recorded pin, so the constant's real slack is 2, measured at
      // the recorded pin (the coordinate that matters, since that is where
      // the slack is smallest), not the 4 a current-only measurement would
      // suggest: safe (the boundary test above still refuses before any
      // statement widens past a real ceiling), but stale.
      expect(fixed).toBe(expectedFixed);
    },
  );
});

describe("identity read fixed-parameter budgets", () => {
  // These three constants budget the chunk math for identity reads whose
  // fixed fragment is likewise built by a private function reachable only
  // through the read's own chunk-sizing math, not a directly callable
  // builder. Measured the same way as RESERVED_TEMPORAL_BIND_PARAMETERS_PER_BRANCH
  // above: a 1-item and a 2-item call, held under a chunk size the backend's
  // bind ceiling never forces to split.
  //
  // The `loadHistoricalClasses` fit covers all four temporal modes with and
  // without a recorded pin. Its widest fixed cost is 16, at asOf. Bare
  // current is measured for
  // completeness, although production routes it through the current closure
  // path before `loadHistoricalClasses` runs. The other coordinate-dependent
  // fit uses WORST_CASE_COORDINATE (asOf valid-time, recorded pin), where
  // `identityAssertionSnapshotSource` adds recorded bounds to the valid-time
  // window. The assertion-page fit takes no coordinate.
  //
  // Reachability differs per function, so a claim that a function is "only
  // reached at a non-current coordinate" is scoped to `loadHistoricalClasses`
  // alone: `isCurrentClosureCoordinate` routes the current case to a
  // cheaper, unchunked path before `loadHistoricalClasses` is ever called
  // (see `service-facade.ts`'s `areDifferent`/`visibleMembersAtCoordinate`).
  // `loadAssertionsTouching` has no such gate — `service-maintenance.ts`,
  // `service-mutation.ts` (twice) and `service-facade.ts`'s persisted-read
  // path all call it with `coordinate: undefined` (current) in production.
  // It is still measured here at WORST_CASE_COORDINATE because the fixed
  // cost the chunk math budgets for must cover whichever coordinate a call
  // reaches it through, and recorded is the wider one.

  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const Organization = defineNode("Organization", {
    schema: z.object({ name: z.string() }),
  });
  const Project = defineNode("Project", {
    schema: z.object({ name: z.string() }),
  });
  const graph = defineGraph({
    id: "bind-budget-identity-reads",
    nodes: {
      Person: { type: Person },
      Organization: { type: Organization },
      Project: { type: Project },
    },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });
  const schema = createSqlSchema();
  // The kinds the identity reconstruction may cross. The fit table below
  // holds this at one kind so each row reads as the coordinate's own cost;
  // the ceiling check passes every kind the graph declares, as the store
  // does, so the per-kind term of the reservation is exercised too.
  const ALLOWED_KINDS: ReadonlySet<string> = new Set(["Person"]);
  const ALL_GRAPH_KINDS: ReadonlySet<string> = new Set(
    Object.keys(graph.nodes),
  );
  const PLAIN_AS_OF_COORDINATE = {
    valid: { mode: "asOf" as const, asOf: "2025-01-01T00:00:00.000Z" },
  };
  const WORST_CASE_COORDINATE = {
    valid: { mode: "asOf" as const, asOf: "2025-01-01T00:00:00.000Z" },
    recorded: {
      asOf: RECORDED_AS_OF,
    },
  };

  function makeTarget(maxBindParameters: number): Readonly<{
    target: Parameters<typeof loadHistoricalClasses>[0];
    captured: number[];
  }> {
    const captured: number[] = [];
    const target = {
      dialect: "postgres" as const,
      capabilities: { maxBindParameters },
      execute: (query: unknown) => {
        captured.push(renderPostgres(query as SqlFragment).params.length);
        return Promise.resolve([]);
      },
      executeStatement: () => Promise.resolve(undefined),
    };
    return { target: target as never, captured };
  }

  describe("loadHistoricalClasses's fixedParameters constant (src/identity/service-read.ts)", () => {
    // The ceiling check runs at plain asOf, the widest coordinate (15 binds
    // plus one per allowed kind, so 18 with the graph's three kinds), and
    // at asOf+recorded (13 plus one per kind). At a ceiling of 30, a
    // reservation below the real fixed cost overflows: reserving 14 sizes
    // chunks of 8 references, and plain asOf then binds 18 + 16 = 34; a
    // reservation that drops the per-kind term (15) sizes chunks of 7, and
    // plain asOf binds 18 + 14 = 32. With a single allowed kind the second
    // case would bind exactly 30 and pass.
    it.each([
      { label: "asOf", coordinate: PLAIN_AS_OF_COORDINATE },
      { label: "asOf+recorded", coordinate: WORST_CASE_COORDINATE },
    ] as const satisfies readonly Readonly<{
      label: string;
      coordinate: ReadCoordinate;
    }>[])(
      "keeps every $label chunk within the bind ceiling for more references than fit in one chunk, across every graph kind",
      async ({ coordinate }) => {
        const maxBindParameters = 30;
        const { target, captured } = makeTarget(maxBindParameters);
        const references = Array.from({ length: 20 }, (_, index) => ({
          kind: "Person",
          id: `p${index}`,
        }));
        await loadHistoricalClasses(
          target,
          schema,
          graph.id,
          references,
          coordinate,
          "fold",
          ALL_GRAPH_KINDS,
        );
        expect(captured.length).toBeGreaterThan(1);
        for (const width of captured) {
          expect(width).toBeLessThanOrEqual(maxBindParameters);
        }
      },
    );

    // Measured, not the source constant (24 + allowedKinds.size, so 25 for
    // one allowed kind): every cell includes one bind per allowed kind (the
    // three-kind rows measure that term), and the widest fixed cost is 16
    // (asOf, one kind). Plain asOf is wider than asOf+recorded (14). The
    // constant reserves 9 more binds than needed. This safely shrinks
    // chunks, but is stale.
    it.each([
      {
        label: "current",
        coordinate: { valid: { mode: "current" } },
        expectedFixed: 10,
      },
      {
        label: "includeEnded",
        coordinate: { valid: { mode: "includeEnded" } },
        expectedFixed: 6,
      },
      {
        label: "includeTombstones",
        coordinate: { valid: { mode: "includeTombstones" } },
        expectedFixed: 6,
      },
      {
        label: "asOf",
        coordinate: { valid: WORST_CASE_COORDINATE.valid },
        expectedFixed: 16,
      },
      {
        label: "current+recorded",
        coordinate: {
          valid: { mode: "current" },
          recorded: WORST_CASE_COORDINATE.recorded,
        },
        expectedFixed: 14,
      },
      {
        label: "includeEnded+recorded",
        coordinate: {
          valid: { mode: "includeEnded" },
          recorded: WORST_CASE_COORDINATE.recorded,
        },
        expectedFixed: 10,
      },
      {
        label: "includeTombstones+recorded",
        coordinate: {
          valid: { mode: "includeTombstones" },
          recorded: WORST_CASE_COORDINATE.recorded,
        },
        expectedFixed: 10,
      },
      {
        label: "asOf+recorded",
        coordinate: WORST_CASE_COORDINATE,
        expectedFixed: 14,
      },
      {
        label: "asOf, three allowed kinds",
        coordinate: PLAIN_AS_OF_COORDINATE,
        allowedKinds: ALL_GRAPH_KINDS,
        expectedFixed: 18,
      },
      {
        label: "asOf+recorded, three allowed kinds",
        coordinate: WORST_CASE_COORDINATE,
        allowedKinds: ALL_GRAPH_KINDS,
        expectedFixed: 16,
      },
    ] as const satisfies readonly Readonly<{
      label: string;
      coordinate: ReadCoordinate;
      allowedKinds?: ReadonlySet<string>;
      expectedFixed: number;
    }>[])(
      "solves $label fixed binds from 1-reference and 2-reference calls",
      async (row) => {
        const { coordinate, expectedFixed } = row;
        const allowedKinds =
          "allowedKinds" in row ? row.allowedKinds : ALLOWED_KINDS;
        const { target, captured } = makeTarget(999);
        await loadHistoricalClasses(
          target,
          schema,
          graph.id,
          [{ kind: "Person", id: "a" }],
          coordinate,
          "fold",
          allowedKinds,
        );
        const one = requireDefined(captured.at(-1));
        await loadHistoricalClasses(
          target,
          schema,
          graph.id,
          [
            { kind: "Person", id: "a" },
            { kind: "Person", id: "b" },
          ],
          coordinate,
          "fold",
          allowedKinds,
        );
        const two = requireDefined(captured.at(-1));
        const fixed = one - (two - one);
        expect(fixed).toBe(expectedFixed);
      },
    );
  });

  describe("loadAssertionsTouching's fixedParameters constant (src/identity/service-read.ts)", () => {
    it("keeps every chunk within the bind ceiling for more references than fit in one chunk", async () => {
      const maxBindParameters = 29;
      const { target, captured } = makeTarget(maxBindParameters);
      const references = Array.from({ length: 20 }, (_, index) => ({
        kind: "Person",
        id: `p${index}`,
      }));
      await loadAssertionsTouching(
        target,
        schema,
        graph.id,
        references,
        WORST_CASE_COORDINATE,
        "different",
      );
      expect(captured.length).toBeGreaterThan(1);
      for (const width of captured) {
        expect(width).toBeLessThanOrEqual(maxBindParameters);
      }
    });

    it("solves to the real fixed binds from a 1-reference and a 2-reference call", async () => {
      const { target, captured } = makeTarget(999);
      await loadAssertionsTouching(
        target,
        schema,
        graph.id,
        [{ kind: "Person", id: "a" }],
        WORST_CASE_COORDINATE,
        "different",
      );
      const one = requireDefined(captured.at(-1));
      await loadAssertionsTouching(
        target,
        schema,
        graph.id,
        [
          { kind: "Person", id: "a" },
          { kind: "Person", id: "b" },
        ],
        WORST_CASE_COORDINATE,
        "different",
      );
      const two = requireDefined(captured.at(-1));
      const fixed = one - (two - one);
      // Measured, not the source constant (16): the real fixed cost of
      // `loadAssertionsTouching`'s statement at its worst-case coordinate —
      // recorded, with a `relation` argument passed — is 6: graph_id, the
      // recorded binding's `recorded_from`/`recorded_to` pair, the `rel = …`
      // filter, and the valid-time window's `valid_from`/`valid_to` pair, all
      // contributed by the snapshot subquery
      // (`identityAssertionSnapshotSource`); the outer wrapper's OR-matched
      // condition never binds a fixed graph_id of its own. This recorded+relation
      // shape is reached in production: `areDifferent`'s non-current branch
      // (`service-facade.ts`) calls `loadSpanningDifferentAssertion` with
      // `ctx.coordinate`, which can carry a `recorded` pin —
      // `isCurrentClosureCoordinate` routes to the historical branch whenever
      // `coordinate.recorded` is set, regardless of valid-time mode — and
      // `loadSpanningDifferentAssertion` always passes `"different"` through
      // to `loadAssertionsTouching`. So `store.asOfRecorded(x).identity
      // .areDifferent(a, b)` reaches exactly this statement shape.
      // The separation-clearing path in `service-mutation.ts` also calls
      // `loadAssertionsTouching` with relation "different", but always with
      // `coordinate: undefined` (current). At the current coordinate with no
      // relation the fixed cost is only 3. The source constant reserves 10
      // more than the worst case needs: safe, but stale.
      expect(fixed).toBe(6);
    });
  });

  describe("readIdentityAssertionPageAtTarget's node-kind fixedParameters constant (src/identity/interchange-read.ts)", () => {
    /**
     * 9 kinds and `after` set make the real fixed cost 3 (see the fit test
     * below), so at ceiling 20 the correct chunk size is
     * `floor((20-3)/2) = 8`, which is smaller than 9 kinds —
     * `filterKindsInMemory` therefore takes over and no kind list is bound
     * at all. A constant of 2 or less computes a chunk of `floor((20-2)/2) =
     * 9`, which is NOT smaller than 9 kinds, so the kind list inlines
     * instead: 9 kinds × 2 binds each (`a_kind IN (...)` and
     * `b_kind IN (...)`) plus 3 fixed binds is 21, over the ceiling.
     */
    it("keeps the kind-filtered statement within the bind ceiling, with enough kinds and an after cursor to force the real chunk decision", async () => {
      const maxBindParameters = 20;
      const { target, captured } = makeTarget(maxBindParameters);
      const ctx = { schema, graphId: graph.id } as unknown as Parameters<
        typeof readIdentityAssertionPageAtTarget
      >[0];
      const nineKinds = Array.from({ length: 9 }, (_, index) => `Kind${index}`);
      await readIdentityAssertionPageAtTarget(ctx, target, "state", {
        limit: 10,
        after: "some-cursor-id",
        nodeKinds: nineKinds,
      });
      expect(captured.length).toBeGreaterThan(0);
      for (const width of captured) {
        expect(width).toBeLessThanOrEqual(maxBindParameters);
      }
    });

    it("solves to the real fixed binds from a 1-kind and a 2-kind call, with an after cursor set", async () => {
      const { target, captured } = makeTarget(999);
      const ctx = { schema, graphId: graph.id } as unknown as Parameters<
        typeof readIdentityAssertionPageAtTarget
      >[0];
      await readIdentityAssertionPageAtTarget(ctx, target, "state", {
        limit: 10,
        after: "some-cursor-id",
        nodeKinds: ["Person"],
      });
      const one = requireDefined(captured.at(-1));
      await readIdentityAssertionPageAtTarget(ctx, target, "state", {
        limit: 10,
        after: "some-cursor-id",
        nodeKinds: ["Person", "Organization"],
      });
      const two = requireDefined(captured.at(-1));
      const fixed = one - (two - one);
      // Measured, not the source constant (16): the real fixed cost — the
      // statement's own graph_id, limit and (whenever a page after the
      // first is fetched — every production caller pages in a loop, see
      // `export.ts`) `after`-cursor binds — is 3, not the 2 a first-page-only
      // measurement would show. The source constant reserves 13 more than
      // the worst case needs: safe (the kind list is chunked more
      // conservatively than it must be, and an oversized kind list instead
      // falls back to in-memory filtering, never to an unbounded
      // statement), but stale.
      expect(fixed).toBe(3);
    });
  });
});
