/**
 * Shared check, run on every dialect: on a database whose transition-log
 * relations (base-schema version 9) are missing, every surface that touches
 * them — the two reads, the prune, and the capture flush a write reaches —
 * refuses with the same typed `IDENTITY_TRANSITION_RELATIONS_MISSING`
 * `ConfigurationError`, naming the relations and the adoption that creates
 * them, never a raw driver error for whichever statement happened to run
 * first. Each dialect's suite supplies the backend and the DROP.
 */
import { expect } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  pruneIdentityTransitions,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", { schema: z.object({}) });

const graph = defineGraph({
  id: "identity_transition_relations_missing",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

export const TRANSITION_LOG_RELATIONS = [
  "typegraph_identity_transitions",
  "typegraph_identity_transition_retention",
] as const;

async function refusalOf(read: () => Promise<unknown>): Promise<unknown> {
  try {
    await read();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be refused, but it resolved.");
}

function expectMissingRelations(error: unknown, surface: string): void {
  console.info("missing transition-log relations refusal", {
    surface,
    error,
  });
  expect(error).toBeInstanceOf(ConfigurationError);
  const refusal = error as ConfigurationError;
  expect(refusal.details).toMatchObject({
    code: "IDENTITY_TRANSITION_RELATIONS_MISSING",
    surface,
    relations: [...TRANSITION_LOG_RELATIONS],
  });
  expect(refusal.suggestion).toMatch(/adoptBaseSchema\(\)/);
  expect(refusal.suggestion).toMatch(/version-9 statements/);
}

/**
 * Provisions the graph with history, records one transition, lets
 * `dropTransitionLog` remove both relations, then reattaches with a plain
 * `createStore` (which adopts nothing) and checks every surface.
 */
export async function expectTransitionLogRefusesMissingRelations(
  backend: GraphBackend,
  dropTransitionLog: () => Promise<void>,
): Promise<void> {
  const [seed] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  const a = { kind: "Person" as const, id: "a" };
  const b = { kind: "Person" as const, id: "b" };
  const c = { kind: "Person" as const, id: "c" };
  for (const ref of [a, b, c]) {
    await seed.nodes.Person.create({}, { id: ref.id });
  }
  await seed.identity.assertSame(a, b);
  const cut = requireDefined(await seed.recordedNow());

  await dropTransitionLog();
  const store = createStore(graph, backend, { history: true });

  expectMissingRelations(
    await refusalOf(() => store.identity.transitionsOf(a)),
    "transition-read",
  );
  expectMissingRelations(
    await refusalOf(() => store.identity.replay(a)),
    "transition-read",
  );
  expectMissingRelations(
    await refusalOf(() =>
      pruneIdentityTransitions(store, { beforeRecorded: cut }),
    ),
    "transition-prune",
  );
  expectMissingRelations(
    await refusalOf(() => store.identity.assertSame(b, c)),
    "capture-flush",
  );
  // The refused write left nothing behind.
  expect(await store.identity.areSame(b, c)).toBe(false);
}
