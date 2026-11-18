import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assertProperty, formatErrorChain } from "./assert-property";

function driverFailure(): Error {
  return new Error("Failed query: select 1", {
    cause: Object.assign(new Error('relation "x" does not exist'), {
      code: "42P01",
      query: "select 1",
    }),
  });
}

describe("assertProperty", () => {
  it("renders every cause with SQLSTATE and statement", () => {
    const text = formatErrorChain(
      new Error("Merge failed", { cause: driverFailure() }),
    );
    expect(text).toContain("Merge failed");
    expect(text).toContain("Failed query: select 1");
    expect(text).toContain('relation "x" does not exist');
    expect(text).toContain("code=42P01");
    expect(text).toContain("query=select 1");
  });

  it("puts the failing error chain in the thrown message", async () => {
    const failure = assertProperty(
      fc.asyncProperty(fc.integer(), async () => {
        throw new Error("outer", { cause: driverFailure() });
      }),
      { numRuns: 1 },
    );
    await expect(failure).rejects.toThrow(/code=42P01/);
    await expect(failure).rejects.toThrow(/Property failed after 1 tests/);
  });

  it("passes a holding property through", async () => {
    await assertProperty(
      fc.asyncProperty(fc.integer(), (value) => {
        expect(value).toBeTypeOf("number");
        return Promise.resolve();
      }),
      { numRuns: 3 },
    );
  });
});
