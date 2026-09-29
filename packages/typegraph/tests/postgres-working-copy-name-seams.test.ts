import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineNode } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import { ConfigurationError } from "../src/errors";
import { defineNodeIndex } from "../src/indexes";
import {
  bindRelationalIndexNameResolver,
  bindRelationalIndexNames,
  prepareRelationalIndexNames,
  relationalIndexIdentity,
  relationalIndexPhysicalName,
} from "../src/indexes/physical-name";
import {
  allocationVectorTablePrefix,
  createPgvectorStrategyForAllocation,
} from "../src/query/dialect/vector/pgvector-strategy";
import { createTestBackend } from "./test-utils";

const PREFIX_A = `tgw_${"a".repeat(24)}_`;
const PREFIX_B = `tgw_${"b".repeat(24)}_`;
const POSTGRES_IDENTIFIER_LIMIT = 63;

describe("allocation vector table prefix", () => {
  const slot = { dimensions: 3, metric: "cosine", indexType: "hnsw" } as const;

  it.each([
    ["short", "g", "K", "f"],
    ["long", "g".repeat(200), "Kind".repeat(60), "field.path".repeat(30)],
    ["unicode", "graph-é", "Ünïcode", "fïeld"],
  ])(
    "leads every %s vector table name with the header",
    (_label, graphId, nodeKind, fieldPath) => {
      for (const prefix of [PREFIX_A, PREFIX_B]) {
        const strategy = createPgvectorStrategyForAllocation(prefix);
        const table = strategy.tableName(graphId, nodeKind, fieldPath);
        expect(table.startsWith(allocationVectorTablePrefix(prefix))).toBe(
          true,
        );
        expect(table.length).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_LIMIT);
        const owned = strategy.ownedTables({
          graphId,
          nodeKind,
          fieldPath,
          ...slot,
        });
        for (const contribution of owned) {
          expect(
            contribution.tableName.startsWith(
              allocationVectorTablePrefix(prefix),
            ),
          ).toBe(true);
        }
      }
    },
  );

  it("is prefix-free across distinct allocations", () => {
    const headerA = allocationVectorTablePrefix(PREFIX_A);
    const headerB = allocationVectorTablePrefix(PREFIX_B);
    expect(headerA).not.toBe(headerB);
    expect(headerA.length).toBe(headerB.length);
    const tableB = createPgvectorStrategyForAllocation(PREFIX_B).tableName(
      "g",
      "K",
      "f",
    );
    expect(tableB.startsWith(headerA)).toBe(false);
  });

  it.each(["", "tgw_short_", `tgw_${"g".repeat(24)}_`, `${PREFIX_A}x`])(
    "refuses the malformed physical prefix %j",
    (prefix) => {
      expect(() => allocationVectorTablePrefix(prefix)).toThrow(
        /Invalid PostgreSQL working-copy physical prefix/u,
      );
    },
  );
});

// Only object identity keys the binding; no backend behavior is exercised.
const backend = (): GraphBackend => ({}) as GraphBackend;

describe("lazily resolved relational index names", () => {
  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const nameIndex = defineNodeIndex(Person, {
    fields: ["name"],
    name: "by_name",
  });
  const otherIndex = defineNodeIndex(Person, {
    fields: ["name"],
    name: "by_other",
  });

  it("refuses an unprepared declaration instead of using its global name", () => {
    const bound = backend();
    bindRelationalIndexNameResolver(bound, () => Promise.resolve(new Map()));
    expect(() => relationalIndexPhysicalName(bound, nameIndex)).toThrow(
      expect.objectContaining({
        details: { code: "WORKING_COPY_INDEX_UNDECLARED" },
      }),
    );
  });

  it("resolves a declaration once prepared and mints each name once", async () => {
    const bound = backend();
    const requested: string[][] = [];
    bindRelationalIndexNameResolver(bound, (declarations) => {
      requested.push(declarations.map((declaration) => declaration.name));
      return Promise.resolve(
        new Map(
          declarations.map((declaration) => [
            relationalIndexIdentity(declaration),
            `scoped_${declaration.name}`,
          ]),
        ),
      );
    });

    await prepareRelationalIndexNames(bound, [nameIndex]);
    await prepareRelationalIndexNames(bound, [nameIndex, otherIndex]);

    expect(relationalIndexPhysicalName(bound, nameIndex)).toBe(
      "scoped_by_name",
    );
    expect(relationalIndexPhysicalName(bound, otherIndex)).toBe(
      "scoped_by_other",
    );
    expect(requested).toEqual([["by_name"], ["by_other"]]);
  });

  it("refuses two declarations that resolve to one physical name", async () => {
    const bound = backend();
    bindRelationalIndexNameResolver(bound, (declarations) =>
      Promise.resolve(
        new Map(
          declarations.map((declaration) => [
            relationalIndexIdentity(declaration),
            "shared_physical_name",
          ]),
        ),
      ),
    );
    await prepareRelationalIndexNames(bound, [nameIndex]);

    await expect(
      prepareRelationalIndexNames(bound, [otherIndex]),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("leaves unbound and statically bound backends untouched", async () => {
    const unbound = backend();
    const fixed = backend();
    bindRelationalIndexNames(fixed, new Map());

    await prepareRelationalIndexNames(unbound, [nameIndex]);
    await prepareRelationalIndexNames(fixed, [nameIndex]);

    expect(relationalIndexPhysicalName(unbound, nameIndex)).toBe("by_name");
    expect(() => relationalIndexPhysicalName(fixed, nameIndex)).toThrow(
      ConfigurationError,
    );
  });

  it("lets a backend derived from a resolver-bound backend mint and read the same names", async () => {
    const bound = createTestBackend();
    const derived = deriveBackend(deriveBackend(bound, {}), {});
    bindRelationalIndexNameResolver(bound, (declarations) =>
      Promise.resolve(
        new Map(
          declarations.map((declaration) => [
            relationalIndexIdentity(declaration),
            `scoped_${declaration.name}`,
          ]),
        ),
      ),
    );

    await prepareRelationalIndexNames(derived, [nameIndex]);

    expect(relationalIndexPhysicalName(derived, nameIndex)).toBe(
      "scoped_by_name",
    );
    expect(relationalIndexPhysicalName(bound, nameIndex)).toBe(
      "scoped_by_name",
    );
  });

  it("refuses an undeclared index on a backend derived from a bound one", () => {
    const fixed = createTestBackend();
    const derived = deriveBackend(fixed, {});
    bindRelationalIndexNames(fixed, new Map());

    expect(() => relationalIndexPhysicalName(derived, nameIndex)).toThrow(
      ConfigurationError,
    );
  });

  it("prefers the nearest binding along a derivation chain", () => {
    const inner = createTestBackend();
    const outer = deriveBackend(inner, {});
    bindRelationalIndexNames(inner, new Map());
    bindRelationalIndexNames(
      outer,
      new Map([[relationalIndexIdentity(nameIndex), "outer_by_name"]]),
    );

    expect(relationalIndexPhysicalName(outer, nameIndex)).toBe("outer_by_name");
  });
});
