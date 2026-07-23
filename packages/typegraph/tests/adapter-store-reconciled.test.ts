/**
 * SQLite-specific wiring for the cacheable adapter store (§7): rebinding a
 * verified store onto a *second backend over the same physical database* — the
 * per-request-reconnection shape the harness's one-backend-per-test factory
 * can't express. The dialect-agnostic guarantees (zero round-trip construction,
 * runtime-committed-kind validation, the version probe) are proven on every
 * backend by the shared `backends/integration/reconciled-schema.ts` group.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createVerifiedAdapterStore,
  defineGraph,
  defineNode,
} from "../src";
import { createSqliteBackend } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { defineGraphExtension } from "../src/graph-extension";
import { requireDefined } from "../src/utils/presence";
import { spyGetActiveSchema } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "reconciled_store",
  nodes: { Person: { type: Person } },
  edges: {},
});

/** A kind committed at runtime, deliberately absent from `baseGraph`. */
const refundTicketExtension = defineGraphExtension({
  nodes: {
    RefundTicket: {
      properties: {
        reason: { type: "string" },
        amount: { type: "number" },
      },
    },
  },
});

describe("store.withBackend", () => {
  it("rebinds to a second connection over the same database with no re-verify", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const [seed] = await createAdapterStoreWithSchema(baseGraph, backend);
    const evolved = await seed.evolve(refundTicketExtension);
    const [verified] = await createVerifiedAdapterStore(baseGraph, backend);

    // A second backend over the same Drizzle database — the per-request handle.
    const requestBackend = createSqliteBackend(db);
    const spy = spyGetActiveSchema(requestBackend);
    const perRequest = verified.withBackend(spy.backend);
    expect(spy.calls()).toBe(0);
    expect(perRequest.reconciledSchema.version).toBe(
      verified.reconciledSchema.version,
    );

    // Write through the rebound store...
    const tickets = requireDefined(
      perRequest.getNodeCollection("RefundTicket"),
    );
    const created = await tickets.create({ reason: "late", amount: 7 });

    // ...and read it back through the original connection (same database).
    const viaOriginal = requireDefined(
      evolved.getNodeCollection("RefundTicket"),
    );
    const read = requireDefined(await viaOriginal.getById(created.id));
    expect(read).toMatchObject({ reason: "late", amount: 7 });
  });
});
