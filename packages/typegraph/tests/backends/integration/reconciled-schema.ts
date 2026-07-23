import { describe, expect, it } from "vitest";

import {
  createAdapterStore,
  createVerifiedAdapterStore,
  getCommittedSchemaVersion,
} from "../../../src";
import { defineGraphExtension } from "../../../src/graph-extension";
import { requireDefined } from "../../../src/utils/presence";
import { spyGetActiveSchema } from "../../test-utils";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

/**
 * Cross-backend parity for the cacheable adapter-store path: a store built
 * from a cached {@link createVerifiedAdapterStore} snapshot must read and,
 * crucially, *validate writes against runtime-committed kinds* identically on
 * every backend — with no verify round-trip — and {@link getCommittedSchemaVersion}
 * must report the same committed version the snapshot recorded. These are the
 * guarantees the §7 serverless per-request cache leans on, so they belong in
 * the shared suite rather than a per-dialect test.
 */
export function registerReconciledSchemaIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Reconciled schema (cacheable adapter store)", () => {
    it("reconciledSchema exposes the committed version and merged graph", async () => {
      const backend = context.getBackend();
      const [store, result] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );

      // A store committed by the suite's beforeEach is always caught up, so
      // the verified open reports "unchanged" and carries the live version.
      const committedVersion =
        result.status === "unchanged" ? result.version : undefined;
      expect(store.reconciledSchema.graph.id).toBe(integrationTestGraph.id);
      expect(typeof store.reconciledSchema.version).toBe("number");
      expect(result.status).toBe("unchanged");
      expect(store.reconciledSchema.version).toBe(committedVersion);
    });

    it("getCommittedSchemaVersion matches the reconciled snapshot", async () => {
      const backend = context.getBackend();
      const [store] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );

      const probed = await getCommittedSchemaVersion(
        backend,
        integrationTestGraph.id,
      );
      expect(probed).toBe(store.reconciledSchema.version);
    });

    it("constructs from a snapshot with zero database round-trips", async () => {
      const backend = context.getBackend();
      const [verified] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );

      // The whole point of the feature: no schema-reconcile read at construction
      // or on the write path. Proven on every backend, not just SQLite.
      const spy = spyGetActiveSchema(backend);
      const perRequest = createAdapterStore(integrationTestGraph, spy.backend, {
        reconciled: verified.reconciledSchema,
      });
      expect(spy.calls()).toBe(0);
      await perRequest.nodes.Person.create({ name: "Zero Roundtrip" });
      expect(spy.calls()).toBe(0);
    });

    it("getCommittedSchemaVersion is a single indexed read that moves on commit", async () => {
      const backend = context.getBackend();

      const spy = spyGetActiveSchema(backend);
      const before = requireDefined(
        await getCommittedSchemaVersion(spy.backend, integrationTestGraph.id),
      );
      expect(spy.calls()).toBe(1);

      await context.getStore().evolve(
        defineGraphExtension({
          nodes: {
            VersionProbe: { properties: { label: { type: "string" } } },
          },
        }),
      );

      const after = requireDefined(
        await getCommittedSchemaVersion(backend, integrationTestGraph.id),
      );
      expect(after).toBeGreaterThan(before);
    });

    it("getCommittedSchemaVersion returns undefined for an uncommitted graph", async () => {
      const backend = context.getBackend();
      expect(
        await getCommittedSchemaVersion(backend, "never_committed_graph"),
      ).toBeUndefined();
    });

    it("createAdapterStore({ reconciled }) reads and writes an existing kind", async () => {
      const backend = context.getBackend();
      const [verified] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );

      const perRequest = createAdapterStore(integrationTestGraph, backend, {
        reconciled: verified.reconciledSchema,
      });
      const created = await perRequest.nodes.Person.create({
        name: "Reconciled Reader",
      });
      const read = requireDefined(
        await perRequest.nodes.Person.getById(created.id),
      );
      expect(read.name).toBe("Reconciled Reader");
    });

    it("validates a runtime-committed kind through a store built from the compile-time graph", async () => {
      const backend = context.getBackend();
      // Commit a kind absent from the compile-time `integrationTestGraph`.
      await context.getStore().evolve(
        defineGraphExtension({
          nodes: {
            ReconcileProbe: {
              properties: { label: { type: "string" } },
            },
          },
        }),
      );

      // Verify once (folds in the runtime kind), then build a per-request store
      // from the *compile-time* graph plus the cached snapshot — no re-query.
      const [verified] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );
      const perRequest = createAdapterStore(integrationTestGraph, backend, {
        reconciled: verified.reconciledSchema,
      });

      const probes = requireDefined(
        perRequest.getNodeCollection("ReconcileProbe"),
      );
      const created = await probes.create({ label: "hello" });
      const read = requireDefined(await probes.getById(created.id));
      expect(read).toMatchObject({ label: "hello" });

      // A store WITHOUT the snapshot cannot see the runtime kind — the snapshot
      // is exactly what carries the runtime-committed shape.
      const withoutSnapshot = createAdapterStore(integrationTestGraph, backend);
      expect(
        withoutSnapshot.getNodeCollection("ReconcileProbe"),
      ).toBeUndefined();
    });

    it("withBackend rebuilds an equivalent store with no re-verify", async () => {
      const backend = context.getBackend();
      const [verified] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );

      const rebound = verified.withBackend(backend);
      expect(rebound.reconciledSchema.version).toBe(
        verified.reconciledSchema.version,
      );
      const created = await rebound.nodes.Person.create({ name: "Rebound" });
      const read = requireDefined(
        await rebound.nodes.Person.getById(created.id),
      );
      expect(read.name).toBe("Rebound");
    });

    it("evolve through a reconciled store commits the kind and bumps the committed version", async () => {
      const backend = context.getBackend();
      const [verified] = await createVerifiedAdapterStore(
        integrationTestGraph,
        backend,
      );
      const before = requireDefined(
        await getCommittedSchemaVersion(backend, integrationTestGraph.id),
      );

      // The write path a brain actually hits: evolve a new kind through a
      // per-request store built from the cached snapshot, not a verified one.
      const perRequest = createAdapterStore(integrationTestGraph, backend, {
        reconciled: verified.reconciledSchema,
      });
      const evolved = await perRequest.evolve(
        defineGraphExtension({
          nodes: {
            EvolveProbe: { properties: { label: { type: "string" } } },
          },
        }),
      );

      // The new kind is committed and writable through the evolved handle...
      const probes = requireDefined(evolved.getNodeCollection("EvolveProbe"));
      const created = await probes.create({ label: "via-reconciled" });
      expect(requireDefined(await probes.getById(created.id))).toMatchObject({
        label: "via-reconciled",
      });

      // ...and the committed version moved, so another isolate's probe catches it.
      const after = requireDefined(
        await getCommittedSchemaVersion(backend, integrationTestGraph.id),
      );
      expect(after).toBeGreaterThan(before);
    });
  });
}
