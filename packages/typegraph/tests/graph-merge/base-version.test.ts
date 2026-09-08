import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  computeBaseVersion,
  computeContentComponent,
  lineageDeltaSinceAnchor,
} from "../../src/graph-merge/base-version";
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

describe.each(backendMatrix())(
  "lineageDeltaSinceAnchor: revision-anchor origin guard [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups) await cleanup();
    });

    async function makeHistoryStore() {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      const [store] = await createStoreWithSchema(graph, fixture.backend, {
        history: true,
      });
      return store;
    }

    it("falls back to undefined against a different physical store sharing the same graphId", async () => {
      const mintingStore = await makeHistoryStore();
      await mintingStore.nodes.Person.create({ name: "Alice" });
      const base = await computeBaseVersion(mintingStore);

      // A SEPARATE physical store sharing the same graphId: a fresh database
      // mints its own random revision-origin nonce (see
      // `recordedRelationsLineage`'s module doc, "Token identity is scoped
      // to one store"), so `base`'s numeric revision is meaningless against
      // this store's clock. The guard must refuse the comparison rather
      // than feed `changesSince` a coincidental match.
      const foreignStore = await makeHistoryStore();
      await foreignStore.nodes.Person.create({ name: "Bob" });

      await expect(
        lineageDeltaSinceAnchor(foreignStore, base),
      ).resolves.toBeUndefined();
    });

    it("resolves the real delta when the token's origin matches the live store", async () => {
      const store = await makeHistoryStore();
      // A write BEFORE minting `base` moves the anchor off the "initial"
      // sentinel (see `revisionAnchorOf`'s doc): a token minted before the
      // store's first tracked write has no real revision number to compare,
      // and `lineageDeltaSinceAnchor` falls back to `undefined` for it
      // regardless of origin — a genesis token, not an origin mismatch.
      await store.nodes.Person.create({ name: "Genesis" });
      const base = await computeBaseVersion(store);
      await store.nodes.Person.create(
        { name: "Alice" },
        { id: "same-origin-check" },
      );

      const delta = await lineageDeltaSinceAnchor(store, base);

      expect(delta?.kind).toBe("keys");
      if (delta?.kind !== "keys") return;
      expect(
        delta.nodes.some(
          (key) => key.kind === "Person" && key.id === "same-origin-check",
        ),
      ).toBe(true);
    });
  },
);
