import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStore,
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
import { branch } from "../../src/graph-merge/branch";
import { canonicalizeProps } from "../../src/graph-merge/canonical-props";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { IdentityTransferAssertion } from "../../src/graph-merge/typegraph-internal";
import { sha256Hex } from "../../src/utils/hash";
import { backendMatrix, createSqliteMergeBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "base-version-identity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/** Plain (no identity config) graph for the revision-origin freshness suite below. */
const plainGraph = defineGraph({
  id: "base-version-origin-freshness",
  nodes: { Person: { type: Person } },
  edges: {},
});
type PlainGraph = typeof plainGraph;

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

describe("computeBaseVersion mints the revision origin fresh, never from a per-Store memo", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  function makeBackend(): GraphBackend {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  it("lets a branch minted from a second live Store merge back in after a sibling Store's clear() rotated the shared origin", async () => {
    // TWO live `Store` objects over the SAME backend and graphId — the
    // shape the finding describes: nothing prevents two independent
    // `Store`s from observing one graph, and only one of them ever runs
    // `clear()`.
    const backend = makeBackend();
    const storeB = createStore(plainGraph, backend, { revisionTracking: true });
    const storeA = createStore(plainGraph, backend, { revisionTracking: true });

    await storeB.nodes.Person.create({ name: "Bob" });
    // Mints storeB's revision origin BEFORE storeA's clear(). Pre-fix, this
    // is exactly what populated `storeB`'s now-removed `#revisionOrigin`
    // memo; post-fix it is just an ordinary read with no lingering effect.
    await storeB.revisionOriginNow();

    // storeA clears the SAME graph, rotating the durable origin row every
    // `base@V` anchor for this graph depends on.
    await storeA.clear();
    await storeB.nodes.Person.create({ name: "Bob again" });

    const forkResult = await branch<PlainGraph>(storeB, () =>
      Promise.resolve(makeBackend()),
    );
    expect(isOk(forkResult)).toBe(true);
    const fork = unwrap(forkResult);
    await fork.store.nodes.Person.create({ name: "From fork" });

    const result = await merge<PlainGraph>(storeB, [fork], {});

    // Mutation-proof: reintroducing a per-Store memo around
    // `revisionOriginNow()`'s `ensureRevisionOrigin` call (`store.ts`) makes
    // this assertion fail — `storeB`'s memo, populated before `storeA`'s
    // clear(), keeps answering with the pre-clear origin, `branch()` and
    // `merge()`'s outer precondition both mint an anchor from that SAME
    // stale value (so they still agree with EACH OTHER) and pass, but the
    // commit transaction's `assertTargetUnchanged` reads the origin fresh
    // off the database, finds the ACTUAL rotated value, and refuses —
    // reproducing "every merge into that store fails at commit until it is
    // recreated."
    expect(isOk(result)).toBe(true);
    expect(
      (await storeB.nodes.Person.find()).map((node) => node.name).sort(),
    ).toEqual(["Bob again", "From fork"]);
  });
});
