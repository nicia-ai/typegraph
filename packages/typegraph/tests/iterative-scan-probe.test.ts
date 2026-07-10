/**
 * The pgvector iterative-scan probe is owned by the top-level backend and
 * shared with every transaction backend, so a pre-0.8 server is probed once
 * and warned about once per backend instance — not once per
 * `store.transaction()`.
 *
 * These drive the factory directly with a fake `execAll`, standing in for the
 * many transaction backends that reuse one probe: the same probe is asked
 * repeatedly, each time with a fresh `execAll` (as a fresh transaction backend
 * would supply), and the version query must run once and the warning fire once.
 */
import { type SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createIterativeScanProbe } from "../src/backend/drizzle/postgres";

/**
 * A fake `execAll` that reports one pgvector `extversion`, counting its calls.
 * `undefined` models the extension being absent (the query returns no rows).
 */
function fakeExecAll(version: string | undefined): {
  execAll: <T>(query: SQL) => Promise<readonly T[]>;
  calls: () => number;
} {
  let calls = 0;
  return {
    execAll: <T>(): Promise<readonly T[]> => {
      calls += 1;
      const rows = version === undefined ? [] : [{ v: version }];
      return Promise.resolve(rows as unknown as readonly T[]);
    },
    calls: () => calls,
  };
}

/** An `execAll` that always fails — models a lost connection during the probe. */
function failingExecAll<T>(): Promise<readonly T[]> {
  return Promise.reject(new Error("connection lost"));
}

const ANY_SQL = undefined as unknown as SQL;

describe("createIterativeScanProbe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes the version once and caches it across many isSupported calls", async () => {
    const probe = createIterativeScanProbe();
    const source = fakeExecAll("0.8.0");

    // Five transaction backends, each with its own execAll, all sharing this
    // probe. The extversion query must run exactly once.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => probe.isSupported(source.execAll)),
    );

    expect(results).toEqual([true, true, true, true, true]);
    expect(source.calls()).toBe(1);
  });

  it("warns at most once for a pre-0.8 server, across transactions", async () => {
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const probe = createIterativeScanProbe();

    // Each call models a distinct transaction backend reusing the shared probe.
    for (let transaction = 0; transaction < 4; transaction += 1) {
      const source = fakeExecAll("0.7.4");
      expect(await probe.isSupported(source.execAll)).toBe(false);
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("0.7.4");
    expect(warn.mock.calls[0]?.[0]).toContain("iterative scan");
  });

  it("never warns on a supported server", async () => {
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const probe = createIterativeScanProbe();
    const source = fakeExecAll("0.8.1");

    expect(await probe.isSupported(source.execAll)).toBe(true);
    expect(await probe.isSupported(source.execAll)).toBe(true);

    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a missing pgvector extension as unsupported, without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const probe = createIterativeScanProbe();
    const source = fakeExecAll(undefined);

    expect(await probe.isSupported(source.execAll)).toBe(false);
    // Absent extension is not a pre-0.8 server; the "upgrade pgvector" warning
    // would be misleading, so it must stay silent.
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a probe failure as unsupported and does not cache it as a warning", async () => {
    const probe = createIterativeScanProbe();
    await expect(probe.isSupported(failingExecAll)).resolves.toBe(false);
  });

  it("is callable with the ANY_SQL placeholder without inspecting the query", async () => {
    const probe = createIterativeScanProbe();
    const source = fakeExecAll("0.8.0");
    expect(await probe.isSupported(() => source.execAll(ANY_SQL))).toBe(true);
  });
});
