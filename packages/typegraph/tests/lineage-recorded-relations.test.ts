/**
 * Root-level SQLite + PGlite coverage for the `lineage` capability derived
 * from TypeGraph's own recorded relations (`recordedRelationsLineage` /
 * `resolveLineage`, `src/store/recorded-capture/lineage.ts`).
 *
 * Both lanes register the SAME conformance body
 * (`tests/backends/integration/lineage-conformance.ts`) that the shared
 * cross-backend harness also runs, via a minimal `{ getStore }` context —
 * the one thing that body needs — built directly here instead of pulling in
 * the full `createIntegrationTestSuite` machinery, so an engine profile
 * outside this repository has a single, small function to point its own
 * suite at.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type EngineRevision,
} from "../src";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { recordedRelationsLineage } from "../src/store/recorded-capture";
import { registerLineageConformanceIntegrationTests } from "./backends/integration/lineage-conformance";

type MinimalStoreContext = Readonly<{ backend: GraphBackend }>;

describe("lineage: recorded relations (SQLite)", () => {
  let current: MinimalStoreContext | undefined;

  beforeEach(() => {
    current = { backend: createLocalSqliteBackend().backend };
  });

  afterEach(async () => {
    await current?.backend.close();
    current = undefined;
  });

  registerLineageConformanceIntegrationTests({
    getStore: () => {
      if (current === undefined) {
        throw new Error("SQLite lineage backend is not initialized.");
      }
      return current;
    },
  });
});

describe("lineage: recorded relations (PGlite)", () => {
  let current: MinimalStoreContext | undefined;

  beforeEach(async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    current = { backend };
  });

  afterEach(async () => {
    await current?.backend.close();
    current = undefined;
  });

  registerLineageConformanceIntegrationTests({
    getStore: () => {
      if (current === undefined) {
        throw new Error("PGlite lineage backend is not initialized.");
      }
      return current;
    },
  });
});

const NonCapturingPerson = defineNode("NonCapturingLineagePerson", {
  schema: z.object({ name: z.string() }),
});
const NonCapturingLink = defineEdge("NonCapturingLineageLink", {
  schema: z.object({ label: z.string() }),
});
const nonCapturingGraph = defineGraph({
  id: "lineage_requires_history",
  nodes: { NonCapturingLineagePerson: { type: NonCapturingPerson } },
  edges: {
    NonCapturingLineageLink: {
      type: NonCapturingLink,
      from: [NonCapturingPerson],
      to: [NonCapturingPerson],
    },
  },
});

describe("recordedRelationsLineage: history requirement", () => {
  it("refuses a store that was not constructed with history: true", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(nonCapturingGraph, backend, {
        revisionTracking: true,
      });
      const person = await store.nodes.NonCapturingLineagePerson.create({
        name: "Grace",
      });
      const second = await store.nodes.NonCapturingLineagePerson.create({
        name: "Katherine",
      });
      const link = await store.edges.NonCapturingLineageLink.create(
        { kind: "NonCapturingLineagePerson", id: person.id },
        { kind: "NonCapturingLineagePerson", id: second.id },
        { label: "colleague" },
      );

      const anchor = await store.lineageRevisionNow();
      expect(anchor).toBeDefined();
      await store.nodes.NonCapturingLineagePerson.update(person.id, {
        name: "Grace Hopper",
      });
      await store.edges.NonCapturingLineageLink.delete(link.id);
      await store.nodes.NonCapturingLineagePerson.delete(person.id);
      if (anchor === undefined)
        throw new Error("Expected a lineage revision anchor.");
      await expect(store.changesSince(anchor)).resolves.toMatchObject({
        kind: "keys",
        nodes: [{ kind: "NonCapturingLineagePerson", id: person.id }],
        edges: [{ kind: "NonCapturingLineageLink", id: link.id }],
      });

      await expect(
        store.changesSince("opaque-revision" as EngineRevision),
      ).resolves.toEqual({ kind: "unbounded" });

      expect(() => recordedRelationsLineage(store)).toThrow(
        /requires a store constructed with `history: true`/,
      );
    } finally {
      await backend.close();
    }
  });
});
