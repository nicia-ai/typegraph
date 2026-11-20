/**
 * The identity semantics an identity-expanded traversal must obey, re-derived in
 * TypeScript from the rows the backend actually persisted, plus the fixture that
 * exercises them.
 *
 * The compiler reaches identity membership two different ways: a current read
 * reads the materialized closure, a historical read reconstructs classes from
 * the assertion ledger. Neither path can be checked against the other, so both
 * are checked against this model instead — it reads the raw node, edge and
 * assertion rows back out of the backend and derives the rows an
 * identity-expanded hop must return at an instant: point-in-time visibility, the
 * same-id fold lifecycle (which is deliberately *not* node visibility),
 * assertion windows, the class walk, and path multiplicity. The model shares no
 * code with the compiler, and it passes unchanged on `main`, so it is an
 * equivalence check against the semantics rather than a restatement of whatever
 * the SQL happens to do.
 *
 * One model serves both coordinates because the current closure *is* the class
 * relation at `now`: the identity service builds it from nodes that are not
 * soft-deleted and assertions valid at the write instant — which is exactly what
 * {@link identityAdjacencyAt} derives when the instant is the present.
 *
 * The fixture deliberately spans the cases where the rules stop agreeing with
 * each other:
 *
 * - both identity profiles, `"fold"` and `"ignore"`;
 * - a node whose validity window has ended, and one whose window has not begun;
 * - a soft-deleted node, which is never a visible *member* yet still holds a
 *   same-id fold together at an instant before its deletion;
 * - an assertion that is valid at some coordinates and retracted at later ones;
 * - two start rows that share one class, which must not duplicate a step;
 * - a cyclic class, and two of its members carrying an edge to the same target,
 *   the two shapes where a hop could multiply rows per identity path;
 * - a multi-member class in which only one member carries the edge, so a class
 *   of *k* members must still yield that physical edge exactly once.
 */
import { expect } from "vitest";
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
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const IdentityPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const IdentityCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const identityLink = defineEdge("link", { schema: z.object({}) });

function identityTraversalGraph(sameIdAcrossKinds: "fold" | "ignore") {
  return defineGraph({
    id: `identity_traversal_${sameIdAcrossKinds}`,
    nodes: {
      Company: { type: IdentityCompany },
      Person: { type: IdentityPerson },
    },
    edges: {
      link: {
        type: identityLink,
        from: [IdentityPerson, IdentityCompany],
        to: [IdentityPerson, IdentityCompany],
      },
    },
    identity: { sameIdAcrossKinds },
  });
}

const FOLD_GRAPH = identityTraversalGraph("fold");
export const IGNORE_GRAPH = identityTraversalGraph("ignore");

export type IdentityProfile = "fold" | "ignore";

function graphForProfile(profile: IdentityProfile) {
  return profile === "fold" ? FOLD_GRAPH : IGNORE_GRAPH;
}

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

export type Ledger = Readonly<{
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
export async function readLedger(
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
 * members afterwards, which is how the class relation is layered on both paths.
 * A seed that is not visible has no class at all.
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
 * the target restricted to visible `Person` nodes — the shape every query in
 * both suites traverses.
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
export function expectedOneHopRows(
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
export function expectedTwoHopRows(
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
export function expectedRecursiveRows(
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
 * Separates two wall-clock samples, so an assertion timeline's coordinates
 * cannot collapse onto one millisecond.
 */
export async function settle(milliseconds = 5): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
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
 * Builds the fixture graph and returns the historical coordinates to check it
 * at. A current-coordinate suite ignores those and reads the present, where the
 * timeline's windows have all closed: every `late` boundary is already in the
 * past when provisioning returns, so no window edge can be crossed by the drift
 * between sampling `now` and running a query.
 *
 * Node and edge windows are pinned to synthetic past instants so `early`/`late`
 * exercise ended and not-yet-valid rows deterministically. Assertions carry
 * wall-clock validity — the identity service stamps them itself — so the
 * assertion timeline is sampled as it happens.
 */
/** A historical instant to check the fixture at, with a label for failures. */
type FixtureCoordinate = Readonly<{ asOf: string; label: string }>;

export type IdentityFixture = Readonly<{
  coordinates: readonly FixtureCoordinate[];
  store: InspectableStore<typeof FOLD_GRAPH>;
}>;

export async function provisionIdentityFixture(
  context: IntegrationTestContext,
  profile: IdentityProfile,
): Promise<IdentityFixture> {
  const store = await context.createStore(graphForProfile(profile));
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
  // A cyclic class whose members share one target. Two rules that each look
  // right in isolation can still multiply rows here: the class walk reaches
  // `cycle-c` both directly and the long way round, and two distinct members
  // carry an edge to the *same* physical target. An expanded hop must yield one
  // row per traversed edge — not one per identity path, and not one per member
  // pairing.
  const cycleA = await person("cycle-a");
  const cycleB = await person("cycle-b");
  const cycleC = await person("cycle-c");
  // A four-member class in which exactly one member carries the outgoing edge.
  // Pairing a seed with every member of its class yields k rows per seed, so a
  // relation that lost its uniqueness would multiply this single physical edge
  // by four.
  const wideA = await person("wide-a");
  const wideB = await person("wide-b");
  const wideC = await person("wide-c");
  const wideCompany = await company("wide-a");
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
  // Two members of the cyclic class, one shared target.
  await link(cycleB, targetA, "cycle-b-a");
  await link(cycleC, targetA, "cycle-c-a");
  // The wide class's single outgoing edge, from the member no start row is.
  await link(wideCompany, targetC, "wide-company-c");

  const coordinates: FixtureCoordinate[] = [
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
  await store.identity.assertSame(cycleA, cycleB);
  await store.identity.assertSame(cycleB, cycleC);
  await store.identity.assertSame(cycleC, cycleA);
  await store.identity.assertSame(wideA, wideB);
  await store.identity.assertSame(wideB, wideC);
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

/**
 * Asserts a projected row set matches the model, and that the model expected
 * something — a suite that silently expected zero rows would pass against a
 * traversal that returned nothing at all.
 */
export function expectRowsMatchModel(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  expect(
    actual.toSorted((left, right) => compareStrings(left, right)),
    `${label}: rows differ from the identity model`,
  ).toEqual(expected);
  expect(expected.length, `${label}: model expected no rows`).toBeGreaterThan(
    0,
  );
}
