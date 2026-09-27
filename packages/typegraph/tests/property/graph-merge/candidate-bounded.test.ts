import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  type CandidateWriteSet,
  captureCandidateWriteSetTarget,
  planCandidateWriteSet,
  planMergeIncremental,
} from "../../../src/graph-merge";
import { ingestionBranch } from "../../../src/graph-merge/ingestion-branch";
import { canonicalMergePlanJson } from "../../../src/graph-merge/plan-canonical";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { importGraph } from "../../../src/interchange";
import { createSqliteMergeBackend } from "../../graph-merge/test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Alias = defineNode("Alias", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});
const graph = defineGraph({
  id: "candidate-bounded-property",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
const identityGraph = defineGraph({
  id: "candidate-bounded-identity-property",
  identity: { sameIdAcrossKinds: "fold" },
  nodes: { Person: { type: Person }, Alias: { type: Alias } },
  edges: {},
});

const FROM = "2026-01-01T00:00:00.000Z";
const END = "2028-01-01T00:00:00.000Z";

describe("bounded candidate planning", () => {
  it("matches full-clone identity planning across classes, folded ids, and unrelated assertions", async () => {
    let successfulPlans = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          unrelatedCount: fc.integer({ min: 0, max: 8 }),
          foldedPeer: fc.boolean(),
          endedUnrelated: fc.boolean(),
          relation: fc.constantFrom("same" as const, "different" as const),
        }),
        async ({ unrelatedCount, foldedPeer, endedUnrelated, relation }) => {
          const fixture = createSqliteMergeBackend();
          try {
            const [target] = await createStoreWithSchema(
              identityGraph,
              fixture.backend,
              { revisionTracking: true },
            );
            const first = await target.nodes.Person.create(
              { name: "First" },
              { id: "first", validFrom: FROM },
            );
            const bridge = await target.nodes.Person.create(
              { name: "Bridge" },
              { id: "bridge", validFrom: FROM },
            );
            await target.nodes.Person.create(
              { name: "Second" },
              { id: "second", validFrom: FROM },
            );
            if (foldedPeer)
              await target.nodes.Alias.create(
                { name: "Folded peer" },
                { id: first.id, validFrom: FROM },
              );
            await target.identity.assertSame(first, bridge);
            for (let index = 0; index < unrelatedCount; index += 1) {
              const left = await target.nodes.Person.create(
                { name: `Unrelated left ${index}` },
                { id: `unrelated-left-${index}`, validFrom: FROM },
              );
              const right = await target.nodes.Person.create(
                { name: `Unrelated right ${index}` },
                { id: `unrelated-right-${index}`, validFrom: FROM },
              );
              const asserted = await target.identity.assertDifferent(
                left,
                right,
              );
              if (endedUnrelated && index % 2 === 0)
                await target.identity.retractAssertion(asserted.assertion.id);
            }
            const writeSet: CandidateWriteSet = {
              formatVersion: 1,
              sourceId: "identity-property-source",
              target: await captureCandidateWriteSetTarget(target),
              nodes: [],
              edges: [],
              identity: {
                profile: "typegraph-identity-v1",
                mode: "state",
                assertions: [
                  {
                    id: "candidate-relation",
                    relation,
                    a: { kind: "Person", id: bridge.id },
                    b: { kind: "Person", id: "second" },
                    validFrom: FROM,
                  },
                ],
              },
            };
            const bounded = await planCandidateWriteSet({
              target,
              makeBackend: async () => createSqliteMergeBackend().backend,
              writeSet,
            });
            const full = unwrap(
              await ingestionBranch(
                target,
                async () => createSqliteMergeBackend().backend,
                { id: asBranchId(writeSet.sourceId) },
              ),
            );
            try {
              const imported = await importGraph(
                full,
                {
                  formatVersion: "2.0",
                  exportedAt: "1970-01-01T00:00:00.000Z",
                  source: { type: "external" },
                  nodes: writeSet.nodes,
                  edges: writeSet.edges,
                  identity: writeSet.identity,
                },
                {
                  onConflict: "update",
                  onUnknownProperty: "error",
                  validateReferences: true,
                  refreshStatistics: false,
                },
              );
              const fullPlan =
                imported.success ?
                  await planMergeIncremental({
                    forkPoint: target,
                    target,
                    branches: [full],
                  })
                : undefined;
              if (
                !imported.success ||
                (fullPlan !== undefined && isErr(fullPlan))
              ) {
                expect(isErr(bounded)).toBe(true);
              } else if (fullPlan !== undefined) {
                successfulPlans += 1;
                expect(isErr(bounded)).toBe(false);
                if (!isErr(bounded))
                  expect(canonicalMergePlanJson(bounded.data)).toBe(
                    canonicalMergePlanJson(unwrap(fullPlan)),
                  );
              }
            } finally {
              await full.close();
            }
          } finally {
            await fixture.cleanup();
          }
        },
      ),
      { numRuns: 20 },
    );
    expect(successfulPlans).toBeGreaterThan(0);
  });
  it("matches full-clone planning across unrelated rows, overlaps, windows, tombstones, and edge updates", async () => {
    let successfulPlans = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          unrelatedCount: fc.integer({ min: 0, max: 12 }),
          overlap: fc.boolean(),
          ended: fc.boolean(),
          tombstone: fc.boolean(),
          repoint: fc.boolean(),
        }),
        async ({ unrelatedCount, overlap, ended, tombstone, repoint }) => {
          const fixture = createSqliteMergeBackend();
          try {
            const [target] = await createStoreWithSchema(
              graph,
              fixture.backend,
              {
                revisionTracking: true,
              },
            );
            const left = await target.nodes.Person.create(
              { name: "Left" },
              { id: "left", validFrom: FROM },
            );
            const right = await target.nodes.Person.create(
              { name: "Right" },
              { id: "right", validFrom: FROM },
            );
            const tombstoned = await target.nodes.Person.create(
              { name: "Old" },
              { id: "reused", validFrom: FROM },
            );
            if (tombstone) await target.nodes.Person.delete(tombstoned.id);
            for (let index = 0; index < unrelatedCount; index += 1) {
              await target.nodes.Person.create(
                { name: `Unrelated ${index}` },
                { id: `unrelated-${index}`, validFrom: FROM },
              );
            }
            await target.edges.knows.create(
              left,
              right,
              { since: "before" },
              { id: "existing-edge", validFrom: FROM },
            );
            const writeSet: CandidateWriteSet = {
              formatVersion: 1,
              sourceId: "property-source",
              target: await captureCandidateWriteSetTarget(target),
              nodes: [
                {
                  kind: "Person",
                  id: overlap ? "left" : "new",
                  properties: { name: "Candidate" },
                  validFrom: FROM,
                  ...(ended ? { validTo: END } : {}),
                },
                {
                  kind: "Person",
                  id: "reused",
                  properties: { name: "Reused" },
                  validFrom: FROM,
                },
              ],
              edges: [
                {
                  kind: "knows",
                  id: repoint ? "existing-edge" : "new-edge",
                  from: { kind: "Person", id: "left" },
                  to: { kind: "Person", id: overlap ? "reused" : "new" },
                  properties: { since: "candidate" },
                  validFrom: FROM,
                  ...(ended ? { validTo: END } : {}),
                },
              ],
            };
            const bounded = await planCandidateWriteSet({
              target,
              makeBackend: async () => createSqliteMergeBackend().backend,
              writeSet,
            });
            const full = unwrap(
              await ingestionBranch(
                target,
                async () => createSqliteMergeBackend().backend,
                { id: asBranchId(writeSet.sourceId) },
              ),
            );
            try {
              const imported = await importGraph(
                full,
                {
                  formatVersion: "2.0",
                  exportedAt: "1970-01-01T00:00:00.000Z",
                  source: { type: "external" },
                  nodes: writeSet.nodes,
                  edges: writeSet.edges,
                },
                {
                  onConflict: "update",
                  onUnknownProperty: "error",
                  validateReferences: true,
                  refreshStatistics: false,
                },
              );
              const fullPlan =
                imported.success ?
                  await planMergeIncremental({
                    forkPoint: target,
                    target,
                    branches: [full],
                  })
                : undefined;
              if (!imported.success) {
                expect(isErr(bounded)).toBe(true);
              } else if (fullPlan !== undefined && isErr(fullPlan)) {
                expect(isErr(bounded)).toBe(true);
                if (isErr(bounded))
                  expect(bounded.error.code).toBe(fullPlan.error.code);
              } else if (fullPlan !== undefined) {
                successfulPlans += 1;
                expect(isErr(bounded)).toBe(false);
                if (!isErr(bounded))
                  expect(canonicalMergePlanJson(bounded.data)).toBe(
                    canonicalMergePlanJson(unwrap(fullPlan)),
                  );
              }
            } finally {
              await full.close();
            }
          } finally {
            await fixture.cleanup();
          }
        },
      ),
      { numRuns: 20 },
    );
    expect(successfulPlans).toBeGreaterThan(0);
  });
});
