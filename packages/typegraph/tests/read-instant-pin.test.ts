/**
 * `withPinnedReadInstant` — one "current" instant per compiled statement.
 *
 * A set operation compiles each operand independently, so each would sample
 * its own `nowIso()`. Two samples microseconds apart mean the two halves of an
 * `INTERSECT` or `EXCEPT` disagree about whether a row created between them is
 * current, even though the compound SELECT runs against a single snapshot.
 *
 * The integration coverage lives in `query-builder-read-freshness.test.ts`;
 * that suite cannot *fail* from an unpinned compile, because two `nowIso()`
 * calls inside the same millisecond return the same string. These tests drive
 * the clock forward between samples, so they discriminate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentReadInstant,
  withPinnedReadInstant,
} from "../src/query/compiler/temporal";
import { renderSqlite, type SqlFragment } from "../src/query/sql-fragment";

/** The single bound parameter a `currentReadInstant()` fragment carries. */
function boundInstant(fragment: SqlFragment): unknown {
  return renderSqlite(fragment).params[0];
}

describe("withPinnedReadInstant", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("samples the clock per call when no scope is open", () => {
    const first = boundInstant(currentReadInstant());
    vi.advanceTimersByTime(5);
    const second = boundInstant(currentReadInstant());

    expect(first).toBe("2026-01-01T00:00:00.000Z");
    expect(second).toBe("2026-01-01T00:00:00.005Z");
  });

  it("returns one instant to every call inside the scope, even as the clock advances", () => {
    const instants = withPinnedReadInstant(() => {
      const first = boundInstant(currentReadInstant());
      vi.advanceTimersByTime(5);
      const second = boundInstant(currentReadInstant());
      vi.advanceTimersByTime(5);
      const third = boundInstant(currentReadInstant());
      return [first, second, third];
    });

    expect(new Set(instants).size).toBe(1);
    expect(instants[0]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps the outer instant when scopes nest, as a nested set operation does", () => {
    const [outer, inner] = withPinnedReadInstant(() => {
      const outerInstant = boundInstant(currentReadInstant());
      vi.advanceTimersByTime(5);
      const innerInstant = withPinnedReadInstant(() =>
        boundInstant(currentReadInstant()),
      );
      return [outerInstant, innerInstant];
    });

    expect(inner).toBe(outer);
  });

  it("releases the pin after the scope returns", () => {
    withPinnedReadInstant(() => boundInstant(currentReadInstant()));
    vi.advanceTimersByTime(5);

    expect(boundInstant(currentReadInstant())).toBe("2026-01-01T00:00:00.005Z");
  });

  it("releases the pin when the scope throws", () => {
    expect(() =>
      withPinnedReadInstant(() => {
        throw new Error("compile failed");
      }),
    ).toThrow("compile failed");

    vi.advanceTimersByTime(5);
    const first = boundInstant(currentReadInstant());
    vi.advanceTimersByTime(5);
    const second = boundInstant(currentReadInstant());

    expect(first).not.toBe(second);
  });
});
