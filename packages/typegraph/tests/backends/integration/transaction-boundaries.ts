/**
 * Transaction boundary × recording matrix, run on every backend lane.
 *
 * Who opened a transaction decides three things today: whether hooks wait
 * for COMMIT, how the schema fence is leased across writes, and when the
 * revision clock advances. Each cell runs three managed writes through one
 * boundary on a store with one recording mode and pins what it observes:
 * the receipt's write count, whether a recorded instant was stamped, when
 * `onOperationEnd` fired relative to the backend transaction, and the exact
 * schema-fence acquisitions at the port before, during and after the body.
 *
 * Boundaries:
 * - `owned`: `transactionWithReceipt` on a portable store.
 * - `owned-native`: `transactionWithReceipt` on an adapter store, whose
 *   transaction exposes the native handle.
 * - `adopted`: `withRecordedTransaction` over a caller-owned transaction.
 * - `adopted-evolving`: `withEvolvedTransaction` over a caller-owned
 *   transaction, applying a one-kind extension. Adoption takes the exclusive
 *   schema-write fence before the callback; a backend without schema-write
 *   adoption refuses the boundary.
 *
 * The extra cells pin the decisions that today read "TypeGraph registered a
 * write session for this transaction": the revision cadence and the merge
 * pristine check. The third, the SQLite writer-slot proof before a
 * constrained write in a DEFERRED adopted transaction, needs a second
 * connection committing behind the open transaction. No lane's backend has
 * one, so that cell lives with its two-connection file fixture in
 * `tests/constraint-adopted-transaction.test.ts`.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type StoreOptions,
  type TransactionContext,
} from "../../../src";
import type { AdapterBackend } from "../../../src/backend/types";
import { recordedInstantRevision } from "../../../src/core";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { defineGraphExtension } from "../../../src/graph-extension";
import { applyMergePlanInTransaction } from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import { StaleMergePlanError } from "../../../src/graph-merge/errors";
import { planMerge } from "../../../src/graph-merge/merge";
import { unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import type { SqlDialect } from "../../../src/query/dialect";
import { createSqlSchema, recordedRelation } from "../../../src/query-entry";
import {
  type EvolutionPlan,
  type SchemaManagerOptions,
} from "../../../src/schema";
import type { TransactionReceipt } from "../../../src/store-entry";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";
import {
  createEngineNativeBackend,
  type PortCall,
  recordTransactionPortCalls,
  runsEngineNativeScenarios,
} from "./transaction-statement-budget";

const BoundaryItem = defineNode("BoundaryItem", {
  schema: z.object({ label: z.string() }),
});

function boundaryGraph(id: string) {
  return defineGraph({
    id,
    nodes: { BoundaryItem: { type: BoundaryItem } },
    edges: {},
  });
}

const evolvingExtension = defineGraphExtension({
  nodes: {
    BoundaryTag: { properties: { label: { type: "string", optional: true } } },
  },
});

const BOUNDARIES = [
  "owned",
  "owned-native",
  "adopted",
  "adopted-evolving",
] as const;
type Boundary = (typeof BOUNDARIES)[number];

const RECORDINGS = [
  "live",
  "live+revisions",
  "live+read+revisions",
  "capture",
  "engine-native",
] as const;
type Recording = (typeof RECORDINGS)[number];

/**
 * When `onOperationEnd` fired. `immediate`: inside the callback, while the
 * caller's transaction is still open. `buffer-until-commit`: after the
 * callback, once the backend transaction has settled (committed).
 */
type HookTiming = "immediate" | "buffer-until-commit";

/** Schema-fence acquisitions at the port, split around the callback body. */
type FenceCounts = Readonly<{ before: number; during: number; after: number }>;
type DialectFences = Readonly<Record<SqlDialect, FenceCounts>>;

type CellObservation = Readonly<{
  writes: number;
  recorded: boolean;
  hooks: HookTiming;
  fences: FenceCounts;
}>;

/** An expected cell, whose fence counts may differ by dialect. */
type ExpectedObservation = Omit<CellObservation, "fences"> &
  Readonly<{ fences: FenceCounts | DialectFences }>;

const WRITES_PER_CELL = 3;

/** One fence on the body's first write, leased to the rest. */
const LEASE_ON_FIRST_WRITE: FenceCounts = { before: 0, during: 1, after: 0 };
/** A fence on every write in the body. */
const PER_WRITE: FenceCounts = {
  before: 0,
  during: WRITES_PER_CELL,
  after: 0,
};
/** One fence before the callback, leased to every write in it. */
const PRE_ACQUIRED: FenceCounts = { before: 1, during: 0, after: 0 };
/**
 * An owned frame (portable or adapter store) when a write needs the graph
 * write lock. PostgreSQL: the first
 * write takes the fused schema-and-graph lock, which does not seed the lease,
 * so the second write takes the schema fence again and leases it to the
 * third. SQLite's engine-serialized fence has no fused lock to take.
 */
const OWNED_UNDER_GRAPH_WRITE_LOCK: DialectFences = {
  sqlite: LEASE_ON_FIRST_WRITE,
  postgres: { before: 0, during: 2, after: 0 },
};
/** The evolving boundary's adoption fence, then a fence on every write. */
const ADOPTED_THEN_PER_WRITE: FenceCounts = {
  before: 1,
  during: WRITES_PER_CELL,
  after: 0,
};
/** The evolving boundary's adoption fence, then capture's pre-acquired one. */
const ADOPTED_THEN_PRE_ACQUIRED: FenceCounts = {
  before: 2,
  during: 0,
  after: 0,
};

type BoundaryGraph = ReturnType<typeof boundaryGraph>;
type BoundaryTransaction = TransactionContext<BoundaryGraph>;
type CellOutcome = Readonly<{ receipt: TransactionReceipt }>;
type CellBody = (tx: BoundaryTransaction) => Promise<void>;

/** What the `owned` boundary drives on a portable store. */
type OwnedBoundaryStore = Readonly<{
  transactionWithReceipt: (fn: CellBody) => Promise<CellOutcome>;
}>;

/** What the adapter boundaries drive on an adapter store. */
type AdapterBoundaryStore = OwnedBoundaryStore &
  Readonly<{
    withRecordedTransaction: (
      native: unknown,
      fn: CellBody,
    ) => Promise<CellOutcome>;
    withEvolvedTransaction: (
      native: unknown,
      plan: EvolutionPlan,
      fn: CellBody,
    ) => Promise<CellOutcome>;
    planEvolution: (
      extension: typeof evolvingExtension,
    ) => Promise<EvolutionPlan>;
  }>;

/** One schema-fence acquisition at the port, fused or standalone. */
function isSchemaFence(call: PortCall): boolean {
  return (
    call.member === "lockSchemaVersionForWrite" ||
    call.member === "lockSchemaVersionAndGraphWrite" ||
    call.member === "insertNodeWithSchemaFence" ||
    call.member === "adoptSchemaWriteTransaction"
  );
}

function countFences(calls: readonly PortCall[]): number {
  return calls.filter((call) => isSchemaFence(call)).length;
}

function fenceCounts(
  calls: readonly PortCall[],
  bodyStart: number,
  bodyEnd: number,
): FenceCounts {
  return {
    before: countFences(calls.slice(0, bodyStart)),
    during: countFences(calls.slice(bodyStart, bodyEnd)),
    after: countFences(calls.slice(bodyEnd)),
  };
}

/** Where one `onOperationEnd` call landed. */
type HookSample = Readonly<{ inCallback: boolean; transactionOpen: boolean }>;

function hookTiming(samples: readonly HookSample[]): HookTiming {
  if (samples.length === WRITES_PER_CELL) {
    if (samples.every((sample) => sample.inCallback && sample.transactionOpen))
      return "immediate";
    if (
      samples.every((sample) => !sample.inCallback && !sample.transactionOpen)
    )
      return "buffer-until-commit";
  }
  throw new Error(
    `onOperationEnd fired in no single hook policy: ${JSON.stringify(samples)}`,
  );
}

/** A cell whose three writes all committed through the boundary. */
function applied(
  recorded: boolean,
  hooks: HookTiming,
  fences: FenceCounts | DialectFences,
): ExpectedObservation {
  return { writes: WRITES_PER_CELL, recorded, hooks, fences };
}

/**
 * Today's behavior, cell by cell. `engine-native` cells run only where
 * {@link runsEngineNativeScenarios} says, on their own engine-native backend.
 */
const EXPECTED: Readonly<
  Record<Boundary, Readonly<Record<Recording, ExpectedObservation>>>
> = {
  owned: {
    live: applied(false, "buffer-until-commit", LEASE_ON_FIRST_WRITE),
    "live+revisions": applied(
      false,
      "buffer-until-commit",
      OWNED_UNDER_GRAPH_WRITE_LOCK,
    ),
    "live+read+revisions": applied(
      false,
      "buffer-until-commit",
      OWNED_UNDER_GRAPH_WRITE_LOCK,
    ),
    capture: applied(true, "buffer-until-commit", OWNED_UNDER_GRAPH_WRITE_LOCK),
    "engine-native": applied(true, "buffer-until-commit", LEASE_ON_FIRST_WRITE),
  },
  "owned-native": {
    live: applied(false, "buffer-until-commit", PER_WRITE),
    "live+revisions": applied(
      false,
      "buffer-until-commit",
      OWNED_UNDER_GRAPH_WRITE_LOCK,
    ),
    "live+read+revisions": applied(
      false,
      "buffer-until-commit",
      OWNED_UNDER_GRAPH_WRITE_LOCK,
    ),
    capture: applied(true, "buffer-until-commit", OWNED_UNDER_GRAPH_WRITE_LOCK),
    "engine-native": applied(true, "buffer-until-commit", PER_WRITE),
  },
  adopted: {
    live: applied(false, "immediate", PER_WRITE),
    "live+revisions": applied(false, "immediate", PER_WRITE),
    "live+read+revisions": applied(false, "immediate", PER_WRITE),
    capture: applied(true, "immediate", PRE_ACQUIRED),
    "engine-native": applied(true, "immediate", PER_WRITE),
  },
  "adopted-evolving": {
    live: applied(false, "immediate", ADOPTED_THEN_PER_WRITE),
    "live+revisions": applied(false, "immediate", ADOPTED_THEN_PER_WRITE),
    "live+read+revisions": applied(false, "immediate", ADOPTED_THEN_PER_WRITE),
    capture: applied(true, "immediate", ADOPTED_THEN_PRE_ACQUIRED),
    "engine-native": applied(true, "immediate", ADOPTED_THEN_PER_WRITE),
  },
};

function storeOptions(
  recording: Recording,
  backend: AdapterBackend<unknown>,
): StoreOptions {
  switch (recording) {
    case "live": {
      return {};
    }
    case "live+revisions": {
      return { revisionTracking: true };
    }
    case "live+read+revisions": {
      return {
        revisionTracking: true,
        recordedRead: recordedRelation({
          schema: createSqlSchema(backend.tableNames),
        }),
      };
    }
    case "capture":
    case "engine-native": {
      return { history: true };
    }
  }
}

/** A backend without schema-write adoption refuses the evolving boundary. */
type CellResult = CellObservation | Readonly<{ refusedCapability: string }>;

async function settleCell(
  observation: Promise<CellObservation>,
): Promise<CellResult> {
  try {
    return await observation;
  } catch (error) {
    if (!(error instanceof UnsupportedBackendCapabilityError)) throw error;
    return { refusedCapability: String(error.details["capability"]) };
  }
}

function expectedCell(
  boundary: Boundary,
  recording: Recording,
  backend: AdapterBackend<unknown>,
): CellResult {
  if (
    boundary === "adopted-evolving" &&
    backend.adoptSchemaWriteTransaction === undefined
  ) {
    return { refusedCapability: "adoptSchemaWriteTransaction" };
  }
  const expected = EXPECTED[boundary][recording];
  return {
    ...expected,
    fences:
      "during" in expected.fences ?
        expected.fences
      : expected.fences[backend.dialect],
  };
}

async function writeThreeCreates(tx: BoundaryTransaction): Promise<void> {
  for (const label of ["a", "b", "c"]) {
    await tx.nodes.BoundaryItem.create({ label });
  }
}

/**
 * Builds the boundary's store and returns the run that drives one body
 * through it. The evolving boundary plans its extension here, so its calls
 * fall outside the counted run, and refuses a plan that would not change the
 * schema.
 */
async function prepareBoundary(
  boundary: Boundary,
  graph: BoundaryGraph,
  backend: AdapterBackend<unknown>,
  options: StoreOptions & SchemaManagerOptions,
): Promise<(body: CellBody) => Promise<CellOutcome>> {
  if (boundary === "owned") {
    const [store]: readonly [OwnedBoundaryStore, ...unknown[]] =
      await createStoreWithSchema(graph, backend, options);
    return (body) => store.transactionWithReceipt(body);
  }
  const [store]: readonly [AdapterBoundaryStore, ...unknown[]] =
    await createAdapterStoreWithSchema(graph, backend, options);
  switch (boundary) {
    case "owned-native": {
      return (body) => store.transactionWithReceipt(body);
    }
    case "adopted": {
      return (body) =>
        backend.transactionWithNative((_tx, native) =>
          store.withRecordedTransaction(native, body),
        );
    }
    case "adopted-evolving": {
      const plan = await store.planEvolution(evolvingExtension);
      expect(plan.status).toBe("change");
      return (body) =>
        backend.transactionWithNative((_tx, native) =>
          store.withEvolvedTransaction(native, plan, body),
        );
    }
  }
}

async function observeCell(
  boundary: Boundary,
  recording: Recording,
  backend: AdapterBackend<unknown>,
): Promise<CellObservation> {
  const graph = boundaryGraph(
    `boundary_${boundary}_${recording}`.replaceAll(/[^a-z_]/g, "_"),
  );
  const recorder = recordTransactionPortCalls(backend);
  try {
    const hookSamples: HookSample[] = [];
    let inCallback = false;
    const run = await prepareBoundary(boundary, graph, backend, {
      ...storeOptions(recording, backend),
      hooks: {
        onOperationEnd: () => {
          hookSamples.push({
            inCallback,
            transactionOpen: recorder.backendTransactionOpen(),
          });
        },
      },
    });
    const runStart = recorder.calls.length;
    let bodyStart = runStart;
    let bodyEnd = runStart;
    const body: CellBody = async (tx) => {
      bodyStart = recorder.calls.length;
      inCallback = true;
      try {
        const item = await tx.nodes.BoundaryItem.create({
          label: "created",
        });
        await tx.nodes.BoundaryItem.update(item.id, { label: "updated" });
        await tx.nodes.BoundaryItem.delete(item.id);
      } finally {
        inCallback = false;
        bodyEnd = recorder.calls.length;
      }
    };

    const outcome = await run(body);

    return {
      writes: outcome.receipt.writes.total,
      recorded: outcome.receipt.recorded !== undefined,
      hooks: hookTiming(hookSamples),
      fences: fenceCounts(
        recorder.calls.slice(runStart),
        bodyStart - runStart,
        bodyEnd - runStart,
      ),
    };
  } finally {
    recorder.restore();
  }
}

export function registerTransactionBoundaryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Transaction boundaries × recording", () => {
    const engines: PGlite[] = [];

    afterEach(async () => {
      for (const engine of engines.splice(0)) await engine.close();
    });

    async function cellBackend(
      recording: Recording,
    ): Promise<AdapterBackend<unknown>> {
      if (recording !== "engine-native") return context.getBackend();
      const engine = await PGlite.create();
      engines.push(engine);
      return createEngineNativeBackend(engine);
    }

    for (const boundary of BOUNDARIES) {
      for (const recording of RECORDINGS) {
        it(`${boundary} × ${recording}`, async (ctx) => {
          if (
            recording === "engine-native" &&
            !runsEngineNativeScenarios(context)
          ) {
            ctx.skip();
          }

          const backend = await cellBackend(recording);

          const observed = await settleCell(
            observeCell(boundary, recording, backend),
          );

          expect(observed).toEqual(expectedCell(boundary, recording, backend));
        });
      }
    }

    describe("decisions that read commit ownership", () => {
      it("advances the revision clock once for an owned transaction and once per write for an adopted one", async () => {
        const backend = context.getBackend();
        const [store] = await createAdapterStoreWithSchema(
          boundaryGraph("boundary_revision_cadence"),
          backend,
          { revisionTracking: true },
        );
        const revision = async (): Promise<number> =>
          recordedInstantRevision(requireDefined(await store.revisionNow()));

        await store.nodes.BoundaryItem.create({ label: "first revision" });
        const beforeOwned = await revision();
        await store.transaction((tx) => writeThreeCreates(tx));
        const afterOwned = await revision();
        await backend.transactionWithNative((_tx, native) =>
          store.withRecordedTransaction(native, (tx) => writeThreeCreates(tx)),
        );
        const afterAdopted = await revision();

        expect(afterOwned - beforeOwned).toBe(1);
        expect(afterAdopted - afterOwned).toBe(WRITES_PER_CELL);
      });

      it("does not refuse an adopted merge as non-pristine after a prior write; the revision fence decides", async () => {
        // The adopted write already advanced the revision clock, so the plan
        // is stale by the time its fence reads it. A refusal naming the
        // pristine check instead would mean the adopted frame had been given
        // the owned frame's deferred revision.
        const backend = context.getBackend();
        const [target] = await createAdapterStoreWithSchema(
          boundaryGraph("boundary_adopted_merge"),
          backend,
          { revisionTracking: true },
        );
        const source = unwrap(
          await branch(target, () => context.createIsolatedBackend(), {
            id: asBranchId("boundary-adopted-merge"),
          }),
        );
        await source.store.nodes.BoundaryItem.create({ label: "merged" });
        const artifact = unwrap(await planMerge(target, [source]));

        await backend.transactionWithNative((_tx, native) =>
          target.withRecordedTransaction(native, async (tx) => {
            await tx.nodes.BoundaryItem.create({ label: "prior" });

            await expect(
              applyMergePlanInTransaction(target, tx, artifact),
            ).rejects.toBeInstanceOf(StaleMergePlanError);
          }),
        );
      });
    });
  });
}
