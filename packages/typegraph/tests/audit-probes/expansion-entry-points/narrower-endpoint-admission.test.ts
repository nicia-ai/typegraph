import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  broader,
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Topic = defineNode("Topic", { schema: z.object({ name: z.string() }) });
const SubTopic = defineNode("SubTopic", {
  schema: z.object({ name: z.string() }),
});
const Note = defineNode("Note", { schema: z.object({ text: z.string() }) });

// The same edge admitting only Topic, declared in the two supported forms.
const aboutOnType = defineEdge("aboutOnType", {
  schema: z.object({}),
  from: [Note],
  to: [Topic],
});
const aboutOnGraph = defineEdge("aboutOnGraph", { schema: z.object({}) });

const graph = defineGraph({
  id: "audit_narrower_endpoint_admission",
  nodes: {
    Topic: { type: Topic },
    SubTopic: { type: SubTopic },
    Note: { type: Note },
  },
  edges: {
    aboutOnType: aboutOnType,
    aboutOnGraph: { type: aboutOnGraph, from: [Note], to: [Topic] },
  },
  ontology: [broader(SubTopic, Topic)],
});

function codeOf(error: unknown): unknown {
  return error instanceof ConfigurationError ? error.details["code"] : error;
}

describe("expansion-entry-points", () => {
  // The changeset: a narrower expansion on to()/toDynamic() is refused when the
  // traversed edge does not admit an expanded kind
  // (ONTOLOGY_NARROWER_ENDPOINT_NOT_ADMITTED). The check reads the endpoint
  // list off the registry's edge TYPE, which is empty for an edge whose
  // endpoints are declared where graphs normally declare them, on the graph's
  // edge registration. There the check is vacuous and the narrower alias
  // silently collapses to the endpoint's own kind.
  it("narrower-endpoint-admission-graph-registered", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());

    // Control: endpoints carried by the edge type are refused.
    expect(() =>
      store
        .query()
        .from("Note", "n")
        .traverse("aboutOnType", "e")
        .to("Topic", "t", { expansion: "narrower" }),
    ).toThrow(ConfigurationError);

    const attempts: Record<string, () => unknown> = {
      to: () =>
        store
          .query()
          .from("Note", "n")
          .traverse("aboutOnGraph", "e")
          .to("Topic", "t", { expansion: "narrower" }),
      toDynamic: () =>
        store
          .query()
          .from("Note", "n")
          .traverse("aboutOnGraph", "e")
          .toDynamic("Topic", "t", { expansion: "narrower" }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect
        .soft(codeOf(caught), name)
        .toBe("ONTOLOGY_NARROWER_ENDPOINT_NOT_ADMITTED");
    }

    // Same root cause, exact axis: toDynamic's own endpoint check also reads
    // the empty edge-type endpoint list, so a kind the edge never admits is
    // accepted at build time here but refused for the type-declared edge.
    let exactCaught: unknown;
    try {
      store
        .query()
        .from("Note", "n")
        .traverse("aboutOnGraph", "e")
        .toDynamic("Note", "t", { expansion: "exact" });
    } catch (error) {
      exactCaught = error;
    }
    expect.soft(exactCaught, "toDynamic exact").toBeInstanceOf(Error);
  });
});
