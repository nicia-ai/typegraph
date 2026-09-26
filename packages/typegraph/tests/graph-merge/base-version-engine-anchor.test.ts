/** Regression coverage for retiring unsafe engine-wide base anchors. */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../../src/backend/derive-backend";
import type { EngineRevision } from "../../src/backend/types";
import {
  computeBaseVersion,
  contentOriginOf,
  engineAnchorOf,
  hasRevisionAnchor,
} from "../../src/graph-merge/base-version";
import { branch } from "../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { merge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBaseVersion, asBranchId } from "../../src/graph-merge/types";
import { createSqliteMergeBackend, fakeEmbedder } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "retired-engine-anchor",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
const BRANCH_ID = asBranchId("retired-engine-anchor-branch");

describe("untracked store base fences", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  function makeBackend() {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return deriveBackend(fixture.backend, {
      lineage: {
        revision: () => Promise.resolve("r0" as EngineRevision),
        changesSince: () =>
          Promise.resolve({ kind: "keys" as const, nodes: [], edges: [] }),
      },
    });
  }

  it("fingerprints identity-only writes despite an empty engine lineage delta", async () => {
    const [store] = await createStoreWithSchema(graph, makeBackend());
    const first = await store.nodes.Person.create({ name: "First" });
    const second = await store.nodes.Person.create({ name: "Second" });
    const before = await computeBaseVersion(store);

    await store.identity.assertSame(
      { kind: "Person", id: first.id },
      { kind: "Person", id: second.id },
    );
    const after = await computeBaseVersion(store);

    expect(hasRevisionAnchor(before)).toBe(false);
    expect(engineAnchorOf(before)).toBeUndefined();
    expect(contentOriginOf(before)).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("rotates the fingerprint's origin across clear", async () => {
    const [store] = await createStoreWithSchema(graph, makeBackend());
    const before = await computeBaseVersion(store);

    await store.clear();
    const after = await computeBaseVersion(store);

    expect(contentOriginOf(after)).not.toBe(contentOriginOf(before));
    expect(after).not.toBe(before);
  });

  it("refuses an identity-only target write made after planning began", async () => {
    const [target] = await createStoreWithSchema(graph, makeBackend());
    const first = await target.nodes.Person.create({ name: "First" });
    const second = await target.nodes.Person.create({ name: "Second" });
    const fork = unwrap(
      await branch(target, () => Promise.resolve(makeBackend()), {
        id: BRANCH_ID,
      }),
    );
    await fork.store.nodes.Person.create({ name: "Branch" });
    let changed = false;
    const result = await merge(target, [fork], {
      branchOrder: [BRANCH_ID],
      resolve: {
        Person: {
          block: () => "all",
          similarity: { kind: "hybrid", fields: ["name"] },
          threshold: 0.95,
        },
      },
      embedder: async (texts) => {
        if (!changed) {
          changed = true;
          await target.identity.assertSame(
            { kind: "Person", id: first.id },
            { kind: "Person", id: second.id },
          );
        }
        return fakeEmbedder(texts);
      },
      onPropertyConflict: "flag",
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    await fork.close();
  });

  it("refuses a previously minted engine anchor", async () => {
    const [target] = await createStoreWithSchema(graph, makeBackend());
    const fork = unwrap(
      await branch(target, () => Promise.resolve(makeBackend()), {
        id: BRANCH_ID,
      }),
    );
    const retired = {
      ...fork,
      base: asBaseVersion("schema#s1|engine:origin:r0"),
    };

    const result = await merge(target, [retired], {
      branchOrder: [BRANCH_ID],
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    await fork.close();
  });

  it("keeps TypeGraph's tracked revision anchor", async () => {
    const [store] = await createStoreWithSchema(graph, makeBackend(), {
      revisionTracking: true,
    });
    expect(hasRevisionAnchor(await computeBaseVersion(store))).toBe(true);
  });
});
