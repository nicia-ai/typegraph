/**
 * "One whole per part" on the paths where no claim row decides it.
 *
 * The composition invariant spans every realizing edge kind, so a probe that
 * counted only the edge kind being written would let a part attach to a
 * second whole through a different kind. These cases drive the two backend
 * shapes that reach the portable probe — a custom command port answering
 * `unsupported`, and a backend that declares no claim relation at all — and
 * hold them to the refusal a first-party backend's claim row raises.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import {
  type GraphBackend,
  type GraphCommand,
  type GraphCommandResult,
  type TransactionBackend,
} from "../src/backend/types";
import { createTestBackend } from "./test-utils";

const WholeA = defineNode("WholeA", { schema: z.object({}) });
const WholeB = defineNode("WholeB", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const inWholeA = defineEdge("inWholeA", { schema: z.object({}) });
const inWholeB = defineEdge("inWholeB", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition_portable_probe",
  nodes: {
    WholeA: { type: WholeA },
    WholeB: { type: WholeB },
    Part: { type: Part },
  },
  edges: {
    inWholeA: {
      type: inWholeA,
      from: [Part],
      to: [WholeA],
      cardinality: "one",
    },
    inWholeB: {
      type: inWholeB,
      from: [Part],
      to: [WholeB],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Part, WholeA, { via: inWholeA }),
    partOf(Part, WholeB, { via: inWholeB }),
  ],
});

const CLAIM_MEMBERS = [
  "claimEdgeCardinality",
  "claimEdgeCardinalityGuarded",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "hardDeleteUniquesByConcreteKind",
] as const;

type ClaimMembers = Readonly<
  Partial<Record<(typeof CLAIM_MEMBERS)[number], unknown>>
>;

function stripClaimMembers<T extends object>(target: T): T {
  return projectBackendWithout(target as T & ClaimMembers, [
    ...CLAIM_MEMBERS,
  ]) as T;
}

/** A transactional backend that declares no claim relation at all. */
function withoutClaimSupport(backend: GraphBackend): GraphBackend {
  return deriveBackend(stripClaimMembers(backend), {
    capabilities: { ...backend.capabilities, constraintClaims: false },
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(stripClaimMembers(target), {
              capabilities: {
                ...target.capabilities,
                constraintClaims: false,
              },
            }),
          ),
        options,
      ),
  });
}

function unsupportedFor(command: GraphCommand): GraphCommandResult {
  switch (command.kind) {
    case "node.create": {
      return {
        outcome: "unsupported",
        entity: "node",
        dimensions: ["claims"],
      };
    }
    case "edge.create": {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["cardinalityClaim", "endpointPredicate"],
      };
    }
    case "edge.converge-create": {
      return {
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["convergence", "endpointPredicate"],
      };
    }
  }
}

/** A custom command port that answers `unsupported` to every command. */
function withUnsupportedCommands(backend: GraphBackend): GraphBackend {
  const decorate = (target: TransactionBackend): TransactionBackend =>
    deriveBackend(target, {
      commands: {
        session: target.commands.session,
        execute: (command) => Promise.resolve(unsupportedFor(command)),
      },
    });
  return deriveBackend(backend, {
    transaction: (run, options) =>
      backend.transaction((target) => run(decorate(target)), options),
  });
}

const BACKEND_SHAPES: Readonly<Record<string, () => GraphBackend>> = {
  "first-party": () => createTestBackend(),
  "custom port answering unsupported": () =>
    withUnsupportedCommands(createTestBackend()),
  "no claim relation": () => withoutClaimSupport(createTestBackend()),
  "no claim relation, port answering unsupported": () =>
    withUnsupportedCommands(withoutClaimSupport(createTestBackend())),
};

async function attachedPart(createBackend: () => GraphBackend) {
  const [store] = await createStoreWithSchema(graph, createBackend());
  const wholeA = await store.nodes.WholeA.create({});
  const wholeB = await store.nodes.WholeB.create({});
  const part = await store.nodes.Part.create({});
  const incumbent = await store.edges.inWholeA.create(part, wholeA, {});
  return { store, wholeA, wholeB, part, incumbent };
}

const ACCEPTED = "accepted";

function refusalOf(operation: () => Promise<unknown>): Promise<unknown> {
  return operation().then(
    () => ACCEPTED,
    (error: unknown) => error,
  );
}

describe.each(Object.entries(BACKEND_SHAPES))(
  "one whole per part on a %s backend",
  (_shape, createBackend) => {
    it("refuses a second whole through a different realizing edge kind, naming the incumbent edge", async () => {
      const { store, wholeB, part, incumbent } =
        await attachedPart(createBackend);

      const refusal = await refusalOf(() =>
        store.edges.inWholeB.create(part, wholeB, {}),
      );

      expect(refusal).toBeInstanceOf(CompositionError);
      expect((refusal as CompositionError).details).toMatchObject({
        partKind: "Part",
        partId: part.id,
        wholeKind: "WholeB",
        wholeId: wholeB.id,
        edgeKind: "inWholeB",
        incumbentEdgeId: incumbent.id,
      });
    });

    it("writes nothing for the refused attach, including when the refusal is caught inside a transaction", async () => {
      const { store, wholeB, part } = await attachedPart(createBackend);
      const second = { from: part, to: wholeB, props: {} };

      const refusals: unknown[] = [];
      await store.transaction(async (tx) => {
        for (const attempt of [
          () => tx.edges.inWholeB.create(part, wholeB, {}),
          () => tx.edges.inWholeB.bulkCreate([second]),
          () => tx.edges.inWholeB.bulkInsert([second]),
          () => tx.edges.inWholeB.getOrCreateByEndpoints(part, wholeB, {}),
        ]) {
          refusals.push(await refusalOf(attempt));
        }
      });

      expect(refusals).toHaveLength(4);
      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(CompositionError);
      }
      expect(await store.edges.inWholeB.find({})).toEqual([]);
      expect(await store.edges.inWholeA.find({})).toHaveLength(1);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses resurrecting an attachment after the part took another whole", async () => {
      const { store, wholeB, part, incumbent } =
        await attachedPart(createBackend);
      await store.edges.inWholeA.delete(incumbent.id);
      const replacement = await store.edges.inWholeB.create(part, wholeB, {});

      const refusal = await refusalOf(() =>
        store.edges.inWholeA.bulkUpsertById([
          {
            id: incumbent.id,
            from: part,
            to: { kind: "WholeA", id: incumbent.toId },
            props: {},
          },
        ]),
      );

      expect(refusal).toBeInstanceOf(CompositionError);
      expect((refusal as CompositionError).details.incumbentEdgeId).toBe(
        replacement.id,
      );
      expect(await store.edges.inWholeA.find({})).toEqual([]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("still attaches a part that has no whole", async () => {
      const [store] = await createStoreWithSchema(graph, createBackend());
      const wholeB = await store.nodes.WholeB.create({});
      const part = await store.nodes.Part.create({});

      await store.edges.inWholeB.create(part, wholeB, {});

      expect(await store.edges.inWholeB.find({})).toHaveLength(1);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });
  },
);
