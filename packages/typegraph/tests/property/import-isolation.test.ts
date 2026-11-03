/**
 * Metamorphic law for a validating import: a refused row leaves no trace.
 *
 * A random payload over the round-trip graph (see
 * `interchange-composition-model.ts`) carries rows the import must refuse per
 * row — required parts with no composition edge, a part's second whole, a
 * section edge closing a cycle, a second `one`-cardinality edge, a second
 * whole with a taken unique name, an edge naming a node the payload never
 * defines — alongside rows it must accept. Importing it reports some errors
 * `E`; importing the SAME payload minus the rows `E` names, into a fresh
 * store, must then:
 *
 * - report no error at all (every refusal was the row's own, not collateral
 *   damage the reduced payload no longer triggers),
 * - report the same created counts, equal to the reduced payload's row counts,
 * - leave the same rows, windows, uniqueness reservations and standing claims,
 * - and leave `verifyConstraintFences()` empty on both stores.
 *
 * Every payload also carries a conflict-free anchor fragment
 * ({@link ANCHOR_ID}) that must be accepted outright.
 *
 * The oracle needs no model of which rows are refused: the store states
 * that itself, and the law checks the statement is consistent with what the
 * store kept. A refused row that leaked a partial write (a node row, a claim,
 * an edge whose savepoint was released rather than rolled back) breaks the
 * state equality; a refusal reported for a row that was in fact kept, or
 * kept for a row that was reported, breaks the count or error equality.
 *
 * MUTATION CHECK (src/interchange/import.ts, each verified and reverted):
 * - a refused edge's savepoint RELEASED instead of rolled back
 *   (`{ action: "release", value: guarded }`) — its partial writes survive;
 * - the purge no longer subtracting a removed edge from `edges.created`;
 * - `readUnattachableRequiredParts` ignoring payload edges that name a part
 *   (dropping `if (namedByPayloadEdge.has(key)) continue;`) — the anchor's
 *   required parts are refused before their edge is written.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../../src";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../src/interchange";
import { dumpRoundTripState } from "../state-snapshot";
import { createTestBackend } from "../test-utils";
import {
  BASE_INSTANT,
  buildRoundTripGraph,
  ID_POOL,
  instantAt,
  liveSlice,
  PART_RELATIONS,
  type RoundTripStore,
  SECTION_KIND,
  WHOLE_KIND,
} from "./interchange-composition-model";
import { propertyRuns } from "./run-budget";

const NAMES = ["alpha", "beta", "gamma", "delta"] as const;
/** An id no payload defines, so an edge naming it is a dangling reference. */
const MISSING_ID = "missing";
/**
 * The id of a conflict-free fragment every payload carries: a whole with a
 * name no other row uses and one part of every kind attached to it by one
 * current edge. Nothing else names these rows, so the import must accept all
 * of them — the liveness half of the law, which a refusal reported
 * consistently in both imports (over-refusal) would otherwise pass.
 */
const ANCHOR_ID = "anchor";

type NodeRow = GraphData["nodes"][number];
type EdgeRow = GraphData["edges"][number];

const windowArb = fc.constantFrom(
  { validFrom: instantAt(0) },
  { validFrom: instantAt(1) },
  { validFrom: instantAt(0), validTo: instantAt(1) },
);

const nodeIdArb = fc.constantFrom(...ID_POOL);
const endpointIdArb = fc.oneof(
  { weight: 9, arbitrary: nodeIdArb },
  { weight: 1, arbitrary: fc.constant(MISSING_ID) },
);

const payloadArb: fc.Arbitrary<GraphData> = fc
  .record({
    // Every pool id names a whole, so a dangling reference is a deliberate
    // `MISSING_ID` or a whole refused for its name, not an accident.
    wholes: fc.tuple(
      ...ID_POOL.map((id) =>
        fc.record({ id: fc.constant(id), name: fc.constantFrom(...NAMES) }),
      ),
    ),
    parts: fc.array(
      fc.record({
        relation: fc.integer({ min: 0, max: PART_RELATIONS.length - 1 }),
        id: nodeIdArb,
        wholes: fc.array(fc.record({ id: endpointIdArb, window: windowArb }), {
          maxLength: 2,
        }),
      }),
      { maxLength: 8 },
    ),
    links: fc.array(
      fc.record({
        from: endpointIdArb,
        to: endpointIdArb,
        primary: fc.boolean(),
        window: windowArb,
      }),
      { maxLength: 4 },
    ),
  })
  .map(({ wholes, parts, links }) => {
    const nodes = new Map<string, NodeRow>();
    function addNode(kind: string, id: string, properties: object): void {
      const key = `${kind}:${id}`;
      if (nodes.has(key)) return;
      nodes.set(key, {
        kind,
        id,
        properties: { ...properties },
        validFrom: BASE_INSTANT,
      });
    }
    for (const whole of wholes) {
      addNode(WHOLE_KIND, whole.id, { name: whole.name });
    }
    const edges: EdgeRow[] = [];
    function addEdge(
      kind: string,
      from: Readonly<{ kind: string; id: string }>,
      to: Readonly<{ kind: string; id: string }>,
      window: Readonly<{ validFrom: string; validTo?: string }>,
      properties: object = {},
    ): void {
      edges.push({
        kind,
        id: `e${String(edges.length)}`,
        from,
        to,
        properties: { ...properties },
        ...window,
      });
    }
    for (const part of parts) {
      const relation = PART_RELATIONS[part.relation];
      if (relation === undefined) continue;
      addNode(relation.part, part.id, {});
      for (const whole of part.wholes) {
        addEdge(
          relation.via,
          { kind: relation.part, id: part.id },
          { kind: relation.whole, id: whole.id },
          whole.window,
        );
      }
    }
    for (const [index, link] of links.entries()) {
      addEdge(
        link.primary ? "rtPrimary" : "rtLink",
        { kind: WHOLE_KIND, id: link.from },
        { kind: WHOLE_KIND, id: link.to },
        link.window,
        link.primary ? {} : { weight: index },
      );
    }
    addNode(WHOLE_KIND, ANCHOR_ID, { name: ANCHOR_ID });
    for (const relation of PART_RELATIONS) {
      if (relation.whole !== WHOLE_KIND) continue;
      addNode(relation.part, ANCHOR_ID, {});
      addEdge(
        relation.via,
        { kind: relation.part, id: ANCHOR_ID },
        { kind: WHOLE_KIND, id: ANCHOR_ID },
        { validFrom: instantAt(0) },
      );
    }
    return {
      formatVersion: FORMAT_VERSION,
      exportedAt: "2024-01-01T00:00:00.000Z",
      source: { type: "external" as const },
      nodes: [...nodes.values()],
      edges,
    };
  });

/** Sections reference each other, so a random payload can close a cycle. */
function withSectionCycles(data: GraphData): GraphData {
  const sections = data.nodes.filter((node) => node.kind === SECTION_KIND);
  return sections.length < 2 ?
      data
    : {
        ...data,
        edges: [
          ...data.edges,
          ...sections.map((section, index): EdgeRow => ({
            kind: "rtSectionOf",
            id: `cycle-${String(index)}`,
            from: { kind: SECTION_KIND, id: section.id },
            to: {
              kind: SECTION_KIND,
              id: sections[(index + 1) % sections.length]?.id ?? section.id,
            },
            properties: {},
            validFrom: instantAt(0),
          })),
        ],
      };
}

async function createStore(): Promise<RoundTripStore> {
  const [store] = await createStoreWithSchema(
    buildRoundTripGraph({ id: "import_isolation", identity: false }),
    createTestBackend(),
  );
  return store;
}

function withoutRows(
  data: GraphData,
  errors: readonly Readonly<{ entityType: string; kind: string; id: string }>[],
): GraphData {
  const refused = new Set(
    errors.map((error) => `${error.entityType}:${error.kind}:${error.id}`),
  );
  return {
    ...data,
    nodes: data.nodes.filter(
      (node) => !refused.has(`node:${node.kind}:${node.id}`),
    ),
    edges: data.edges.filter(
      (edge) => !refused.has(`edge:${edge.kind}:${edge.id}`),
    ),
  };
}

function anchorEdgeIds(data: GraphData): readonly string[] {
  return data.edges
    .filter((edge) => edge.from.id === ANCHOR_ID)
    .map((edge) => edge.id);
}

describe("validating import isolates every refused row", () => {
  it("import(doc) leaves exactly what import(doc minus its refused rows) leaves", async () => {
    let refusedRows = 0;
    await fc.assert(
      fc.asyncProperty(
        payloadArb.map((data) => withSectionCycles(data)),
        fc.constantFrom(1, 3, 1000),
        async (data, batchSize) => {
          const full = await createStore();
          const fullResult = await importGraph(full, data, {
            onConflict: "error",
            batchSize,
          });
          refusedRows += fullResult.errors.length;
          expect(
            fullResult.errors.filter(
              (error) =>
                error.id === ANCHOR_ID ||
                anchorEdgeIds(data).includes(error.id),
            ),
          ).toEqual([]);

          const reducedData = withoutRows(data, fullResult.errors);
          const reduced = await createStore();
          const reducedResult = await importGraph(reduced, reducedData, {
            onConflict: "error",
            batchSize,
          });

          expect(reducedResult.errors).toEqual([]);
          expect(fullResult.nodes).toEqual(reducedResult.nodes);
          expect(fullResult.edges).toEqual(reducedResult.edges);
          expect(reducedResult.nodes.created).toBe(reducedData.nodes.length);
          expect(reducedResult.edges.created).toBe(reducedData.edges.length);
          expect(
            liveSlice(await dumpRoundTripState(full, { transitions: "all" })),
          ).toEqual(
            liveSlice(
              await dumpRoundTripState(reduced, { transitions: "all" }),
            ),
          );
          expect(await full.verifyConstraintFences()).toEqual([]);
          expect(await reduced.verifyConstraintFences()).toEqual([]);
        },
      ),
      { numRuns: propertyRuns({ ci: 60, local: 100 }) },
    );
    // Payloads that never trip a refusal would make the law vacuous.
    expect(refusedRows).toBeGreaterThan(0);
  }, 120_000);
});
