/**
 * `nodes.<Kind>.delete(id, { expect })` at the collection boundary: what an
 * untyped caller's options are refused for, what the types refuse, and what
 * operation hooks see of a refused guarded delete. The plan comparison itself
 * is exercised on every backend in
 * `tests/backends/integration/composition-delete-plan.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type NodeDeletePlan,
  NodeDeletePlanMismatchError,
  type OperationHookContext,
  partOf,
  type Store,
  ValidationError,
} from "../src";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend, matchingArray } from "./test-utils";

const DeShow = defineNode("DeShow", { schema: z.object({}) });
const DeClip = defineNode("DeClip", { schema: z.object({}) });
const deClipOf = defineEdge("deClipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "node_delete_expect",
  nodes: { DeShow: { type: DeShow }, DeClip: { type: DeClip } },
  edges: {
    deClipOf: {
      type: deClipOf,
      from: [DeClip],
      to: [DeShow],
      cardinality: "one",
    },
  },
  ontology: [partOf(DeClip, DeShow, { via: deClipOf })],
});

type HookLog = Readonly<{
  ended: OperationHookContext[];
  failed: Readonly<{ operation: string; error: Error }>[];
}>;

async function showWithClip() {
  const backend = createTestBackend();
  await createStoreWithSchema(graph, backend);
  const log: HookLog = { ended: [], failed: [] };
  const store = createStore(graph, backend, {
    hooks: {
      onOperationEnd: (ctx) => log.ended.push(ctx),
      onError: (ctx, error) =>
        log.failed.push({ operation: ctx.operationId, error }),
    },
  });
  const show = await store.nodes.DeShow.create({});
  const clip = await store.nodes.DeClip.create({}, { partOf: { whole: show } });
  const plan = requireDefined(await store.nodes.DeShow.planDelete(show.id));
  log.ended.length = 0;
  return { store, log, show, clip, plan };
}

async function rejectionOf(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertTypedSurface(
  store: Store<typeof graph>,
  show: Awaited<ReturnType<Store<typeof graph>["nodes"]["DeShow"]["create"]>>,
  plan: NodeDeletePlan,
  maybePlan: NodeDeletePlan | undefined,
): void {
  void store.nodes.DeShow.delete(show.id);
  void store.nodes.DeShow.delete(show.id, { expect: plan });
  // @ts-expect-error planDelete's `undefined` answer is not an expectation
  void store.nodes.DeShow.delete(show.id, { expect: maybePlan });
  // @ts-expect-error options without a plan state nothing
  void store.nodes.DeShow.delete(show.id, {});
  // @ts-expect-error hardDelete takes no expect: the plan is the soft delete's
  void store.nodes.DeShow.hardDelete(show.id, { expect: plan });
}
void assertTypedSurface;

describe("delete(id, { expect }) options", () => {
  it("refuses options of the wrong shape with ValidationError naming the offending path, writing nothing", async () => {
    const { store, show, clip, plan } = await showWithClip();
    const [part] = plan.cascadedParts;
    const cases: readonly Readonly<{ options: unknown; path: string }>[] = [
      { options: "plan", path: "" },
      { options: {}, path: "expect" },
      { options: { expect: undefined }, path: "expect" },
      { options: { expect: plan, force: true }, path: "" },
      {
        options: { expect: { cascadedParts: [] } },
        path: "expect.removedEdgeIds",
      },
      {
        options: { expect: { ...plan, cascadedParts: [{ kind: "DeClip" }] } },
        path: "expect.cascadedParts.0.id",
      },
      {
        options: { expect: { ...plan, cascadedParts: [part, part] } },
        path: "expect.cascadedParts.1",
      },
      {
        options: {
          expect: { ...plan, removedEdgeIds: ["edge", "edge"] },
        },
        path: "expect.removedEdgeIds.1",
      },
    ];

    // MUTATION CHECK: return `undefined` from `readNodeDeleteOptions`
    // (src/store/operations/node-delete-expectation.ts) for any options and
    // every case deletes unguarded instead of refusing — verified and
    // reverted.
    for (const { options, path } of cases) {
      const refusal = await rejectionOf(() =>
        store.nodes.DeShow.delete(show.id, options as never),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      const error = refusal as ValidationError;
      expect(error.details).toMatchObject({
        entityType: "node",
        kind: "DeShow",
        id: show.id,
        operation: "delete",
      });
      expect({
        options,
        paths: error.details.issues.map((issue) => issue.path),
      }).toEqual({ options, paths: matchingArray([path]) });
    }
    expect(await store.nodes.DeShow.getById(show.id)).toBeDefined();
    expect(await store.nodes.DeClip.getById(clip.id)).toBeDefined();
  });

  it("reports a refused guarded delete through onError, never onOperationEnd", async () => {
    const { store, log, show, plan } = await showWithClip();
    await store.nodes.DeClip.create({}, { partOf: { whole: show } });
    log.ended.length = 0;

    const refusal = await rejectionOf(() =>
      store.nodes.DeShow.delete(show.id, { expect: plan }),
    );

    expect(refusal).toBeInstanceOf(NodeDeletePlanMismatchError);
    expect(log.ended).toEqual([]);
    expect(log.failed.map((entry) => entry.error)).toEqual([refusal]);
    const error = refusal as NodeDeletePlanMismatchError;
    expect(error.category).toBe("system");
    expect(error.message).toContain("1 part(s) added");
    expect(error.suggestion).toContain("planDelete(id)");
  });

  it("fires onOperationEnd once, with the cascaded parts, for a guarded delete that matches", async () => {
    const { store, log, show, clip, plan } = await showWithClip();

    await store.nodes.DeShow.delete(show.id, { expect: plan });

    expect(log.failed).toEqual([]);
    expect(
      log.ended.map(({ operation, kind, id, cascadedParts }) => ({
        operation,
        kind,
        id,
        cascadedParts,
      })),
    ).toEqual([
      {
        operation: "delete",
        kind: "DeShow",
        id: show.id,
        cascadedParts: [
          {
            kind: "DeClip",
            id: clip.id,
            whole: { kind: "DeShow", id: show.id },
            viaEdgeKind: "deClipOf",
          },
        ],
      },
    ]);
  });
});
