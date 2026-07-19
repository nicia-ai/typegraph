import { beforeEach, describe, expect, it, vi } from "vitest";

describe("SQL fragment module identity", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("composes fragments and placeholders across module instances", async () => {
    const first = await import("../src/query/sql-fragment");
    const firstFragment = first.sql`SELECT ${1}`;
    const firstPlaceholder = new first.Placeholder("value");

    vi.resetModules();
    const second = await import("../src/query/sql-fragment");

    expect(second.isSqlFragment(firstFragment)).toBe(true);
    expect(second.isSqlPlaceholder(firstPlaceholder)).toBe(true);
    expect(
      second.renderPostgres(second.sql`${firstFragment}, ${firstPlaceholder}`),
    ).toEqual({
      sql: "SELECT $1, $2",
      params: [1, firstPlaceholder],
    });
  });

  it("shares execution intent state across module instances", async () => {
    const firstFragmentModule = await import("../src/query/sql-fragment");
    const firstIntentModule = await import("../src/query/sql-intent");
    const fragment = firstFragmentModule.sql`SELECT 1`;
    firstIntentModule.markForceCustomPlan(fragment);
    firstIntentModule.markAnnIndexScan(fragment, ["hnsw"]);

    vi.resetModules();
    const secondIntentModule = await import("../src/query/sql-intent");

    expect(secondIntentModule.shouldForceCustomPlan(fragment)).toBe(true);
    expect(secondIntentModule.annIndexScanTypes(fragment)).toEqual(["hnsw"]);
  });
});
