import { execFileSync } from "node:child_process";

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
    firstIntentModule.markRecursivePlan(fragment);

    vi.resetModules();
    const secondIntentModule = await import("../src/query/sql-intent");

    expect(secondIntentModule.shouldForceCustomPlan(fragment)).toBe(true);
    expect(secondIntentModule.annIndexScanTypes(fragment)).toEqual(["hnsw"]);
    expect(secondIntentModule.recursivePlanCount(fragment)).toBe(1);
  });

  it("adds recursive metadata when an older package initialized the registry", () => {
    const fragmentModule = new URL(
      "../src/query/sql-fragment.ts",
      import.meta.url,
    );
    const intentModule = new URL("../src/query/sql-intent.ts", import.meta.url);
    const script = `
      globalThis[Symbol.for("@nicia-ai/typegraph/sql-intent-registry")] = {
        annIndexScanQueries: new WeakMap(),
        forceCustomPlanQueries: new WeakSet(),
      };
      const { sql } = await import(${JSON.stringify(fragmentModule.href)});
      const { markRecursivePlan, recursivePlanCount } = await import(${JSON.stringify(intentModule.href)});
      const recursive = sql.raw("SELECT 1");
      markRecursivePlan(recursive);
      const composed = sql.join([recursive, recursive], sql.raw(" UNION ALL "));
      process.stdout.write(String(recursivePlanCount(composed)));
    `;
    expect(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { encoding: "utf8" },
      ),
    ).toBe("2");
  });
});
