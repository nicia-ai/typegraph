import { describe, expect, it } from "vitest";

import { DEFAULT_ALIAS_EXPANSION_AXIS, SEARCH_EXPANSION_DEFAULT } from "../src";

describe("public contract seams", () => {
  it("search and query expansion defaults are different constants", () => {
    expect(SEARCH_EXPANSION_DEFAULT).toBe("exact");
    expect(DEFAULT_ALIAS_EXPANSION_AXIS).toBe("subclasses");
    expect(SEARCH_EXPANSION_DEFAULT).not.toBe(DEFAULT_ALIAS_EXPANSION_AXIS);
  });
});
