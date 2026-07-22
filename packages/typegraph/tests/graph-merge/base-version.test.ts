import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { computeContentComponent } from "../../src/graph-merge/base-version";
import { canonicalizeProps } from "../../src/graph-merge/canonical-props";
import type { IdentityTransferAssertion } from "../../src/graph-merge/typegraph-internal";
import { sha256Hex } from "../../src/utils/hash";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "base-version-identity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * Retained bytes of the SHA-256 content fingerprint, pinned to the production
 * `CONTENT_FINGERPRINT_BYTES` (base-version.ts). Hardcoded so the digest below is a
 * genuine byte-for-byte regression pin rather than a re-derivation.
 */
const CONTENT_FINGERPRINT_BYTES = 16;

describe.each(backendMatrix())("base@V content component [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  it("omits the identity key for an empty assertion list, preserving the pre-identity token (#3)", async () => {
    const backend = await makeBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const token = await computeContentComponent(
      backend,
      store.graphId,
      store.graph,
      [],
    );

    // A store that carries identity config but has zero live assertions must
    // fingerprint identically to the pre-identity shape: the canonicalized digest
    // object has NO `identity` key at all.
    const preIdentityToken = await sha256Hex(
      canonicalizeProps({ nodes: [], edges: [] }),
      CONTENT_FINGERPRINT_BYTES,
    );
    expect(token).toBe(preIdentityToken);
  });

  it("changes the token when the identity assertion list is non-empty (#3)", async () => {
    const backend = await makeBackend();
    const [store] = await createStoreWithSchema(graph, backend);

    const empty = await computeContentComponent(
      backend,
      store.graphId,
      store.graph,
      [],
    );
    const assertion: IdentityTransferAssertion = {
      id: "assertion-1",
      relation: "same",
      a: { kind: "Person", id: "x" },
      b: { kind: "Person", id: "y" },
      validFrom: "2024-01-01T00:00:00.000Z",
    };
    const withAssertion = await computeContentComponent(
      backend,
      store.graphId,
      store.graph,
      [assertion],
    );

    expect(withAssertion).not.toBe(empty);
  });
});
