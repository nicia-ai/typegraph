/**
 * The `baseUnique` candidate source probes the committed base with a staged
 * node's STORED props, which hold a `z.date()` value as its ISO text.
 *
 * `bulkFindByConstraint` validates its items as create input, so the staged
 * text is refused by `z.date()` and the lookup fails before the merge, even
 * though the base node holds the same date. The commit-time stability check
 * (`collectBaseMatchKeys`) passes staged props to the same lookup. The same on
 * main; pinned here, not repaired: the key owner keys stored props as it keys
 * a parse output, but the lookup validates its items as create input first,
 * and skipping that needs a lookup that takes stored props, which no
 * collection member does today.
 */
import type { GraphBackend, Node, NodeType } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, it } from "vitest";
import { z } from "zod";

import type {
  BaseLookupStore,
  SourceScope,
} from "../../src/graph-merge/sources";
import { baseUniqueSource } from "../../src/graph-merge/sources";
import { expectObservation } from "../helpers/known-defect";
import { backendMatrix } from "./test-utils";

const Visit = defineNode("Visit", {
  schema: z.object({ name: z.string(), at: z.date() }),
});

const visitGraph = defineGraph({
  id: "base-unique-stored-date",
  nodes: {
    Visit: {
      type: Visit,
      unique: [
        {
          name: "visit_at",
          fields: ["at"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

const AT = new Date("2024-01-01T00:00:00.000Z");

describe.each(backendMatrix())(
  "baseUnique source over a stored date [$name]",
  (entry) => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    it("matches a staged node holding a base node's date as stored text", async () => {
      const [base] = await createStoreWithSchema(
        visitGraph,
        await makeBackend(),
      );
      await base.nodes.Visit.create({ name: "base", at: AT }, { id: "base" });
      const uniqueConstraints =
        base.introspect().kinds.find((kind) => kind.name === "Visit")?.unique ??
        [];
      // A staged row as storage hands it back: the date as its ISO text.
      const staged = {
        kind: "Visit",
        id: "staged",
        name: "staged",
        at: AT.toISOString(),
      } as unknown as Node<NodeType>;
      const scope: SourceScope = {
        kind: "Visit",
        blocks: new Map(),
        nodes: [staged],
        uniqueConstraints,
        store: base as unknown as BaseLookupStore,
      };

      let observed: string;
      try {
        const produced = await baseUniqueSource.generate(scope);
        observed = `forced:${produced.forcedEdges.length}`;
      } catch (error) {
        observed = error instanceof Error ? error.name : String(error);
      }

      expectObservation({
        lane: { backend: entry.name },
        observed,
        correct: "forced:1",
        defects: [
          {
            label: "merge base-unique probe validates stored props as input",
            on: {},
            today: "CandidateSourceError",
          },
        ],
      });
    });
  },
);
