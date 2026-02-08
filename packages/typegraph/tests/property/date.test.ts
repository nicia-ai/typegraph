import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decodeDate, encodeDate, isValidIsoDate } from "../../src/utils/date";

// The library currently supports standard 4-digit years in ISO 8601
// So we restrict the generated dates to this range.
const validDateArb = fc
  .date({
    min: new Date("1000-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T23:59:59.999Z"),
  })
  .filter((d) => !Number.isNaN(d.getTime()));

describe("Date Utilities Properties", () => {
  it("round-trips date -> encoded -> decoded", () => {
    fc.assert(
      fc.property(validDateArb, (date) => {
        const encoded = encodeDate(date);
        const decoded = decodeDate(encoded);
        expect(decoded.getTime()).toBe(date.getTime());
      }),
    );
  });

  it("encoded dates are always valid ISO strings", () => {
    fc.assert(
      fc.property(validDateArb, (date) => {
        const encoded = encodeDate(date);
        expect(isValidIsoDate(encoded)).toBe(true);
      }),
    );
  });

  it("sorts correctly as strings (lexicographical order matches chronological order)", () => {
    fc.assert(
      fc.property(validDateArb, validDateArb, (d1, d2) => {
        const s1 = encodeDate(d1);
        const s2 = encodeDate(d2);

        // Compare chronological order with lexicographical order
        const chronologicalOrder = Math.sign(d1.getTime() - d2.getTime());
        const lexicographicalOrder =
          s1 < s2 ? -1
          : s1 > s2 ? 1
          : 0;

        expect(lexicographicalOrder).toBe(chronologicalOrder);
      }),
    );
  });
});
