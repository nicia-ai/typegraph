import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({}) });

function buildGraph(endpointExistence?: "notDeleted" | "ever") {
  return defineGraph({
    id: "endpoint_existence_graph",
    nodes: { Person: { type: Person } },
    edges: {
      knows: {
        type: knows,
        from: [Person],
        to: [Person],
        ...(endpointExistence === undefined ? {} : { endpointExistence }),
      },
    },
  });
}

async function storedEndpointExistence(
  backend: ReturnType<typeof createTestBackend>,
): Promise<string> {
  const row = await backend.getActiveSchema("endpoint_existence_graph");
  const document = JSON.parse(requireDefined(row).schema_doc) as {
    edges: { knows: { endpointExistence: string } };
  };
  return document.edges.knows.endpointExistence;
}

describe("ensureSchema and edge endpointExistence", () => {
  it("commits a new version when only endpointExistence changes", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(buildGraph("notDeleted"), backend);

    const [, result] = await createStoreWithSchema(buildGraph("ever"), backend);

    expect(result.status).toBe("migrated");
    expect(await storedEndpointExistence(backend)).toBe("ever");
  });

  it("stays unchanged on a no-op redeploy, explicit or defaulted", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(buildGraph(), backend);

    const [, implicit] = await createStoreWithSchema(buildGraph(), backend);
    const [, explicit] = await createStoreWithSchema(
      buildGraph("notDeleted"),
      backend,
    );

    expect(implicit.status).toBe("unchanged");
    expect(explicit.status).toBe("unchanged");
  });
});
