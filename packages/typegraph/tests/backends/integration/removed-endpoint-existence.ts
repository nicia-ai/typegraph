/**
 * A schema document an earlier release stored carries `endpointExistence` on
 * every edge, the option this release removed. Whatever value it records, the
 * store opens on it as on its own document: no diff, no new version, the row
 * left exactly as written, and its hash equal to the graph's hash today.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
} from "../../../src";
import { StoreAnalysisCursorStaleError } from "../../../src/errors-entry";
import { captureCandidateWriteSetTarget } from "../../../src/graph-merge";
import {
  computeBaseVersion,
  schemaComponentOf,
} from "../../../src/graph-merge/base-version";
import { readBranchForkState } from "../../../src/graph-merge/branch";
import { captureMergePlanTargetFence } from "../../../src/graph-merge/merge";
import { registerGraphTemplate } from "../../../src/schema/graph-templates";
import {
  activeSchemaHash,
  parseSerializedSchema,
} from "../../../src/schema/manager";
import { computeSchemaDiff } from "../../../src/schema/migration";
import {
  computeSchemaHash,
  getGraphDefinitionHash,
  serializeSchema,
} from "../../../src/schema/serializer";
import { type SerializedSchema } from "../../../src/schema/types";
import { createAdapterStoreWithSchema } from "../../../src/store/store";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const LEGACY_ENDPOINT_EXISTENCE_VALUES = [
  "notDeleted",
  "currentlyValid",
  "ever",
] as const;

const Member = defineNode("LegacyEndpointMember", {
  schema: z.object({ name: z.string() }),
});
const follows = defineEdge("legacyEndpointFollows", {
  schema: z.object({}),
});
const mentors = defineEdge("legacyEndpointMentors", {
  schema: z.object({ since: z.string() }),
});

function graphWithId(id: string) {
  return defineGraph({
    id,
    nodes: { LegacyEndpointMember: { type: Member } },
    edges: {
      legacyEndpointFollows: { type: follows, from: [Member], to: [Member] },
      legacyEndpointMentors: {
        type: mentors,
        from: [Member],
        to: [Member],
        cardinality: "one",
      },
    },
  });
}

/**
 * The document an earlier release wrote for `graph` when every edge stated
 * `endpointExistence`: today's serialization with that value on every edge.
 */
function legacyDocument(
  graph: ReturnType<typeof graphWithId>,
  endpointExistence: string,
): SerializedSchema {
  const current = serializeSchema(graph, 1);
  const edges = Object.fromEntries(
    Object.entries(current.edges).map(([kind, edge]) => [
      kind,
      { ...edge, endpointExistence },
    ]),
  );
  return { ...current, edges };
}

/** The id every hash below was taken under: a schema document names its graph. */
const PERSISTED_HASHES_GRAPH_ID = "removed_endpoint_existence_persisted_hashes";
const MEMBER_IDS = ["member-a", "member-b"] as const;

/**
 * What the release before the removal persisted for
 * `graphWithId(PERSISTED_HASHES_GRAPH_ID)`, recorded by running the producers
 * {@link persistedHashesOf} calls against that release's source on SQLite:
 * `notStated` with no edge stating the option, `ever` with every edge stating
 * `endpointExistence: "ever"`.
 *
 * Each is a hash a caller or a table keeps and a later release compares
 * against: the stored version's `schema_hash` column, a graph-template
 * registration, a candidate write set's target, a merge plan's target fence,
 * the schema half of a base version (a branch's base, a durable working
 * copy's descriptor, a plan's anchors), a durable working copy's attested
 * definition hash and schema anchor, and a `validateStore` page cursor, whose
 * schema fence hashes the active schema hash.
 */
const EARLIER_RELEASE = {
  notStated: {
    schemaHashColumn: "366fddcc11d6aaa2",
    templateRegistryHash: "366fddcc11d6aaa2",
    candidateWriteSetSchemaHash: "366fddcc11d6aaa2",
    mergePlanTargetSchemaHash: "366fddcc11d6aaa2",
    baseVersionSchemaComponent: "366fddcc11d6aaa2#s1",
    workingCopyDefinitionHash: "366fddcc11d6aaa2",
    branchSchemaAnchorHash: "366fddcc11d6aaa2",
    validateStoreCursor:
      "eyJ2IjoxLCJkIjoiZiIsImNvbHMiOlsidHlwZWdyYXBoLnZhbGlkYXRlU3RvcmUuZW50aXR5IiwidHlwZWdyYXBoLnZhbGlkYXRlU3RvcmUua2luZCIsInR5cGVncmFwaC52YWxpZGF0ZVN0b3JlLnNjaGVtYUZlbmNlIiwidHlwZWdyYXBoLnZhbGlkYXRlU3RvcmUuYWZ0ZXJJZCJdLCJ2YWxzIjpbIm5vZGUiLCJMZWdhY3lFbmRwb2ludE1lbWJlciIsIjQxM2Y2ODAwMTM4NjIwYjI1N2Q5ZmU4ZDllNWQ2NDk0IiwibWVtYmVyLWEiXX0",
  },
  ever: {
    schemaHashColumn: "58163bf4f9f8d29f",
    templateRegistryHash: "58163bf4f9f8d29f",
    candidateWriteSetSchemaHash: "58163bf4f9f8d29f",
    mergePlanTargetSchemaHash: "58163bf4f9f8d29f",
    baseVersionSchemaComponent: "58163bf4f9f8d29f#s1",
    workingCopyDefinitionHash: "58163bf4f9f8d29f",
    branchSchemaAnchorHash: "58163bf4f9f8d29f",
    validateStoreCursor:
      "eyJ2IjoxLCJkIjoiZiIsImNvbHMiOlsidHlwZWdyYXBoLnZhbGlkYXRlU3RvcmUuZW50aXR5IiwidHlwZWdyYXBoLnZhbGlkYXRlU3RvcmUua2luZCIsInR5cGVncmFwaC52YWxpZGF0ZVN0b3JlLnNjaGVtYUZlbmNlIiwidHlwZWdyYXBoLnZhbGlkYXRlU3RvcmUuYWZ0ZXJJZCJdLCJ2YWxzIjpbIm5vZGUiLCJMZWdhY3lFbmRwb2ludE1lbWJlciIsIjZjMzNhMGQyMWJkZDY4ZWQ1MWY1ODM5MDBjNjk1ZTQwIiwibWVtYmVyLWEiXX0",
  },
} as const;

/**
 * Opens `graph` with revision tracking (a merge plan's target fence needs
 * it) on `backend`, seeds the two members the cursor pages over, and takes
 * every persisted hash {@link EARLIER_RELEASE} records, through the function
 * that produces it. A template id is not hashed; each test registers its
 * own, because a server-PostgreSQL lane keeps template rows between tests.
 */
async function persistedHashesOf(
  graph: ReturnType<typeof graphWithId>,
  backend: ReturnType<IntegrationTestContext["getBackend"]>,
  templateId: string,
) {
  const [store, result] = await createAdapterStoreWithSchema(graph, backend, {
    revisionTracking: true,
  });
  for (const id of MEMBER_IDS) {
    await store.nodes.LegacyEndpointMember.create({ name: id }, { id });
  }
  const row = requireDefined(await backend.getActiveSchema(graph.id));
  const template = await registerGraphTemplate(backend, {
    templateId,
    reconciled: store.reconciledSchema,
  });
  const page = await store.validateStore({
    entity: "node",
    kind: "LegacyEndpointMember",
    pageSize: 1,
  });
  const candidateTarget = await captureCandidateWriteSetTarget(store);
  const mergePlanTarget = await captureMergePlanTargetFence(store);
  const forkState = await readBranchForkState(store, false);
  return {
    store,
    status: result.status,
    hashes: {
      schemaHashColumn: row.schema_hash,
      templateRegistryHash: template.registryHash,
      candidateWriteSetSchemaHash: candidateTarget.schemaHash,
      mergePlanTargetSchemaHash: mergePlanTarget.schema.hash,
      baseVersionSchemaComponent: schemaComponentOf(
        await computeBaseVersion(store),
      ),
      workingCopyDefinitionHash: await getGraphDefinitionHash(graph),
      branchSchemaAnchorHash: forkState.schemaAnchor?.hash,
      validateStoreCursor: page.nextCursor,
    },
  };
}

export function registerRemovedEndpointExistenceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a stored document carrying the removed endpointExistence", () => {
    it.each(LEGACY_ENDPOINT_EXISTENCE_VALUES)(
      "opens unchanged on endpointExistence %s and leaves the row as written",
      async (endpointExistence) => {
        const backend = context.getBackend();
        const graph = graphWithId(
          `legacy_endpoint_existence_${endpointExistence}`,
        );
        const storedDocument = legacyDocument(graph, endpointExistence);
        // The hash the earlier release computed and stored with the document.
        const storedHash = await computeSchemaHash(storedDocument);
        const currentHash = await computeSchemaHash(serializeSchema(graph, 1));
        // The value every registration that did not state the option wrote is
        // the one this release still writes, so its hash does not move at all;
        // any other recorded value is read as that one.
        expect(storedHash === currentHash).toBe(
          endpointExistence === "notDeleted",
        );
        await backend.commitSchemaVersion({
          graphId: graph.id,
          expected: { kind: "initial" },
          version: 1,
          schemaHash: storedHash,
          schemaDoc: storedDocument,
        });
        const written = requireDefined(await backend.getActiveSchema(graph.id));

        const [store, result] = await createStoreWithSchema(graph, backend);
        const row = requireDefined(await backend.getActiveSchema(graph.id));

        expect(result.status).toBe("unchanged");
        expect(row.version).toBe(1);
        expect(row.schema_doc).toBe(written.schema_doc);
        expect(row.schema_hash).toBe(storedHash);
        expect(await activeSchemaHash(row)).toBe(currentHash);
        expect(
          computeSchemaDiff(
            parseSerializedSchema(row.schema_doc),
            serializeSchema(graph, 2),
          ).hasChanges,
        ).toBe(false);

        // The stored value never relaxed the endpoint check, and still does not.
        const alice = await store.nodes.LegacyEndpointMember.create({
          name: "Alice",
        });
        const bob = await store.nodes.LegacyEndpointMember.create({
          name: "Bob",
        });
        const carol = await store.nodes.LegacyEndpointMember.create({
          name: "Carol",
        });
        await store.edges.legacyEndpointFollows.create(alice, carol, {});
        await store.nodes.LegacyEndpointMember.delete(bob.id);
        await expect(
          store.edges.legacyEndpointMentors.create(alice, bob, {
            since: "2026",
          }),
        ).rejects.toBeInstanceOf(EndpointNotFoundError);

        const [, reopened] = await createStoreWithSchema(graph, backend);
        expect(reopened.status).toBe("unchanged");
        expect(
          requireDefined(await backend.getActiveSchema(graph.id)).version,
        ).toBe(1);
      },
    );
  });
  describe("hashes the release before the removal persisted", () => {
    // A graph that never stated the option: nothing at all changes. Every
    // persisted hash is the value the earlier release produced, so each of
    // them is still accepted where it is compared, and the cursor that
    // release issued resumes.
    it("are reproduced exactly for a graph that never stated endpointExistence", async () => {
      const backend = context.getBackend();
      const graph = graphWithId(PERSISTED_HASHES_GRAPH_ID);

      const { store, hashes } = await persistedHashesOf(
        graph,
        backend,
        "removed-endpoint-existence-not-stated",
      );
      const resumed = await store.validateStore({
        entity: "node",
        kind: "LegacyEndpointMember",
        pageSize: 1,
        cursor: EARLIER_RELEASE.notStated.validateStoreCursor,
      });

      expect(hashes).toEqual(EARLIER_RELEASE.notStated);
      expect(resumed.scannedCount).toBe(1);
    });

    // A graph that stated "ever": the stored version and a template
    // registered from it carry over; every hash taken over the graph as
    // declared today moves to the hash of the graph without the option, so
    // the artefact that recorded the earlier one is refused where it is
    // compared (a merge plan, a candidate write set, a branch or durable
    // working copy forked from it, a validateStore cursor) and must be
    // produced again.
    it('moves every hash over the declared graph for a graph that stated "ever", and only those', async () => {
      const backend = context.getBackend();
      const graph = graphWithId(PERSISTED_HASHES_GRAPH_ID);
      const storedDocument = legacyDocument(graph, "ever");
      const storedHash = await computeSchemaHash(storedDocument);
      expect(storedHash).toBe(EARLIER_RELEASE.ever.schemaHashColumn);
      await backend.commitSchemaVersion({
        graphId: graph.id,
        expected: { kind: "initial" },
        version: 1,
        schemaHash: storedHash,
        schemaDoc: storedDocument,
      });
      await requireDefined(backend.registerGraphTemplate)({
        templateId: "removed-endpoint-existence-ever",
        schemaHash: storedHash,
        schemaDoc: storedDocument,
      });

      const { store, status, hashes } = await persistedHashesOf(
        graph,
        backend,
        "removed-endpoint-existence-ever",
      );

      expect(status).toBe("unchanged");
      expect(hashes).toEqual({
        ...EARLIER_RELEASE.notStated,
        schemaHashColumn: EARLIER_RELEASE.ever.schemaHashColumn,
        templateRegistryHash: EARLIER_RELEASE.ever.templateRegistryHash,
      });
      await expect(
        store.validateStore({
          entity: "node",
          kind: "LegacyEndpointMember",
          pageSize: 1,
          cursor: EARLIER_RELEASE.ever.validateStoreCursor,
        }),
      ).rejects.toBeInstanceOf(StoreAnalysisCursorStaleError);
    });
  });
}
