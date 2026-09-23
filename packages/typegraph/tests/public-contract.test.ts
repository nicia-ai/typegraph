import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compositionViaKind,
  DEFAULT_ALIAS_EXPANSION_AXIS,
  defineEdge,
  PROBE_VIOLATION_FAMILIES,
  probeCoversViolationFamily,
  SEARCH_EXPANSION_DEFAULT,
} from "../src";

describe("public contract seams", () => {
  it("search and query expansion defaults are different constants", () => {
    expect(SEARCH_EXPANSION_DEFAULT).toBe("exact");
    expect(DEFAULT_ALIAS_EXPANSION_AXIS).toBe("subclasses");
    expect(SEARCH_EXPANSION_DEFAULT).not.toBe(DEFAULT_ALIAS_EXPANSION_AXIS);
  });

  it("compositionViaKind accepts an edge type or a kind string", () => {
    const via = defineEdge("episodeOf", { schema: z.object({}) });
    expect(compositionViaKind(via)).toBe("episodeOf");
    expect(compositionViaKind("episodeOf")).toBe("episodeOf");
  });

  it("every probe kind names the violation families a fence row uses", () => {
    const probe = {
      families: PROBE_VIOLATION_FAMILIES.composition,
    };
    expect(probe.families).toEqual(["composition", "edgeAcyclicity"]);
    expect(probeCoversViolationFamily(probe, "composition")).toBe(true);
    expect(probeCoversViolationFamily(probe, "edgeAcyclicity")).toBe(true);
    expect(probeCoversViolationFamily(probe, "compositionExistence")).toBe(
      false,
    );
    expect(PROBE_VIOLATION_FAMILIES.compositionExistence).toEqual([
      "compositionExistence",
    ]);
    expect(PROBE_VIOLATION_FAMILIES.nodeUniqueness).toEqual(["nodeUniqueness"]);
    expect(
      (
        Object.values(PROBE_VIOLATION_FAMILIES).flat() as readonly string[]
      ).includes("edgeCardinality"),
    ).toBe(false);
  });
});
