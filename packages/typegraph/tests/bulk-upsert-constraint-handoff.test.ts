/**
 * The bulk-upsert BATCH-ORDER limitation (issue #411).
 *
 * `bulkUpsertById` groups every create ahead of every update, so a batch that
 * hands a constrained value from one row to another — the earlier item frees it,
 * a later item claims it — is refused even though the same operations applied as
 * sequential `upsertById` calls succeed. Bulk semantics are set-like, not
 * scripted: a batch states the rows it wants, not an order to reach them in.
 *
 * These cases pin the limitation as CONTRACTUAL rather than accidental. Each
 * asserts both halves — the batch throws the typed error, and the identical
 * sequence of single upserts succeeds — because only the pair distinguishes an
 * ordering limitation from a constraint that simply cannot be satisfied. They
 * therefore pass against the pre-#411 tree too; the change #411 landed is the
 * documented contract in `store/types.ts` and the data-sync guide.
 *
 * Both constrained shapes a batch can hand off are covered:
 *   - nodes: a `unique` constraint value ({@link UniquenessError});
 *   - edges: the lone active edge a `oneActive` cardinality allows
 *     ({@link CardinalityError}).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend } from "../src";
import {
  asEdgeId,
  asNodeId,
  CardinalityError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  UniquenessError,
} from "../src";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const SHARED_EMAIL = "shared@example.com";
const MOVED_EMAIL = "moved@example.com";
const JOB_STARTED_AT = "2025-01-01T00:00:00.000Z";
const JOB_ENDED_AT = "2026-01-01T00:00:00.000Z";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
/** One LIVE job per person, so freeing the slot is a prerequisite for a new one. */
const oneActiveJob = defineEdge("oneActiveJob", {
  schema: z.object({ role: z.string() }),
  from: [Person],
  to: [Company],
});

const graph = defineGraph({
  id: "bulk-upsert-handoff",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Company: { type: Company },
  },
  edges: {
    oneActiveJob: {
      type: oneActiveJob,
      from: [Person],
      to: [Company],
      cardinality: "oneActive",
    },
  },
});

describe("bulkUpsertById constraint handoff within one batch", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("refuses a node batch that moves a unique value from one row to another", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.upsertById("holder", {
      name: "holder",
      email: SHARED_EMAIL,
    });

    // `holder` releases SHARED_EMAIL and `claimant` takes it. Creates run
    // first, so the create of `claimant` is checked while `holder` still
    // reserves the value.
    const rejection = await store.nodes.Person.bulkUpsertById([
      { id: "holder", props: { name: "holder", email: MOVED_EMAIL } },
      { id: "claimant", props: { name: "claimant", email: SHARED_EMAIL } },
    ]).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(UniquenessError);
    expect((rejection as UniquenessError).details).toMatchObject({
      kind: "Person",
      constraintName: "person_email",
    });
    // The refused batch left the graph untouched.
    const holderAfterRejection = requireDefined(
      await store.nodes.Person.getById(asNodeId<typeof Person>("holder")),
    );
    expect(holderAfterRejection.email).toBe(SHARED_EMAIL);
    expect(
      await store.nodes.Person.getById(asNodeId<typeof Person>("claimant")),
    ).toBeUndefined();

    // The same two writes, applied in the stated order, succeed: the
    // limitation is the batch's ordering, not the constraint.
    await store.nodes.Person.upsertById("holder", {
      name: "holder",
      email: MOVED_EMAIL,
    });
    await store.nodes.Person.upsertById("claimant", {
      name: "claimant",
      email: SHARED_EMAIL,
    });
    const claimant = requireDefined(
      await store.nodes.Person.getById(asNodeId<typeof Person>("claimant")),
    );
    expect(claimant.email).toBe(SHARED_EMAIL);
  });

  it("refuses an edge batch that ends the one active edge a new edge needs", async () => {
    const store = createStore(graph, backend);
    const person = await store.nodes.Person.create({
      name: "worker",
      email: "worker@example.com",
    });
    const previousEmployer = await store.nodes.Company.create({
      name: "previous",
    });
    const nextEmployer = await store.nodes.Company.create({ name: "next" });
    const currentJob = await store.edges.oneActiveJob.create(
      { kind: "Person", id: person.id },
      { kind: "Company", id: previousEmployer.id },
      { role: "old" },
      { validFrom: JOB_STARTED_AT },
    );

    const endCurrentJob = {
      id: currentJob.id,
      from: { kind: "Person", id: person.id } as const,
      to: { kind: "Company", id: previousEmployer.id } as const,
      props: { role: "old" },
      validTo: JOB_ENDED_AT,
    };
    const startNextJob = {
      id: asEdgeId<typeof oneActiveJob>("next-job"),
      from: { kind: "Person", id: person.id } as const,
      to: { kind: "Company", id: nextEmployer.id } as const,
      props: { role: "new" },
    };

    // Ending the current job frees the person's single active-job slot, but
    // the create of the next job is checked before that update runs.
    const rejection = await store.edges.oneActiveJob
      .bulkUpsertById([endCurrentJob, startNextJob])
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CardinalityError);
    expect((rejection as CardinalityError).details).toMatchObject({
      edgeKind: "oneActiveJob",
      cardinality: "oneActive",
    });
    // The refused batch left the graph untouched.
    expect(await store.edges.oneActiveJob.count()).toBe(1);
    expect(
      await store.edges.oneActiveJob.getById(startNextJob.id),
    ).toBeUndefined();

    // Applied in the stated order the same handoff succeeds. Edges have no
    // single-item upsert, so the sequential equivalent is the update the first
    // item would perform followed by the create the second one would.
    await store.edges.oneActiveJob.update(
      endCurrentJob.id,
      endCurrentJob.props,
      { validTo: endCurrentJob.validTo },
    );
    await store.edges.oneActiveJob.create(
      startNextJob.from,
      startNextJob.to,
      startNextJob.props,
      { id: startNextJob.id },
    );
    const nextJob = requireDefined(
      await store.edges.oneActiveJob.getById(startNextJob.id),
    );
    expect(nextJob.role).toBe("new");
  });

  it("accepts the same handoff split across two batches", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.upsertById("holder", {
      name: "holder",
      email: SHARED_EMAIL,
    });

    // The documented workaround: release in one batch, claim in the next.
    await store.nodes.Person.bulkUpsertById([
      { id: "holder", props: { name: "holder", email: MOVED_EMAIL } },
    ]);
    await store.nodes.Person.bulkUpsertById([
      { id: "claimant", props: { name: "claimant", email: SHARED_EMAIL } },
    ]);

    const holder = requireDefined(
      await store.nodes.Person.getById(asNodeId<typeof Person>("holder")),
    );
    const claimant = requireDefined(
      await store.nodes.Person.getById(asNodeId<typeof Person>("claimant")),
    );
    expect(holder.email).toBe(MOVED_EMAIL);
    expect(claimant.email).toBe(SHARED_EMAIL);
  });
});
