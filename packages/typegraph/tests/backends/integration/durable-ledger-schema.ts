/**
 * A durable branch's locator names the ledger its allocation was recorded in.
 *
 * A PostgreSQL working copy is allocated in `control`'s current schema and
 * recorded in the ledger in that schema. A durable branch is addressed later
 * by its descriptor alone, possibly by a manager built afresh, after the
 * caller's `search_path` has come to resolve another schema: a schema created
 * ahead of the allocation's in an unchanged path, or the allocation's schema
 * removed from the path. Every call by locator must still find the ledger the
 * allocation was recorded in.
 *
 * Every case runs on a caller's native transaction and rolls it back, so the
 * schemas and allocations it creates leave nothing behind.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import type {
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import {
  branchDurable,
  destroyDurableBranch,
  type DurableBranchDescriptor,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { BranchError } from "../../../src/graph-merge/errors";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { sql } from "../../../src/query/sql-fragment";
import {
  currentSchema,
  failureOf,
  inCallerTransaction,
  liveAllocations,
  managerOver,
  type OverCaller,
  requirePostgres,
  run,
  userRelations,
} from "./caller-transaction";
import type { IntegrationTestContext } from "./test-context";

const LedgerPerson = defineNode("LedgerPerson", {
  schema: z.object({ name: z.string() }),
});

let graphCounter = 0;

function buildGraph() {
  graphCounter += 1;
  return defineGraph({
    id: `durable_ledger_schema_${graphCounter}`,
    nodes: { LedgerPerson: { type: LedgerPerson } },
    edges: {},
  });
}

type LedgerGraph = ReturnType<typeof buildGraph>;

type Locator = Readonly<{ allocationId: string; ledgerSchema?: string }>;

function uniqueSchema(label: string): string {
  return `tg_ledger_${label}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

async function setPath(
  caller: TransactionBackend,
  path: string,
): Promise<void> {
  await run(caller, sql`SELECT set_config('search_path', ${path}, true)`);
}

/**
 * Creates, seals and closes one durable branch of a one-node source in the
 * caller's current schema. `before` is every relation that exists once the
 * source and the ledger do, so a destroy that removes everything it should
 * leaves exactly `before`.
 */
async function sealedDurableBranch(
  caller: TransactionBackend,
  overCaller: OverCaller,
): Promise<
  Readonly<{
    graph: LedgerGraph;
    control: GraphBackend;
    allocationSchema: string;
    descriptor: DurableBranchDescriptor<Locator>;
    before: readonly string[];
  }>
> {
  const graph = buildGraph();
  const control = overCaller({ vector: false });
  const [source] = await createStoreWithSchema(graph, control);
  await source.nodes.LedgerPerson.create({ name: "copied" });
  const manager = managerOver<LedgerGraph>(control, overCaller);
  await manager.listUnsealedAllocations();
  const before = await userRelations(caller);
  const allocationSchema = await currentSchema(caller);
  const created = unwrap(
    await branchDurable(source, manager.durable, {
      id: asBranchId(`ledger-${graphCounter}`),
      allocationId: `ledger-allocation-${globalThis.crypto.randomUUID()}`,
    }),
  );
  await created.branch.close();
  // The host stores the descriptor as JSON text and reads it back later;
  // only what survives that text reaches the later calls.
  const stored = JSON.stringify(created.descriptor);
  const descriptor = JSON.parse(stored) as DurableBranchDescriptor<Locator>;
  return { graph, control, allocationSchema, descriptor, before };
}

/**
 * Reopens `descriptor`, reads the copied names, and closes the branch; the
 * reopen error when it fails.
 */
async function reopenedNames(
  graph: LedgerGraph,
  descriptor: DurableBranchDescriptor<Locator>,
  manager: ReturnType<typeof managerOver<LedgerGraph>>,
): Promise<unknown> {
  const reopened = await reopenDurableBranch(
    graph,
    descriptor,
    manager.durable,
  );
  if (!isOk(reopened)) return reopened.error;
  const people = await reopened.data.store.nodes.LedgerPerson.find();
  await reopened.data.close();
  return people.map((person) => person.name);
}

export function registerDurableLedgerSchemaIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("A durable branch's ledger schema", () => {
    it("is used by reopen and destroy after the caller creates the schema leading its unchanged path", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const future = uniqueSchema("future");
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const base = await currentSchema(caller);
          await setPath(caller, `${future}, ${base}`);
          const durable = await sealedDurableBranch(caller, overCaller);
          await run(caller, sql.raw(`CREATE SCHEMA "${future}"`));
          const manager = managerOver<LedgerGraph>(durable.control, overCaller);
          const reopened = await reopenedNames(
            durable.graph,
            durable.descriptor,
            manager,
          );
          const destroyed = await destroyDurableBranch(
            durable.descriptor,
            manager.durable,
          );
          return {
            allocatedIn: durable.allocationSchema,
            base,
            ledgerSchema: durable.descriptor.store.ledgerSchema,
            reopened,
            destroyed: isOk(destroyed) ? undefined : destroyed.error,
            liveAfterDestroy: await liveAllocations(
              caller,
              base,
              durable.descriptor.store.allocationId,
            ),
            before: durable.before,
            after: await userRelations(caller),
          };
        },
      );

      expect(observed.allocatedIn).toBe(observed.base);
      expect(observed.ledgerSchema).toBe(observed.base);
      expect(observed.reopened).toEqual(["copied"]);
      expect(observed.destroyed).toBeUndefined();
      expect(observed.liveAfterDestroy).toBe(0);
      expect(observed.after).toEqual(observed.before);
    });

    it("is used by destroy after the caller drops the allocation's schema from its path", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const dropped = uniqueSchema("dropped");
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const remaining = await currentSchema(caller);
          await run(caller, sql.raw(`CREATE SCHEMA "${dropped}"`));
          await setPath(caller, `${dropped}, ${remaining}`);
          const durable = await sealedDurableBranch(caller, overCaller);
          // The allocation's schema leaves the path; the schema after it,
          // which may hold a ledger of its own, becomes current. Reopen is not
          // exercised here: its connection runs on this same session, and a
          // connection must still resolve the allocation's tables.
          await setPath(caller, remaining);
          const manager = managerOver<LedgerGraph>(durable.control, overCaller);
          const destroyed = await destroyDurableBranch(
            durable.descriptor,
            manager.durable,
          );
          return {
            allocatedIn: durable.allocationSchema,
            ledgerSchema: durable.descriptor.store.ledgerSchema,
            destroyed: isOk(destroyed) ? undefined : destroyed.error,
            liveAfterDestroy: await liveAllocations(
              caller,
              dropped,
              durable.descriptor.store.allocationId,
            ),
            before: durable.before,
            after: await userRelations(caller),
          };
        },
      );

      expect(observed.allocatedIn).toBe(dropped);
      expect(observed.ledgerSchema).toBe(dropped);
      expect(observed.destroyed).toBeUndefined();
      expect(observed.liveAfterDestroy).toBe(0);
      expect(observed.after).toEqual(observed.before);
    });

    it("is used by a manager built afresh from the stored descriptor alone, past another ledger on the path", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const ahead = uniqueSchema("ahead");
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const base = await currentSchema(caller);
          await setPath(caller, `${ahead}, ${base}`);
          const durable = await sealedDurableBranch(caller, overCaller);
          // The schema leading the path comes to hold a working-copy ledger of
          // its own, so a bare ledger name now resolves there.
          await run(caller, sql.raw(`CREATE SCHEMA "${ahead}"`));
          await managerOver(
            durable.control,
            overCaller,
          ).listUnsealedAllocations({ ledgerSchema: ahead });
          // A new control backend and manager: nothing of the creating
          // manager survives but the descriptor.
          const restarted = managerOver<LedgerGraph>(
            overCaller({ vector: false }),
            overCaller,
          );
          const reopened = await reopenedNames(
            durable.graph,
            durable.descriptor,
            restarted,
          );
          const destroyed = await destroyDurableBranch(
            durable.descriptor,
            restarted.durable,
          );
          const liveAfterDestroy = await liveAllocations(
            caller,
            base,
            durable.descriptor.store.allocationId,
          );
          await run(caller, sql.raw(`DROP SCHEMA "${ahead}" CASCADE`));
          return {
            reopened,
            destroyed: isOk(destroyed) ? undefined : destroyed.error,
            liveAfterDestroy,
            before: durable.before,
            after: await userRelations(caller),
          };
        },
      );

      expect(observed.reopened).toEqual(["copied"]);
      expect(observed.destroyed).toBeUndefined();
      expect(observed.liveAfterDestroy).toBe(0);
      expect(observed.after).toEqual(observed.before);
    });

    it("resolves a version 1 descriptor, which records no schema, through control's search_path", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const future = uniqueSchema("legacy");
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const base = await currentSchema(caller);
          await setPath(caller, `${future}, ${base}`);
          const durable = await sealedDurableBranch(caller, overCaller);
          const { allocationId } = durable.descriptor.store;
          // The shape the released format wrote: version 1, id only.
          const legacy: DurableBranchDescriptor<Locator> = {
            ...durable.descriptor,
            version: 1,
            store: { allocationId },
          };
          const manager = managerOver<LedgerGraph>(durable.control, overCaller);
          // An empty schema now leads the path. The bare ledger name still
          // resolves to the allocation's ledger, as the released version's
          // unqualified statements resolve it, so the legacy descriptor still
          // reopens; no empty ledger is created ahead of it.
          await run(caller, sql.raw(`CREATE SCHEMA "${future}"`));
          const reopened = await reopenedNames(durable.graph, legacy, manager);
          const futureLedger = await run(
            caller,
            sql`SELECT to_regclass(${`"${future}".typegraph_working_copy_allocations`})::text AS ledger`,
          );
          // Once the path no longer reaches the allocation's schema, the
          // legacy descriptor has no way to find its ledger: destroy reports
          // the allocation missing and keeps it.
          await setPath(caller, future);
          const unreachable = await destroyDurableBranch(
            legacy,
            manager.durable,
          );
          const liveWhileUnreachable = await liveAllocations(
            caller,
            base,
            allocationId,
          );
          await run(caller, sql.raw(`DROP SCHEMA "${future}" CASCADE`));
          await setPath(caller, base);
          const destroyed = await destroyDurableBranch(legacy, manager.durable);
          return {
            reopened,
            futureLedger: futureLedger[0]?.["ledger"],
            unreachable: isOk(unreachable) ? undefined : unreachable.error,
            liveWhileUnreachable,
            destroyed: isOk(destroyed) ? undefined : destroyed.error,
            liveAfterDestroy: await liveAllocations(caller, base, allocationId),
            before: durable.before,
            after: await userRelations(caller),
          };
        },
      );

      expect(observed.reopened).toEqual(["copied"]);
      expect(observed.futureLedger).toBeNull();
      expect(observed.unreachable).toBeInstanceOf(BranchError);
      expect(String(observed.unreachable)).toContain("does not exist");
      expect(observed.liveWhileUnreachable).toBe(1);
      expect(observed.destroyed).toBeUndefined();
      expect(observed.liveAfterDestroy).toBe(0);
      expect(observed.after).toEqual(observed.before);
    });

    it("refuses a locator whose ledger schema does not fit its version, keeping the allocation", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const durable = await sealedDurableBranch(caller, overCaller);
          const manager = managerOver<LedgerGraph>(durable.control, overCaller);
          const { allocationId, ledgerSchema } = durable.descriptor.store;
          const withoutSchema = await destroyDurableBranch(
            { ...durable.descriptor, store: { allocationId } },
            manager.durable,
          );
          const legacyWithSchema = await destroyDurableBranch(
            {
              ...durable.descriptor,
              version: 1,
              store: { allocationId, ledgerSchema: ledgerSchema ?? "" },
            },
            manager.durable,
          );
          const emptySchema = await destroyDurableBranch(
            {
              ...durable.descriptor,
              store: { allocationId, ledgerSchema: "" },
            },
            manager.durable,
          );
          return {
            withoutSchema:
              isOk(withoutSchema) ? undefined : withoutSchema.error,
            legacyWithSchema:
              isOk(legacyWithSchema) ? undefined : legacyWithSchema.error,
            emptySchema: isOk(emptySchema) ? undefined : emptySchema.error,
            live: await liveAllocations(
              caller,
              durable.allocationSchema,
              allocationId,
            ),
          };
        },
      );

      for (const refusal of [
        observed.withoutSchema,
        observed.legacyWithSchema,
        observed.emptySchema,
      ]) {
        expect(refusal).toBeInstanceOf(BranchError);
        expect(String(refusal)).toContain("ledger schema");
      }
      expect(observed.live).toBe(1);
    });

    it("lists and recovers an unsealed allocation in the ledger it names", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const future = uniqueSchema("recover");
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const base = await currentSchema(caller);
          await setPath(caller, `${future}, ${base}`);
          const control = overCaller({ vector: false });
          const manager = managerOver(control, overCaller);
          await manager.listUnsealedAllocations();
          const before = await userRelations(caller);
          // An owner that crashed leaves its allocation unsealed and live.
          await manager.makeBackend();
          // The allocation's schema leaves the path, so the default listing
          // reads another ledger.
          await run(caller, sql.raw(`CREATE SCHEMA "${future}"`));
          await setPath(caller, future);
          const restarted = managerOver(
            overCaller({ vector: false }),
            overCaller,
          );
          const inCurrentSchema = await restarted.listUnsealedAllocations();
          const listed = await restarted.listUnsealedAllocations({
            ledgerSchema: base,
          });
          const aborted = await failureOf(
            Promise.all(
              listed.map((allocation) =>
                restarted.abortAllocation(allocation.allocationId, {
                  ledgerSchema: allocation.ledgerSchema,
                }),
              ),
            ),
          );
          await run(caller, sql.raw(`DROP SCHEMA "${future}" CASCADE`));
          return {
            base,
            inCurrentSchema: inCurrentSchema.length,
            listedSchemas: listed.map((allocation) => allocation.ledgerSchema),
            aborted,
            live: await liveAllocations(caller, base),
            before,
            after: await userRelations(caller),
          };
        },
      );

      expect(observed.inCurrentSchema).toBe(0);
      expect(observed.listedSchemas).toEqual([observed.base]);
      expect(observed.aborted).toBeUndefined();
      expect(observed.live).toBe(0);
      expect(observed.after).toEqual(observed.before);
    });

    // The ledger is addressed by its schema, so reading it proves nothing
    // about where the connection resolves the allocation's tables, which its
    // backend names without a schema. Attestation checks that separately.
    it("refuses a connection whose search_path does not reach the allocation's schema, leaving nothing", async (ctx) => {
      const root = requirePostgres(context, ctx);
      const elsewhere = uniqueSchema("elsewhere");
      const observed = await inCallerTransaction(
        root,
        async (caller, overCaller) => {
          const base = await currentSchema(caller);
          await run(caller, sql.raw(`CREATE SCHEMA "${elsewhere}"`));
          const manager = createPostgresWorkingCopyManager({
            control: overCaller({ vector: false }),
            connect: async (names) => {
              await setPath(caller, elsewhere);
              return overCaller({
                vector: false,
                tables: createPostgresTables(names),
              });
            },
          });
          await manager.listUnsealedAllocations();
          const before = await userRelations(caller);
          const liveBefore = await liveAllocations(caller, base);
          const failure = await failureOf(manager.makeBackend());
          await setPath(caller, base);
          return {
            base,
            failure,
            liveBefore,
            liveAfter: await liveAllocations(caller, base),
            before,
            after: await userRelations(caller),
          };
        },
      );

      expect(observed.failure).toBeInstanceOf(BranchError);
      expect(String(observed.failure)).toContain(
        `does not resolve the allocation's tables in its schema "${observed.base}"`,
      );
      expect(observed.liveAfter).toBe(observed.liveBefore);
      expect(observed.after).toEqual(observed.before);
    });
  });
}
