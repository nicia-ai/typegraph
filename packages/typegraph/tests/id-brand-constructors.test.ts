import { describe, expect, it } from "vitest";

import { asEdgeId, asNodeId, ValidationError } from "../src";

describe("id brand constructors", () => {
  it("brands non-empty node and edge ids without changing the runtime value", () => {
    expect(asNodeId("person-1")).toBe("person-1");
    expect(asEdgeId("edge-1")).toBe("edge-1");
  });

  it("rejects empty ids at the brand boundary", () => {
    expect(() => asNodeId("")).toThrow(ValidationError);
    expect(() => asEdgeId("")).toThrow(ValidationError);
    expect(() => asNodeId("")).toThrow("asNodeId must be a non-empty string.");
    expect(() => asEdgeId("")).toThrow("asEdgeId must be a non-empty string.");
  });
});
