import { describe, expect, it } from "vitest";

import {
  RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT,
  recordedAnchorAdoptionTimeoutBudget,
} from "../src/backend/recorded-storage";

describe("recorded-clock adoption timeout provenance", () => {
  it("reads a wrapped timeout's session-supplied budget", () => {
    const cause = {
      code: "55P03",
      hint: RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT,
      detail: JSON.stringify({ waitBudgetMs: 50 }),
    };
    expect(
      recordedAnchorAdoptionTimeoutBudget(new Error("query", { cause })),
    ).toBe(50);
  });

  it.each([
    { code: "55P03", detail: '{"waitBudgetMs":50}' },
    { code: "55P03", hint: "unrelated", detail: '{"waitBudgetMs":50}' },
    {
      code: "57014",
      hint: RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT,
      detail: '{"waitBudgetMs":50}',
    },
    {
      code: "55P03",
      hint: RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT,
      detail: "malformed",
    },
    {
      code: "55P03",
      hint: RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT,
      detail: '{"waitBudgetMs":0}',
    },
    {
      code: "55P03",
      hint: RECORDED_ANCHOR_ADOPTION_TIMEOUT_HINT,
      detail: '{"waitBudgetMs":2000}',
    },
  ])("leaves unrelated or invalid driver errors unchanged (%j)", (error) => {
    expect(recordedAnchorAdoptionTimeoutBudget(error)).toBeUndefined();
  });
});
