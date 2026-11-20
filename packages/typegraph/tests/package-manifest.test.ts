import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const packageManifestSchema = z.object({
  devDependencies: z.record(z.string(), z.string()).optional(),
});

describe("published package manifest", () => {
  it("does not reference the private workspace ESLint config", () => {
    const packageManifest = packageManifestSchema.parse(
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ),
    );

    expect(packageManifest.devDependencies).not.toHaveProperty(
      "@typegraph/eslint-config",
    );
  });
});
