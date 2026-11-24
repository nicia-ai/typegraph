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
import {
  activeSchemaHash,
  parseSerializedSchema,
} from "../../../src/schema/manager";
import { computeSchemaDiff } from "../../../src/schema/migration";
import {
  computeSchemaHash,
  serializeSchema,
} from "../../../src/schema/serializer";
import { type SerializedSchema } from "../../../src/schema/types";
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
}
