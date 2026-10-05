import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  hasPart,
  partOf,
  TypeGraphError,
} from "../../../src";
import { buildKindRegistry } from "../../../src/registry";
import { createTestBackend } from "../../test-utils";

const emptySchema = z.object({});
const Part = defineNode("Part", { schema: emptySchema });
const Whole = defineNode("Whole", { schema: emptySchema });
const realizes = defineEdge("realizes", { schema: emptySchema });

/** Declares, builds the registry and opens a store; returns the refusal, if any. */
async function declareAndOpen(
  declare: () => Parameters<typeof buildKindRegistry>[0],
): Promise<unknown> {
  try {
    const graph = declare();
    buildKindRegistry(graph);
    await createStoreWithSchema(graph, createTestBackend());
    return undefined;
  } catch (error) {
    return error;
  }
}

function partWholeGraph(ontology: readonly unknown[]) {
  return defineGraph({
    id: "declaration_probe",
    nodes: { Part: { type: Part }, Whole: { type: Whole } },
    edges: {
      realizes: {
        type: realizes,
        from: [Part],
        to: [Whole],
        cardinality: "one",
      },
    },
    ontology: ontology as never,
  });
}

describe("declaration options audit", () => {
  it("existence-mirror-first-wins: mirrored partOf/hasPart disagreeing on existence refuse in both declaration orders", async () => {
    const outcome = (ontology: readonly unknown[]) => {
      try {
        return buildKindRegistry(partWholeGraph(ontology)).compositionExistence(
          "Part",
        );
      } catch {
        return "refused";
      }
    };
    const optionalFirst = outcome([
      partOf(Part, Whole, { via: realizes, existence: "optional" }),
      hasPart(Whole, Part, { via: realizes, existence: "required" }),
    ]);
    const requiredFirst = outcome([
      hasPart(Whole, Part, { via: realizes, existence: "required" }),
      partOf(Part, Whole, { via: realizes, existence: "optional" }),
    ]);
    expect.soft(optionalFirst).toBe("refused");
    expect.soft(requiredFirst).toBe("refused");
  });

  it("existence-mirror-first-wins-extension: the same disagreement in a runtime extension document is refused", async () => {
    const Base = defineNode("Base", { schema: emptySchema });
    const base = defineGraph({
      id: "declaration_probe_extension",
      nodes: { Base: { type: Base } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(base, createTestBackend());
    const evolve = async () =>
      store.evolve(
        defineGraphExtension({
          nodes: { A: { properties: {} }, B: { properties: {} } },
          edges: {
            e: { from: ["A"], to: ["B"], properties: {}, cardinality: "one" },
          },
          ontology: [
            { metaEdge: "partOf", from: "A", to: "B", via: "e" },
            {
              metaEdge: "hasPart",
              from: "B",
              to: "A",
              via: "e",
              existence: "required",
            },
          ],
        }),
      );
    await expect(evolve()).rejects.toBeInstanceOf(TypeGraphError);
  });

  it("existence-value-unvalidated: an existence value outside optional/required is refused at declaration, not persisted unloadable", async () => {
    const backend = createTestBackend();
    const graph = partWholeGraph([
      partOf(Part, Whole, { via: realizes, existence: "require" as never }),
    ]);
    let refused: unknown;
    try {
      buildKindRegistry(graph);
      await createStoreWithSchema(graph, backend);
    } catch (error) {
      refused = error;
    }
    expect.soft(refused).toBeInstanceOf(TypeGraphError);
    // Whatever was accepted must at least reopen.
    await expect.soft(createStoreWithSchema(graph, backend)).resolves.toBeDefined();
  });

  it("composition-option-unknown-key-ignored: an unrecognized partOf option key is refused rather than dropped", async () => {
    const refused = await declareAndOpen(() =>
      partWholeGraph([
        partOf(Part, Whole, {
          via: realizes,
          existance: "required",
        } as never),
      ]),
    );
    expect(refused).toBeInstanceOf(TypeGraphError);
  });
});
