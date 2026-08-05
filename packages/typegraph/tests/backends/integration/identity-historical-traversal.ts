/**
 * Equivalence coverage for identity-expanded traversal under a **historical**
 * read coordinate.
 *
 * The compiler reaches identity membership two different ways: a current read
 * seeks the materialized closure, a historical read reconstructs classes from
 * the assertion ledger through a hoisted relation (typegraph#310). The second
 * path has no closure table to check itself against, so this suite checks it
 * against the identity semantics directly: it reads the raw node, edge and
 * assertion rows back out of the backend and re-derives, in TypeScript, the rows
 * an identity-expanded hop must return at a given instant. A divergence in the
 * SQL — a lost class member, a duplicated row, a stale coordinate, a missed
 * visibility rule — shows up as a mismatch against a model that shares no code
 * with the compiler.
 *
 * The fixture deliberately spans the cases where the reconstruction rules stop
 * agreeing with each other:
 *
 * - both identity profiles, `"fold"` and `"ignore"`;
 * - a node whose validity window has ended at the coordinate, and one whose
 *   window has not begun;
 * - a soft-deleted node, which is never a visible *member* yet still holds a
 *   same-id fold together at an instant before its deletion;
 * - an assertion that is valid at some coordinates and retracted at later ones;
 * - two start rows that share one class, which must not duplicate a step;
 * - a two-hop chain and a recursive traversal, where the frontier — and so the
 *   set of classes to reconstruct — changes per step.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { compareStrings } from "../../../src/utils/compare";
import { type IntegrationTestContext } from "./test-context";

const HistPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const HistCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const histLink = defineEdge("link", { schema: z.object({}) });

function historicalIdentityGraph(sameIdAcrossKinds: "fold" | "ignore") {
  return defineGraph({
    id: `identity_historical_${sameIdAcrossKinds}`,
    nodes: { Company: { type: HistCompany }, Person: { type: HistPerson } },
    edges: {
      link: {
        type: histLink,
        from: [HistPerson, HistCompany],
        to: [HistPerson, HistCompany],
      },
    },
    identity: { sameIdAcrossKinds },
  });
}

const FOLD_GRAPH = historicalIdentityGraph("fold");
const IGNORE_GRAPH = historicalIdentityGraph("ignore");

// ============================================================
// Ledger snapshot
// ============================================================

type RawTimestamp = string | Date | null;

type LedgerNode = Readonly<{
  kind: string;
  id: string;
  valid_from: RawTimestamp;
  valid_to: RawTimestamp;
  created_at: RawTimestamp;
  deleted_at: RawTimestamp;
}>;

type LedgerEdge = Readonly<{
  id: string;
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  valid_from: RawTimestamp;
  valid_to: RawTimestamp;
  deleted_at: RawTimestamp;
}>;

type LedgerAssertion = Readonly<{
  rel: string;
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
  valid_from: RawTimestamp;
  valid_to: RawTimestamp;
  deleted_at: RawTimestamp;
}>;

type Ledger = Readonly<{
  assertions: readonly LedgerAssertion[];
  edges: readonly LedgerEdge[];
  nodes: readonly LedgerNode[];
}>;

type NodeRef = Readonly<{ kind: string; id: string }>;

/**
 * Reads the stored rows the identity semantics are defined over. The model
 * derives everything from these rather than from the timestamps the test
 * happened to pass in, so it stays honest about what was actually persisted.
 */
async function readLedger(
  store: Readonly<{ backend: GraphBackend; graphId: string }>,
): Promise<Ledger> {
  const schema = createSqlSchema(store.backend.tableNames);
  const nodes = await store.backend.execute<LedgerNode>(
    asCompiledRowsSql(sql`
      SELECT kind, id, valid_from, valid_to, created_at, deleted_at
      FROM ${schema.nodesTable}
      WHERE graph_id = ${store.graphId}
    `),
  );
  const edges = await store.backend.execute<LedgerEdge>(
    asCompiledRowsSql(sql`
      SELECT id, kind, from_kind, from_id, to_kind, to_id,
             valid_from, valid_to, deleted_at
      FROM ${schema.edgesTable}
      WHERE graph_id = ${store.graphId}
    `),
  );
  const assertions = await store.backend.execute<LedgerAssertion>(
    asCompiledRowsSql(sql`
      SELECT rel, a_kind, a_id, b_kind, b_id, valid_from, valid_to, deleted_at
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${store.graphId}
    `),
  );
  return { assertions, edges, nodes };
}

// ============================================================
// Identity semantics, re-derived
// ============================================================

/** Normalizes a stored instant to epoch milliseconds; `undefined` means unset. */
function instantOf(value: RawTimestamp): number | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Separator for composite `(kind, id)` map keys; no id can contain it. */
const REF_KEY_SEPARATOR = "\u0000";

function refKey(ref: NodeRef): string {
  return `${ref.kind}${REF_KEY_SEPARATOR}${ref.id}`;
}

/** The point-in-time visibility every read applies to a node or edge row. */
function visibleAt(
  row: Readonly<{
    valid_from: RawTimestamp;
    valid_to: RawTimestamp;
    deleted_at: RawTimestamp;
  }>,
  instant: number,
): boolean {
  if (instantOf(row.deleted_at) !== undefined) return false;
  const from = instantOf(row.valid_from);
  const to = instantOf(row.valid_to);
  if (from !== undefined && from > instant) return false;
  if (to !== undefined && to <= instant) return false;
  return true;
}

/**
 * Lifecycle rule for an implicit same-id fold, which is deliberately *not* node
 * visibility: a node soft-deleted after the coordinate still folded with its
 * peer then, even though it is not itself a visible member.
 */
function existedAt(node: LedgerNode, instant: number): boolean {
  const created = instantOf(node.created_at);
  const deleted = instantOf(node.deleted_at);
  if (created !== undefined && created > instant) return false;
  return deleted === undefined || deleted > instant;
}

function assertionHoldsAt(
  assertion: LedgerAssertion,
  instant: number,
): boolean {
  if (assertion.rel !== "same") return false;
  if (instantOf(assertion.deleted_at) !== undefined) return false;
  const from = instantOf(assertion.valid_from);
  const to = instantOf(assertion.valid_to);
  if (from !== undefined && from > instant) return false;
  return to === undefined || to > instant;
}

/** Undirected identity adjacency at `instant`: assertions plus same-id folds. */
function identityAdjacencyAt(
  ledger: Ledger,
  instant: number,
  fold: boolean,
): ReadonlyMap<string, readonly NodeRef[]> {
  const adjacency = new Map<string, NodeRef[]>();
  const connect = (left: NodeRef, right: NodeRef): void => {
    const peers = adjacency.get(refKey(left)) ?? [];
    peers.push(right);
    adjacency.set(refKey(left), peers);
  };
  for (const assertion of ledger.assertions) {
    if (!assertionHoldsAt(assertion, instant)) continue;
    const left = { kind: assertion.a_kind, id: assertion.a_id };
    const right = { kind: assertion.b_kind, id: assertion.b_id };
    connect(left, right);
    connect(right, left);
  }
  if (fold) {
    const present = ledger.nodes.filter((node) => existedAt(node, instant));
    for (const left of present) {
      for (const right of present) {
        if (left.id !== right.id || left.kind === right.kind) continue;
        connect(
          { kind: left.kind, id: left.id },
          { kind: right.kind, id: right.id },
        );
      }
    }
  }
  return adjacency;
}

/**
 * The visible identity class of `seed` at `instant`.
 *
 * The walk itself ignores member visibility — a class can be held together
 * through a member that is not visible — and the result is filtered to visible
 * members afterwards, which is how the reconstruction SQL is layered. A seed
 * that is not visible has no class at all.
 */
function visibleClassAt(
  ledger: Ledger,
  seed: NodeRef,
  instant: number,
  fold: boolean,
): readonly NodeRef[] {
  const nodesByKey = new Map(
    ledger.nodes.map((node) => [
      refKey({ kind: node.kind, id: node.id }),
      node,
    ]),
  );
  const seedNode = nodesByKey.get(refKey(seed));
  if (seedNode === undefined || !visibleAt(seedNode, instant)) return [];
  const adjacency = identityAdjacencyAt(ledger, instant, fold);
  const reached = new Map<string, NodeRef>([[refKey(seed), seed]]);
  const pending: NodeRef[] = [seed];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const peer of adjacency.get(refKey(current)) ?? []) {
      if (reached.has(refKey(peer))) continue;
      reached.set(refKey(peer), peer);
      pending.push(peer);
    }
  }
  return [...reached.values()].filter((member) => {
    const node = nodesByKey.get(refKey(member));
    return node !== undefined && visibleAt(node, instant);
  });
}

function visibleNodesOfKind(
  ledger: Ledger,
  kind: string,
  instant: number,
): readonly LedgerNode[] {
  return ledger.nodes.filter(
    (node) => node.kind === kind && visibleAt(node, instant),
  );
}

/**
 * Outgoing `link` edges an identity-expanded hop can follow from `source`, with
 * the target restricted to visible `Person` nodes — the shape every query below
 * traverses.
 */
function expandedHopsFrom(
  ledger: Ledger,
  source: NodeRef,
  instant: number,
  fold: boolean,
): readonly Readonly<{ edgeId: string; target: NodeRef }>[] {
  const nodesByKey = new Map(
    ledger.nodes.map((node) => [
      refKey({ kind: node.kind, id: node.id }),
      node,
    ]),
  );
  const hops: Readonly<{ edgeId: string; target: NodeRef }>[] = [];
  for (const member of visibleClassAt(ledger, source, instant, fold)) {
    for (const edge of ledger.edges) {
      if (edge.kind !== "link") continue;
      if (edge.from_kind !== member.kind || edge.from_id !== member.id)
        continue;
      if (!visibleAt(edge, instant)) continue;
      if (edge.to_kind !== "Person") continue;
      const target = { kind: edge.to_kind, id: edge.to_id };
      const targetNode = nodesByKey.get(refKey(target));
      if (targetNode === undefined || !visibleAt(targetNode, instant)) continue;
      hops.push({ edgeId: edge.id, target });
    }
  }
  return hops;
}

/** Expected `(start, edge, target)` triples for a single expanded hop. */
function expectedOneHopRows(
  ledger: Ledger,
  instant: number,
  fold: boolean,
): readonly string[] {
  const rows: string[] = [];
  for (const start of visibleNodesOfKind(ledger, "Person", instant)) {
    const startRef = { kind: start.kind, id: start.id };
    for (const hop of expandedHopsFrom(ledger, startRef, instant, fold)) {
      rows.push(`${start.id}|${hop.edgeId}|${hop.target.id}`);
    }
  }
  return rows.toSorted((left, right) => compareStrings(left, right));
}

/** Expected `(start, edge1, edge2, target)` rows for a two-hop chain. */
function expectedTwoHopRows(
  ledger: Ledger,
  instant: number,
  fold: boolean,
): readonly string[] {
  const rows: string[] = [];
  for (const start of visibleNodesOfKind(ledger, "Person", instant)) {
    const startRef = { kind: start.kind, id: start.id };
    for (const first of expandedHopsFrom(ledger, startRef, instant, fold)) {
      for (const second of expandedHopsFrom(
        ledger,
        first.target,
        instant,
        fold,
      )) {
        rows.push(
          `${start.id}|${first.edgeId}|${second.edgeId}|${second.target.id}`,
        );
      }
    }
  }
  return rows.toSorted((left, right) => compareStrings(left, right));
}

/**
 * Expected `(start, target)` rows for a recursive expanded traversal of up to
 * `maxHops` steps under the default `cyclePolicy: "prevent"` — a path may not
 * revisit a node, and node identity under expansion is the composite
 * `(kind, id)`, so two folded peers are distinct waypoints.
 */
function expectedRecursiveRows(
  ledger: Ledger,
  instant: number,
  fold: boolean,
  maxHops: number,
): readonly string[] {
  const rows: string[] = [];
  const walk = (
    start: NodeRef,
    current: NodeRef,
    visited: readonly string[],
    depth: number,
  ): void => {
    if (depth >= maxHops) return;
    for (const hop of expandedHopsFrom(ledger, current, instant, fold)) {
      if (visited.includes(refKey(hop.target))) continue;
      rows.push(`${start.id}|${hop.target.id}`);
      walk(start, hop.target, [...visited, refKey(hop.target)], depth + 1);
    }
  };
  for (const start of visibleNodesOfKind(ledger, "Person", instant)) {
    const startRef = { kind: start.kind, id: start.id };
    walk(startRef, startRef, [refKey(startRef)], 0);
  }
  return rows.toSorted((left, right) => compareStrings(left, right));
}

// ============================================================
// Fixture
// ============================================================

/** Instants the fixture pins its node and edge validity windows to. */
type Timeline = Readonly<{
  /** Everything the fixture creates is valid from here. */
  origin: string;
  /** Inside the ended node's window; before the late node's window. */
  early: string;
  /** After the ended node's window; inside the late node's window. */
  late: string;
}>;

/**
 * Separates two wall-clock samples, so the assertion timeline's coordinates
 * cannot collapse onto one millisecond.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

function buildTimeline(): Timeline {
  const anchor = Date.now();
  return {
    origin: new Date(anchor - 60_000).toISOString(),
    early: new Date(anchor - 45_000).toISOString(),
    late: new Date(anchor - 15_000).toISOString(),
  };
}

/**
 * Builds the fixture graph and returns the coordinates to check it at.
 *
 * Node and edge windows are pinned to synthetic past instants so `early`/`late`
 * exercise ended and not-yet-valid rows deterministically. Assertions carry
 * wall-clock validity — the identity service stamps them itself — so the
 * assertion timeline is sampled as it happens.
 */
async function provisionHistoricalFixture(
  context: IntegrationTestContext,
  profile: "fold" | "ignore",
) {
  const store = await context.createStore(
    profile === "fold" ? FOLD_GRAPH : IGNORE_GRAPH,
  );
  const timeline = buildTimeline();
  const { origin } = timeline;

  const person = async (
    id: string,
    extra?: Readonly<{ validFrom?: string; validTo?: string }>,
  ) =>
    store.nodes.Person.create(
      { name: `Person ${id}` },
      {
        id,
        validFrom: extra?.validFrom ?? origin,
        ...(extra?.validTo === undefined ? {} : { validTo: extra.validTo }),
      },
    );
  const company = async (id: string, extra?: Readonly<{ validTo?: string }>) =>
    store.nodes.Company.create(
      { name: `Company ${id}` },
      {
        id,
        validFrom: origin,
        ...(extra?.validTo === undefined ? {} : { validTo: extra.validTo }),
      },
    );

  // A folded pair: same id under two kinds.
  const sharedPerson = await person("shared");
  const sharedCompany = await company("shared");
  // A three-node class whose middle member is soft-deleted at the end of the
  // fixture: `chain` is asserted same as Person `bridge`, which folds with
  // Company `bridge`. Once Person `bridge` is deleted it is never a visible
  // member again, yet at an instant before the deletion it still holds the fold
  // together — so `chain` reaches Company `bridge`'s edge through a member the
  // read cannot see.
  const chainPerson = await person("chain");
  const bridgePerson = await person("bridge");
  const bridgeCompany = await company("bridge");
  // Distinct ids joined by an assertion, so the class is ledger-derived only.
  const claimPerson = await person("claim-person");
  const claimCompany = await company("claim-company");
  // A second Person in the same class as claimPerson: two start rows, one class.
  const twinPerson = await person("twin-person");
  // Class members that stop being *visible* while their outgoing edge stays
  // valid, so only the member-visibility rule can exclude them: a folded peer
  // whose window ends at `late`, and an asserted peer likewise. Their windows
  // end rather than being deleted, which keeps the class connected — the walk
  // still reaches them, and the visibility filter must drop them.
  const ghostPerson = await person("ghost");
  const ghostCompany = await company("ghost", { validTo: timeline.late });
  const ghostClaimPerson = await person("ghost-claim", {
    validTo: timeline.late,
  });
  // Windowed nodes: ended by `late`, and not yet valid at `early`.
  const endedPerson = await person("ended", { validTo: timeline.late });
  const latePerson = await person("late", { validFrom: timeline.late });
  // Plain targets.
  const targetA = await person("target-a");
  const targetB = await person("target-b");
  const targetC = await person("target-c");

  const link = async (
    from: Readonly<{ kind: "Company" | "Person"; id: string }>,
    to: Readonly<{ kind: "Company" | "Person"; id: string }>,
    id: string,
  ) => store.edges.link.create(from, to, {}, { id, validFrom: origin });

  // Reachable only by expanding the Person frontier onto its Company peer.
  await link(sharedCompany, targetA, "shared-company-a");
  await link(bridgeCompany, targetB, "bridge-company-b");
  await link(claimCompany, targetC, "claim-company-c");
  // A second hop out of a target, for the chained and recursive cases.
  await link(targetA, targetB, "target-a-b");
  await link(targetB, latePerson, "target-b-late");
  // Windowed source and target.
  await link(endedPerson, targetA, "ended-a");
  // Edges out of the members that lose visibility at `late`. The edges stay
  // valid, so a read past `late` must drop them for lack of a visible member.
  await link(ghostCompany, targetC, "ghost-company-c");
  await link(ghostClaimPerson, targetB, "ghost-claim-b");
  // A direct edge that needs no expansion at all, as a control.
  await link(sharedPerson, targetC, "shared-person-c");

  const coordinates: Readonly<{ asOf: string; label: string }>[] = [
    {
      asOf: timeline.early,
      label: "early (ended node live, late node unborn)",
    },
    { asOf: timeline.late, label: "late (ended node ended, late node live)" },
  ];

  const sample = (label: string) => {
    coordinates.push({ asOf: new Date().toISOString(), label });
  };
  sample("before any assertion");
  await settle();
  await store.identity.assertSame(claimPerson, claimCompany);
  await store.identity.assertSame(claimPerson, twinPerson);
  await store.identity.assertSame(chainPerson, bridgePerson);
  await store.identity.assertSame(twinPerson, ghostClaimPerson);
  await store.identity.assertSame(ghostPerson, ghostCompany);
  await settle();
  sample("assertions in force");
  await settle();
  await store.identity.retractSameAssertion(claimPerson, claimCompany);
  await settle();
  sample("one assertion retracted");
  await settle();
  await store.nodes.Person.delete(bridgePerson.id);
  await settle();
  sample("class intermediary soft-deleted");

  return { coordinates, store };
}

// ============================================================
// Suite
// ============================================================

export function registerHistoricalIdentityTraversalTests(
  context: IntegrationTestContext,
): void {
  describe("historical identity-expanded traversal equivalence", () => {
    for (const profile of ["fold", "ignore"] as const) {
      describe(`sameIdAcrossKinds: "${profile}"`, () => {
        const fold = profile === "fold";

        it("matches the identity semantics for a single hop at every coordinate", async () => {
          const { coordinates, store } = await provisionHistoricalFixture(
            context,
            profile,
          );
          const ledger = await readLedger(store);

          for (const coordinate of coordinates) {
            const rows = await store
              .asOf(coordinate.asOf)
              .query()
              .from("Person", "person")
              .traverse("link", "edge", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .to("Person", "friend")
              .select((queryContext) => ({
                edge: queryContext.edge.id,
                friend: queryContext.friend.id,
                start: queryContext.person.id,
              }))
              .execute();
            const actual = rows
              .map((row) => `${row.start}|${row.edge}|${row.friend}`)
              .toSorted((left, right) => compareStrings(left, right));
            const expected = expectedOneHopRows(
              ledger,
              new Date(coordinate.asOf).getTime(),
              fold,
            );

            expect(
              actual,
              `single hop at ${coordinate.label} (${coordinate.asOf})`,
            ).toEqual(expected);
            expect(expected.length).toBeGreaterThan(0);
          }
        });

        it("matches the identity semantics across a two-hop chain", async () => {
          const { coordinates, store } = await provisionHistoricalFixture(
            context,
            profile,
          );
          const ledger = await readLedger(store);

          for (const coordinate of coordinates) {
            const rows = await store
              .asOf(coordinate.asOf)
              .query()
              .from("Person", "person")
              .traverse("link", "first", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .to("Person", "middle")
              .traverse("link", "second", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .to("Person", "friend")
              .select((queryContext) => ({
                first: queryContext.first.id,
                friend: queryContext.friend.id,
                second: queryContext.second.id,
                start: queryContext.person.id,
              }))
              .execute();
            const actual = rows
              .map(
                (row) =>
                  `${row.start}|${row.first}|${row.second}|${row.friend}`,
              )
              .toSorted((left, right) => compareStrings(left, right));
            const expected = expectedTwoHopRows(
              ledger,
              new Date(coordinate.asOf).getTime(),
              fold,
            );

            expect(
              actual,
              `two-hop chain at ${coordinate.label} (${coordinate.asOf})`,
            ).toEqual(expected);
          }
        });

        it("matches the identity semantics across a recursive traversal", async () => {
          const { coordinates, store } = await provisionHistoricalFixture(
            context,
            profile,
          );
          const ledger = await readLedger(store);
          const maxHops = 3;

          for (const coordinate of coordinates) {
            const rows = await store
              .asOf(coordinate.asOf)
              .query()
              .from("Person", "person")
              .traverse("link", "edge", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .recursive({ maxHops })
              .to("Person", "friend")
              .select((queryContext) => ({
                friend: queryContext.friend.id,
                start: queryContext.person.id,
              }))
              .execute();
            const actual = rows
              .map((row) => `${row.start}|${row.friend}`)
              .toSorted((left, right) => compareStrings(left, right));
            const expected = expectedRecursiveRows(
              ledger,
              new Date(coordinate.asOf).getTime(),
              fold,
              maxHops,
            );

            expect(
              actual,
              `recursive traversal at ${coordinate.label} (${coordinate.asOf})`,
            ).toEqual(expected);
          }
        });
      });
    }
  });
}
