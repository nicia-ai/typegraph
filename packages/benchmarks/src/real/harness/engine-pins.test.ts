import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  isExactNpmVersion,
  isPinnedImageReference,
  PINNED_NEO4J_GDS_PLUGIN,
  PINNED_NEO4J_IMAGE,
  PINNED_PGGRAPH_IMAGE,
  PINNED_POSTGRES_IMAGE,
} from "./engine-pins";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("isPinnedImageReference", () => {
  it("accepts an explicit release tag plus a digest", () => {
    assert.equal(isPinnedImageReference(`neo4j:2026.10.2@${DIGEST}`), true);
    assert.equal(
      isPinnedImageReference(`ghcr.io/owner/image:1.2.1@${DIGEST}`),
      true,
    );
  });

  it("rejects a floating tag, a bare tag, or a bare digest", () => {
    assert.equal(isPinnedImageReference(`neo4j:latest@${DIGEST}`), false);
    assert.equal(isPinnedImageReference("neo4j:2026.10.2"), false);
    assert.equal(isPinnedImageReference(`neo4j@${DIGEST}`), false);
    assert.equal(isPinnedImageReference("neo4j"), false);
  });
});

describe("the lane's pins", () => {
  it("pins every container image by release tag and digest", () => {
    for (const image of [
      PINNED_POSTGRES_IMAGE,
      PINNED_NEO4J_IMAGE,
      PINNED_PGGRAPH_IMAGE,
    ]) {
      assert.equal(isPinnedImageReference(image), true, image);
    }
  });

  it("pins Graph Data Science to the Neo4j release it is built for", () => {
    const neo4jTag = /^neo4j:([^@]+)@/.exec(PINNED_NEO4J_IMAGE)?.[1];
    assert.equal(PINNED_NEO4J_GDS_PLUGIN.version, neo4jTag);
    assert.match(PINNED_NEO4J_GDS_PLUGIN.sha256, /^[0-9a-f]{64}$/);
    assert.ok(
      PINNED_NEO4J_GDS_PLUGIN.url.endsWith(
        `/${PINNED_NEO4J_GDS_PLUGIN.version}/${PINNED_NEO4J_GDS_PLUGIN.fileName}`,
      ),
    );
  });

  it("pins the competitor npm packages exactly", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const name of ["@ladybugdb/core", "neo4j-driver"]) {
      const specifier = manifest.dependencies[name];
      assert.ok(specifier !== undefined, `${name} is a dependency`);
      assert.equal(isExactNpmVersion(specifier), true, `${name}@${specifier}`);
    }
  });
});

describe("isExactNpmVersion", () => {
  it("accepts only a plain x.y.z release", () => {
    assert.equal(isExactNpmVersion("0.22.3"), true);
    assert.equal(isExactNpmVersion("^0.22.3"), false);
    assert.equal(isExactNpmVersion("~6.3.2"), false);
    assert.equal(isExactNpmVersion("latest"), false);
    assert.equal(isExactNpmVersion("workspace:*"), false);
  });
});
