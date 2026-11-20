import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import {
  computeSchemaDiff,
  deserializeSchema,
  getMigrationActions,
  serializeSchema,
} from "../src/schema";
import { serializedSchemaZod } from "../src/schema/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const friendship = defineEdge("friendship", {
  schema: z.object({ since: z.string(), source: z.string() }),
});

function graphWithIdentity(
  matchIdentity:
    | Readonly<{
        name: string;
        fields: readonly ("since" | "source")[];
      }>
    | undefined,
) {
  return defineGraph({
    id: "identity-test",
    nodes: { Person: { type: Person } },
    edges: {
      friendship: {
        type: friendship,
        from: [Person],
        to: [Person],
        ...(matchIdentity === undefined ? {} : { matchIdentity }),
      },
    },
  });
}

describe("durable edge match identity schema", () => {
  it("canonicalizes, serializes, and deserializes one graph-local identity", () => {
    const graph = graphWithIdentity({
      name: "friendship-key",
      fields: ["source", "since"],
    });
    const serialized = serializeSchema(graph, 1);

    expect(graph.edges.friendship.matchIdentity).toEqual({
      name: "friendship-key",
      fields: ["since", "source"],
    });
    expect(serialized.edges["friendship"]?.matchIdentity).toEqual({
      name: "friendship-key",
      fields: ["since", "source"],
    });
    expect(serializedSchemaZod.safeParse(serialized).success).toBe(true);
    expect(
      deserializeSchema(serialized).getEdge("friendship")?.matchIdentity,
    ).toEqual({
      name: "friendship-key",
      fields: ["since", "source"],
    });
  });

  it("rejects empty names, duplicate fields, and undeclared fields", () => {
    expect(() => graphWithIdentity({ name: "", fields: ["since"] })).toThrow(
      /non-empty string/,
    );
    expect(() =>
      graphWithIdentity({ name: "duplicate", fields: ["since", "since"] }),
    ).toThrow(/repeats field/);
    expect(() =>
      graphWithIdentity({
        name: "unknown",
        fields: ["source", "missing" as "source"],
      }),
    ).toThrow(/undeclared field/);
  });

  it("supports an endpoint-only identity", () => {
    expect(
      graphWithIdentity({ name: "directed-endpoints", fields: [] }).edges
        .friendship.matchIdentity,
    ).toEqual({ name: "directed-endpoints", fields: [] });
  });

  it("omits the optional field for legacy edges", () => {
    const serialized = serializeSchema(graphWithIdentity(undefined), 1);
    expect(serialized.edges["friendship"]?.matchIdentity).toBeUndefined();
    expect(serializedSchemaZod.safeParse(serialized).success).toBe(true);
  });

  it("marks identity add, remove, and change as breaking rekeys", () => {
    const without = serializeSchema(graphWithIdentity(undefined), 1);
    const withSince = serializeSchema(
      graphWithIdentity({ name: "friendship-key", fields: ["since"] }),
      2,
    );
    const withSource = serializeSchema(
      graphWithIdentity({ name: "other-key", fields: ["source"] }),
      3,
    );

    for (const [before, after] of [
      [without, withSince],
      [withSince, without],
      [withSince, withSource],
    ] as const) {
      const diff = computeSchemaDiff(before, after);
      const identityChange = diff.edges.find((change) =>
        change.details.startsWith("Match identity"),
      );
      expect(identityChange?.severity).toBe("breaking");
      expect(
        getMigrationActions(diff).some((action) =>
          action.startsWith("REKEY edge data"),
        ),
      ).toBe(true);
    }
  });

  it("treats identity field order as canonical-equivalent", () => {
    const first = serializeSchema(
      graphWithIdentity({
        name: "friendship-key",
        fields: ["since", "source"],
      }),
      1,
    );
    const second = serializeSchema(
      graphWithIdentity({
        name: "friendship-key",
        fields: ["source", "since"],
      }),
      2,
    );

    expect(
      computeSchemaDiff(first, second).edges.some((change) =>
        change.details.startsWith("Match identity"),
      ),
    ).toBe(false);
  });
});
