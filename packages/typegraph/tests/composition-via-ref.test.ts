import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge } from "../src";
import { compositionViaKind } from "../src/registry/composition-relation";

describe("compositionViaKind", () => {
  it("accepts an edge type or a kind string", () => {
    const via = defineEdge("episodeOf", { schema: z.object({}) });
    expect(compositionViaKind(via)).toBe("episodeOf");
    expect(compositionViaKind("episodeOf")).toBe("episodeOf");
  });
});
