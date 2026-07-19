/**
 * `evolve()` additive-modify classification matrix.
 *
 * Each delta type is either Allowed (proceeds without data
 * inspection), Allowed-on-empty (proceeds only when the kind has no
 * rows — the empty-kind probe gates the commit), or Rejected
 * (`IncompatibleChangeError`). Same-shape re-evolves are no-ops.
 * Genuinely incompatible changes (`REMOVE_PROPERTY`, `TYPE_CHANGE`)
 * reject regardless of row count.
 *
 * Test layout: each scenario is a triple `(initial, populate?, modify)`
 * passed through `runModifyScenario`. The helper handles the
 * `createTestBackend` + `createStoreWithSchema` + initial `evolve`
 * scaffolding and returns either the post-modify store or the caught
 * error, so each test focuses on the classification expectation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import {
  defineGraphExtension,
  type GraphExtension,
  type IncompatibleChange,
  IncompatibleChangeError,
} from "../src/graph-extension";
import { createStoreWithSchema, type Store } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "evolve_modify",
  nodes: { Person: { type: Person } },
  edges: {},
});

// ============================================================
// Scenario runner
// ============================================================

type AnyStore = Store<typeof baseGraph>;

type ModifyScenarioResult =
  { ok: true; store: AnyStore } | { ok: false; error: unknown };

async function runModifyScenario(args: {
  initial: GraphExtension;
  populate?: (store: AnyStore) => Promise<void>;
  modify: GraphExtension;
}): Promise<ModifyScenarioResult> {
  const backend = createTestBackend();
  const [store] = await createStoreWithSchema(baseGraph, backend);
  const v1 = await store.evolve(defineGraphExtension(args.initial));
  if (args.populate !== undefined) await args.populate(v1);
  try {
    const result = await v1.evolve(defineGraphExtension(args.modify));
    return { ok: true, store: result };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectAllowed(result: ModifyScenarioResult): asserts result is {
  ok: true;
  store: AnyStore;
} {
  if (!result.ok) {
    throw new Error(
      `expected modify to succeed, got: ${
        result.error instanceof Error ?
          result.error.message
        : String(result.error)
      }`,
    );
  }
}

function expectRejection(
  result: ModifyScenarioResult,
  match: { type: IncompatibleChange["type"]; kind?: string; field?: string },
): IncompatibleChangeError {
  if (result.ok) {
    throw new Error("expected modify to reject, but it succeeded");
  }
  expect(result.error).toBeInstanceOf(IncompatibleChangeError);
  const error = result.error as IncompatibleChangeError;
  const matched = error.changes.some(
    (change) =>
      change.type === match.type &&
      (match.kind === undefined || change.kind === match.kind) &&
      (match.field === undefined || change.field === match.field),
  );
  if (!matched) {
    throw new Error(
      `expected change matching ${JSON.stringify(match)}; got: ${JSON.stringify(error.changes)}`,
    );
  }
  return error;
}

// ============================================================
// Allowed (additive / loosening) deltas
// ============================================================

describe("Store.evolve — Allowed deltas", () => {
  it("ADD_OPTIONAL_PROPERTY on a populated kind succeeds", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: { Doc: { properties: { title: { type: "string" } } } },
        },
        populate: async (store) => {
          await store.getNodeCollectionOrThrow("Doc").create({ title: "α" });
        },
        modify: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                summary: { type: "string", optional: true },
              },
            },
          },
        },
      }),
    );
  });

  it("LOOSEN_OPTIONALITY on a populated kind succeeds", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                category: { type: "string" },
              },
            },
          },
        },
        populate: async (store) => {
          await store
            .getNodeCollectionOrThrow("Doc")
            .create({ title: "a", category: "b" });
        },
        modify: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                category: { type: "string", optional: true },
              },
            },
          },
        },
      }),
    );
  });

  it("LOOSEN_CONSTRAINT (decrease minLength) on a populated kind succeeds", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: {
            Doc: { properties: { title: { type: "string", minLength: 5 } } },
          },
        },
        populate: async (store) => {
          await store
            .getNodeCollectionOrThrow("Doc")
            .create({ title: "alpha" });
        },
        modify: {
          nodes: {
            Doc: { properties: { title: { type: "string", minLength: 1 } } },
          },
        },
      }),
    );
  });

  it("LOOSEN_ENUM (add value) on a populated kind succeeds", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: {
            Status: {
              properties: {
                level: { type: "enum", values: ["low", "high"] },
              },
            },
          },
        },
        populate: async (store) => {
          await store
            .getNodeCollectionOrThrow("Status")
            .create({ level: "low" });
        },
        modify: {
          nodes: {
            Status: {
              properties: {
                level: {
                  type: "enum",
                  values: ["low", "medium", "high"],
                },
              },
            },
          },
        },
      }),
    );
  });

  it("DROP_PATTERN on a populated kind succeeds", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: {
            Code: {
              properties: { value: { type: "string", pattern: "^[A-Z]+$" } },
            },
          },
        },
        populate: async (store) => {
          await store.getNodeCollectionOrThrow("Code").create({ value: "ABC" });
        },
        modify: {
          nodes: { Code: { properties: { value: { type: "string" } } } },
        },
      }),
    );
  });

  it("ADD_SEARCHABLE on a populated kind succeeds", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: { Note: { properties: { body: { type: "string" } } } },
        },
        populate: async (store) => {
          await store
            .getNodeCollectionOrThrow("Note")
            .create({ body: "first" });
        },
        modify: {
          nodes: {
            Note: {
              properties: {
                body: {
                  type: "string",
                  searchable: { language: "english" },
                },
              },
            },
          },
        },
      }),
    );
  });
});

// ============================================================
// Allowed-on-empty deltas — empty kind branch
// ============================================================

describe("Store.evolve — Allowed-on-empty (empty branch)", () => {
  it("ADD_REQUIRED_PROPERTY succeeds when the kind is empty", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: { Doc: { properties: { title: { type: "string" } } } },
        },
        modify: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                category: { type: "string" }, // required, but Doc is empty
              },
            },
          },
        },
      }),
    );
  });

  it("TIGHTEN_CONSTRAINT (increase minLength) succeeds when the kind is empty", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: { Doc: { properties: { title: { type: "string" } } } },
        },
        modify: {
          nodes: {
            Doc: { properties: { title: { type: "string", minLength: 10 } } },
          },
        },
      }),
    );
  });

  it("TIGHTEN_ENUM (remove value) succeeds when the kind is empty", async () => {
    expectAllowed(
      await runModifyScenario({
        initial: {
          nodes: {
            Status: {
              properties: {
                level: { type: "enum", values: ["low", "medium", "high"] },
              },
            },
          },
        },
        modify: {
          nodes: {
            Status: {
              properties: {
                level: { type: "enum", values: ["low", "high"] },
              },
            },
          },
        },
      }),
    );
  });
});

// ============================================================
// Allowed-on-empty deltas — populated branch (rejection)
// ============================================================

describe("Store.evolve — Allowed-on-empty (populated branch rejects)", () => {
  it("TIGHTEN_CONSTRAINT on a populated kind rejects", async () => {
    expectRejection(
      await runModifyScenario({
        initial: {
          nodes: { Doc: { properties: { title: { type: "string" } } } },
        },
        populate: async (store) => {
          await store.getNodeCollectionOrThrow("Doc").create({ title: "x" });
        },
        modify: {
          nodes: {
            Doc: { properties: { title: { type: "string", minLength: 10 } } },
          },
        },
      }),
      { type: "TIGHTEN_CONSTRAINT" },
    );
  });

  it("TIGHTEN_OPTIONALITY on a populated kind rejects", async () => {
    expectRejection(
      await runModifyScenario({
        initial: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                extra: { type: "string", optional: true },
              },
            },
          },
        },
        populate: async (store) => {
          await store.getNodeCollectionOrThrow("Doc").create({ title: "a" });
        },
        modify: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                extra: { type: "string" }, // newly required
              },
            },
          },
        },
      }),
      { type: "TIGHTEN_OPTIONALITY" },
    );
  });

  it("TIGHTEN_ENUM on a populated kind rejects", async () => {
    expectRejection(
      await runModifyScenario({
        initial: {
          nodes: {
            Status: {
              properties: {
                level: { type: "enum", values: ["low", "medium", "high"] },
              },
            },
          },
        },
        populate: async (store) => {
          await store
            .getNodeCollectionOrThrow("Status")
            .create({ level: "low" });
        },
        modify: {
          nodes: {
            Status: {
              properties: {
                level: { type: "enum", values: ["low", "high"] },
              },
            },
          },
        },
      }),
      { type: "TIGHTEN_ENUM" },
    );
  });
});

// ============================================================
// Rejected — always
// ============================================================

describe("Store.evolve — Rejected deltas", () => {
  it("REMOVE_PROPERTY rejects regardless of row count", async () => {
    // Empty kind on purpose — REMOVE_PROPERTY is unconditional
    // rejection independent of populate.
    expectRejection(
      await runModifyScenario({
        initial: {
          nodes: {
            Doc: {
              properties: {
                title: { type: "string" },
                extra: { type: "string", optional: true },
              },
            },
          },
        },
        modify: {
          nodes: { Doc: { properties: { title: { type: "string" } } } },
        },
      }),
      { type: "REMOVE_PROPERTY", field: "extra" },
    );
  });

  it("TYPE_CHANGE rejects regardless of row count", async () => {
    expectRejection(
      await runModifyScenario({
        initial: {
          nodes: { Doc: { properties: { count: { type: "string" } } } },
        },
        modify: {
          nodes: { Doc: { properties: { count: { type: "number" } } } },
        },
      }),
      { type: "TYPE_CHANGE", field: "count" },
    );
  });

  it("multi-kind evolve aggregates rejections atomically", async () => {
    const error = expectRejection(
      await runModifyScenario({
        initial: {
          nodes: {
            Doc: { properties: { title: { type: "string" } } },
            Tag: { properties: { label: { type: "string" } } },
          },
        },
        modify: {
          nodes: {
            Doc: { properties: { title: { type: "number" } } }, // TYPE_CHANGE
            Tag: { properties: {} }, // REMOVE_PROPERTY (label)
          },
        },
      }),
      { type: "TYPE_CHANGE" },
    );
    const kinds = new Set(error.changes.map((change) => change.kind));
    expect(kinds.has("Doc")).toBe(true);
    expect(kinds.has("Tag")).toBe(true);
  });
});

// ============================================================
// No-op (existing behavior preserved)
// ============================================================

describe("Store.evolve — No-op preserved", () => {
  it("same-shape re-evolve is idempotent (no version bump, no rejection)", async () => {
    const extension = defineGraphExtension({
      nodes: { Doc: { properties: { title: { type: "string" } } } },
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const v1 = await store.evolve(extension);
    const v1Active = await backend.getActiveSchema(baseGraph.id);

    const v2 = await v1.evolve(extension);
    const v2Active = await backend.getActiveSchema(baseGraph.id);

    expect(v2Active?.version).toBe(v1Active?.version);
    expect(v2.registry.hasNodeType("Doc")).toBe(true);
  });
});

// ============================================================
// Restart parity
// ============================================================

describe("Store.evolve — modify restart parity", () => {
  it("after a successful additive-modify, a fresh store reads the modified shape", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const v1 = await store.evolve(
      defineGraphExtension({
        nodes: { Doc: { properties: { title: { type: "string" } } } },
      }),
    );
    await v1.evolve(
      defineGraphExtension({
        nodes: {
          Doc: {
            properties: {
              title: { type: "string" },
              summary: { type: "string", optional: true },
            },
          },
        },
      }),
    );

    const [reloaded] = await createStoreWithSchema(baseGraph, backend);
    const intro = reloaded.introspect();
    const documentKind = intro.kinds.find((kind) => kind.name === "Doc");
    expect(documentKind).toBeDefined();
    const documentDocument = intro.extension?.nodes?.["Doc"];
    expect(documentDocument?.properties["summary"]).toBeDefined();
    expect(documentDocument?.properties["title"]).toBeDefined();
  });
});

// ============================================================
// Edge-keyed empty-probe (regression guard for the
// node-vs-edge-count probe bug fixed in the simplify pass)
// ============================================================

describe("Store.evolve — edge-keyed empty-probe", () => {
  // Prior bug: TIGHTEN_EDGE_ENDPOINTS deltas were keyed by edge name
  // and the probe ran `countNodesByKind` against that name —
  // returning 0 for every edge name and silently bypassing the
  // empty-kind gate. The fix: track entity per requireEmpty entry
  // and dispatch to `countEdgesByKind` for edges.
  it("rejects TIGHTEN_EDGE_ENDPOINTS when the edge has rows", async () => {
    const result = await runModifyScenario({
      initial: {
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
          Topic: { properties: { name: { type: "string" } } },
          Author: { properties: { name: { type: "string" } } },
        },
        edges: {
          appliesTo: {
            from: ["Tag", "Topic"],
            to: ["Author"],
            properties: {},
          },
        },
      },
      populate: async (store) => {
        interface WithId {
          id: string;
        }
        const tag = (await store
          .getNodeCollectionOrThrow("Tag")
          .create({ label: "alpha" })) as unknown as WithId;
        const author = (await store
          .getNodeCollectionOrThrow("Author")
          .create({ name: "v" })) as unknown as WithId;
        await store
          .getEdgeCollectionOrThrow("appliesTo")
          .create(
            { kind: "Tag", id: tag.id },
            { kind: "Author", id: author.id },
            {},
          );
      },
      modify: {
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
          Topic: { properties: { name: { type: "string" } } },
          Author: { properties: { name: { type: "string" } } },
        },
        edges: {
          appliesTo: { from: ["Tag"], to: ["Author"], properties: {} },
        },
      },
    });
    expectRejection(result, {
      type: "TIGHTEN_EDGE_ENDPOINTS",
      kind: "appliesTo",
    });
  });
});
