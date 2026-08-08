import { describe, expect, it } from "vitest";

import {
  differentLedgerFingerprint,
  type LedgerAssertion,
} from "../../src/graph-merge/merge-identity";
import { identityAssertionSemanticKey } from "../../src/identity/assertion-key";

const INSTANT = "2026-01-01T00:00:00.000Z";

function different(id: string, aKind: string, aId = "left"): LedgerAssertion {
  return {
    id,
    relation: "different",
    a: { kind: aKind, id: aId },
    b: { kind: "Z", id: "right" },
    validFrom: INSTANT,
  };
}

describe("identity assertion keys", () => {
  it("sorts shifted-NUL ledger tuples independently of backend row order", () => {
    const first = different("assertion\0Person", "Kind");
    const second = different("assertion", "Person\0Kind");

    expect(differentLedgerFingerprint([first, second])).toBe(
      differentLedgerFingerprint([second, first]),
    );
  });

  it("keeps shifted delimiters distinct in the shared semantic-key owner", () => {
    expect(
      identityAssertionSemanticKey(
        "same",
        { kind: "A\0B", id: "C" },
        {
          kind: "D",
          id: "E",
        },
      ),
    ).not.toBe(
      identityAssertionSemanticKey(
        "same",
        { kind: "A", id: "B\0C" },
        {
          kind: "D",
          id: "E",
        },
      ),
    );
  });
});
