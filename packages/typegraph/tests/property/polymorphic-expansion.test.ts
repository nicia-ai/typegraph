/**
 * A polymorphic `from(K)` / `to(K)` returns rows of exactly the kinds
 * assignable to `K` — `K` itself plus everything below it through
 * `subClassOf`, where an `equivalentTo` pair counts as a subclass edge both
 * ways — over a random ontology. The reference closure is a plain BFS over the
 * declared relations, sharing nothing with the registry's collapsed-closure
 * build (equivalence representatives, transitive closure, inversion,
 * re-expansion), which is where a wrong fold would hide.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  equivalentTo,
  type OntologyRelation,
  subClassOf,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { propertyRuns } from "./run-budget";

const KIND_NAMES = ["PeK0", "PeK1", "PeK2", "PeK3", "PeK4", "PeK5"] as const;
type KindName = (typeof KIND_NAMES)[number];

const KIND_TYPES = KIND_NAMES.map((name) =>
  defineNode(name, { schema: z.object({}) }),
);
const Anchor = defineNode("PeAnchor", { schema: z.object({}) });
const peLinks = defineEdge("peLinks", { schema: z.object({}) });

function kindType(index: number) {
  const type = KIND_TYPES[index];
  if (type === undefined) throw new Error(`no kind at index ${index}`);
  return type;
}

type OntologyCase = Readonly<{
  /** `[child, parent]` index pairs; child > parent keeps `subClassOf` acyclic. */
  subClass: readonly (readonly [number, number])[];
  equivalent: readonly (readonly [number, number])[];
}>;

const indexPair = fc
  .tuple(
    fc.integer({ min: 0, max: KIND_NAMES.length - 1 }),
    fc.integer({ min: 0, max: KIND_NAMES.length - 1 }),
  )
  .filter(([left, right]) => left !== right);

const ontologyCaseArbitrary: fc.Arbitrary<OntologyCase> = fc.record({
  subClass: fc.uniqueArray(
    indexPair.map(
      ([left, right]) =>
        [Math.max(left, right), Math.min(left, right)] as const,
    ),
    { maxLength: 7, selector: ([child, parent]) => `${child}<${parent}` },
  ),
  equivalent: fc.uniqueArray(
    indexPair.map(
      ([left, right]) =>
        [Math.min(left, right), Math.max(left, right)] as const,
    ),
    { maxLength: 2, selector: ([left, right]) => `${left}=${right}` },
  ),
});

function buildGraph(ontologyCase: OntologyCase, runId: number) {
  const ontology: OntologyRelation[] = [
    ...ontologyCase.subClass.map(([child, parent]) =>
      subClassOf(kindType(child), kindType(parent)),
    ),
    ...ontologyCase.equivalent.map(([left, right]) =>
      equivalentTo(kindType(left), kindType(right)),
    ),
  ];
  return defineGraph({
    id: `property_polymorphic_expansion_${runId}`,
    nodes: {
      PeAnchor: { type: Anchor },
      PeK0: { type: kindType(0) },
      PeK1: { type: kindType(1) },
      PeK2: { type: kindType(2) },
      PeK3: { type: kindType(3) },
      PeK4: { type: kindType(4) },
      PeK5: { type: kindType(5) },
    },
    edges: {
      peLinks: { type: peLinks, from: [Anchor], to: KIND_TYPES },
    },
    ontology,
  });
}

/** Every kind reachable from `root` by stepping to a declared subclass or to either side of an equivalence. */
function referenceClosure(
  ontologyCase: OntologyCase,
  root: number,
): readonly KindName[] {
  const below = new Map<number, number[]>();
  function link(from: number, to: number): void {
    const targets = below.get(from) ?? [];
    targets.push(to);
    below.set(from, targets);
  }
  for (const [child, parent] of ontologyCase.subClass) link(parent, child);
  for (const [left, right] of ontologyCase.equivalent) {
    link(left, right);
    link(right, left);
  }
  const reached = new Set([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const target of below.get(next) ?? []) {
      if (reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  return [...reached]
    .map((index) => KIND_NAMES[index])
    .filter((name): name is KindName => name !== undefined)
    .toSorted();
}

function sortedKinds(rows: readonly string[]): readonly string[] {
  return rows.toSorted();
}

describe("property: polymorphic expansion follows the declared subsumption closure", () => {
  it("from(K) and to(K) return exactly the kinds assignable to K, with and without a stated subclasses axis", async () => {
    let runId = 0;
    await fc.assert(
      fc.asyncProperty(ontologyCaseArbitrary, async (ontologyCase) => {
        runId += 1;
        const { backend } = createLocalSqliteBackend();
        try {
          const [store] = await createStoreWithSchema(
            buildGraph(ontologyCase, runId),
            backend,
          );
          const anchor = await store.nodes.PeAnchor.create({});
          for (const name of KIND_NAMES) {
            const node = await store.nodes[name].create({});
            await store.edges.peLinks.create(anchor, node, {});
          }

          for (const [index, name] of KIND_NAMES.entries()) {
            const expected = referenceClosure(ontologyCase, index);
            const reads = {
              "from()": () =>
                store
                  .query()
                  .from(name, "n")
                  .select((ctx) => ctx.n.kind)
                  .execute(),
              'from() expansion: "subclasses"': () =>
                store
                  .query()
                  .from(name, "n", { expansion: "subclasses" })
                  .select((ctx) => ctx.n.kind)
                  .execute(),
              "to()": () =>
                store
                  .query()
                  .from("PeAnchor", "a")
                  .traverse("peLinks", "e")
                  .to(name, "n")
                  .select((ctx) => ctx.n.kind)
                  .execute(),
              'to() expansion: "subclasses"': () =>
                store
                  .query()
                  .from("PeAnchor", "a")
                  .traverse("peLinks", "e")
                  .to(name, "n", { expansion: "subclasses" })
                  .select((ctx) => ctx.n.kind)
                  .execute(),
            };
            for (const [surface, read] of Object.entries(reads)) {
              expect({
                kind: name,
                surface,
                kinds: sortedKinds(await read()),
              }).toEqual({ kind: name, surface, kinds: expected });
            }
          }
        } finally {
          await backend.close();
        }
      }),
      { numRuns: propertyRuns({ ci: 25, local: 60 }) },
    );
  });
});
