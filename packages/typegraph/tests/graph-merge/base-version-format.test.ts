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
  contentComponentOf,
  schemaComponentOf,
} from "../../src/graph-merge/base-version";
import { branch } from "../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { planMerge, planMergeIncremental } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBaseVersion, type BaseVersion } from "../../src/graph-merge/types";
import { backendMatrix, createSqliteMergeBackend } from "./test-utils";

const Note = defineNode("Note", {
  schema: z.object({ text: z.string() }),
});

const graph = defineGraph({
  id: "base-version-format",
  nodes: { Note: { type: Note } },
  edges: {},
});

// eslint-disable-next-line no-control-regex -- the assertion is about control characters
const CONTROL_CHARACTER = /[\u0000-\u001F]/;

function legacyFormOf(token: BaseVersion): BaseVersion {
  return asBaseVersion((token as string).replace("|", "\u0000"));
}

describe.each(backendMatrix())("base@V token format [$name]", (entry) => {
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

  it.each([
    ["revision-anchored", { history: true } as const],
    ["content-fingerprint", {} as const],
  ])(
    "mints a %s token that a JSON property value can hold",
    async (_form, options) => {
      const [store] = await createStoreWithSchema(
        graph,
        await makeBackend(),
        options,
      );
      await store.nodes.Note.create({ text: "seed" });
      const token = await computeBaseVersion(store);

      expect(token).not.toMatch(CONTROL_CHARACTER);
      // Applications persist descriptors, plans, and fork points. On the
      // PostgreSQL family a property value is jsonb, which rejects NUL.
      const stored = await store.nodes.Note.create({ text: token });
      expect((await store.nodes.Note.getById(stored.id))?.text).toBe(token);
    },
  );
});

describe("base@V tokens minted in the retired NUL-separated format", () => {
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

  it("parse as having no components, so no anchor is read out of them", async () => {
    const [store] = await createStoreWithSchema(graph, makeBackend(), {
      revisionTracking: true,
    });
    const legacy = legacyFormOf(await computeBaseVersion(store));

    expect(schemaComponentOf(legacy)).toBe("");
    expect(contentComponentOf(legacy)).toBe(legacy);
  });

  it("fail a plan for a branch whose persisted base is legacy with a typed mismatch", async () => {
    const [target] = await createStoreWithSchema(graph, makeBackend(), {
      revisionTracking: true,
    });
    await target.nodes.Note.create({ text: "before the fork" });
    const fork = unwrap(
      await branch(target, () => Promise.resolve(makeBackend())),
    );

    const planned = await planMerge(target, [
      { ...fork, base: legacyFormOf(fork.base) },
    ]);

    expect(isErr(planned)).toBe(true);
    const error = isErr(planned) ? planned.error : undefined;
    expect(error).toBeInstanceOf(BaseVersionMismatchError);
    expect(error).toMatchObject({
      details: { reason: "legacy-token-format" },
    });
    await fork.close();
  });

  it("refuse a persisted recorded fork point before reading an anchor out of it", async () => {
    const [target] = await createStoreWithSchema(graph, makeBackend(), {
      history: true,
    });
    await target.nodes.Note.create({ text: "before the fork" });
    const recorded = await target.recordedNow();
    if (recorded === undefined) throw new Error("history was not captured");
    const fork = unwrap(
      await branch(target, () => Promise.resolve(makeBackend())),
    );

    const planned = await planMergeIncremental({
      forkPoint: { recorded, base: legacyFormOf(fork.base) },
      target,
      branches: [fork],
      options: { onBasePropertyConflict: "flag" },
    });

    const error = isErr(planned) ? planned.error : undefined;
    const refusal =
      error instanceof BaseVersionMismatchError ? error : error?.cause;
    expect(refusal).toBeInstanceOf(BaseVersionMismatchError);
    expect(refusal).toMatchObject({
      details: { reason: "legacy-token-format" },
    });
    await fork.close();
  });
});
