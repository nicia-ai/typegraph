import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { type IdentityTransferAssertion } from "../src/identity/service";
import { exportGraphStream } from "../src/interchange";
import { renderPostgres } from "../src/query/sql-fragment";
import { storeRuntime } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import {
  createInitializedStore,
  createTestBackend,
  matchingObject,
} from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const Project = defineNode("Project", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "identity_interchange_pagination",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Project: { type: Project },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

type Ref = Readonly<{ kind: "Person" | "Company" | "Project"; id: string }>;

function assertion(id: string, a: Ref, b: Ref): IdentityTransferAssertion {
  return {
    id,
    relation: "same",
    a,
    b,
    validFrom: new Date().toISOString(),
  };
}

describe("Identity interchange pagination", () => {
  it("uses database assertion-id order and the last scanned row as its cursor", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const lateFirst = await store.nodes.Person.create(
      { name: "Late first" },
      { id: "z-first" },
    );
    const lateSecond = await store.nodes.Person.create(
      { name: "Late second" },
      { id: "z-second" },
    );
    const earlyFirst = await store.nodes.Person.create(
      { name: "Early first" },
      { id: "a-first" },
    );
    const earlySecond = await store.nodes.Person.create(
      { name: "Early second" },
      { id: "a-second" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        assertion("assertion-a", lateFirst, lateSecond),
        assertion("assertion-b", earlyFirst, earlySecond),
      ],
      "state",
    );

    const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
      store.backend,
      "state",
      { limit: 2 },
    );

    // Endpoint sorting would reverse these rows. Pagination instead preserves
    // the database's assertion-id scan order and advances from that same scan.
    expect(page.assertions.map((item) => item.id)).toEqual([
      "assertion-a",
      "assertion-b",
    ]);
    expect(page.nextAfter).toBe("assertion-b");
    expect(page.done).toBe(false);
  });

  it("refuses a page limit that is not a positive safe integer", async () => {
    const store = await createInitializedStore(graph, createTestBackend());

    // Every rejected limit is one the SQL below would otherwise accept and
    // answer nonsensically: `LIMIT 0` pages forever without progress, a
    // negative limit is unbounded on SQLite, and a fractional one makes
    // `rows.length < limit` (the `done` verdict) unstateable.
    for (const limit of [0, -1, 1.5]) {
      await expect(
        storeRuntime(store).readIdentityAssertionPageAtTarget(
          store.backend,
          "state",
          { limit },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          message:
            "Identity assertion page limit must be a positive safe integer.",
          details: matchingObject({ limit }),
        }),
      );
    }

    // 1 is the smallest ACCEPTED limit: the refusal is `<= 0`, not `< 1`.
    await expect(
      storeRuntime(store).readIdentityAssertionPageAtTarget(
        store.backend,
        "state",
        { limit: 1 },
      ),
    ).resolves.toEqual({ assertions: [], done: true });
  });

  it("restricts a page to the requested kinds in SQL", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const firstPerson = await store.nodes.Person.create(
      { name: "First person" },
      { id: "person-first" },
    );
    const secondPerson = await store.nodes.Person.create(
      { name: "Second person" },
      { id: "person-second" },
    );
    const firstCompany = await store.nodes.Company.create(
      { name: "First company" },
      { id: "company-first" },
    );
    const secondCompany = await store.nodes.Company.create(
      { name: "Second company" },
      { id: "company-second" },
    );
    const firstProject = await store.nodes.Project.create(
      { name: "First project" },
      { id: "project-first" },
    );
    const secondProject = await store.nodes.Project.create(
      { name: "Second project" },
      { id: "project-second" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        assertion("assertion-company", firstCompany, secondCompany),
        assertion("assertion-person", firstPerson, secondPerson),
        assertion("assertion-project", firstProject, secondProject),
      ],
      "state",
    );

    // TWO kinds, so the `IN` list is a real list: a filter emitted without its
    // separator is a syntax error rather than a wrong row set, and a filter
    // dropped entirely returns the third kind's assertion.
    const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
      store.backend,
      "state",
      { nodeKinds: ["Person", "Company"], limit: 10 },
    );

    expect(page.assertions.map((item) => item.id)).toEqual([
      "assertion-company",
      "assertion-person",
    ]);
    expect(page.done).toBe(true);
  });

  it("answers an empty kind filter without emitting an empty IN list", async () => {
    const backend = createTestBackend();
    const execute = vi.spyOn(backend, "execute");
    const store = await createInitializedStore(graph, backend);
    const firstPerson = await store.nodes.Person.create(
      { name: "First person" },
      { id: "person-first" },
    );
    const secondPerson = await store.nodes.Person.create(
      { name: "Second person" },
      { id: "person-second" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [assertion("assertion-person", firstPerson, secondPerson)],
      "state",
    );
    execute.mockClear();

    // "No kind is allowed" is a legitimate request with an obvious answer.
    const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
      store.backend,
      "state",
      { nodeKinds: [], limit: 10 },
    );

    expect(page).toEqual({ assertions: [], done: true });
    // The answer must come from the query's own constant-false arm, never from
    // handing the engine `IN ()`. Both backends run this ONE compiled read, and
    // the empty list is exactly where they disagree: SQLite parses `IN ()` and
    // returns no rows, PostgreSQL rejects it as a syntax error. So the empty
    // page above cannot distinguish the two on SQLite — the emitted SQL is the
    // only place the parity break is visible before it reaches PostgreSQL.
    const compiled = requireDefined(execute.mock.calls.at(-1))[0];
    expect(renderPostgres(compiled).sql).not.toMatch(/IN\s*\(\s*\)/);
  });

  it("drops a mixed-kind pair when filtering in memory", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const firstPerson = await store.nodes.Person.create(
      { name: "First person" },
      { id: "person-first" },
    );
    const secondPerson = await store.nodes.Person.create(
      { name: "Second person" },
      { id: "person-second" },
    );
    const company = await store.nodes.Company.create(
      { name: "Company" },
      { id: "company-first" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        // Endpoints in code-point order, as an import requires: the Company
        // side is the DISALLOWED one, the Person side the allowed one.
        assertion("assertion-mixed", company, firstPerson),
        assertion("assertion-person", firstPerson, secondPerson),
      ],
      "state",
    );
    // Over MAX_REFERENCE_CHUNK_SIZE (200) kinds, so the filter is applied in
    // memory instead of in SQL — the arm where BOTH endpoints must be allowed
    // is a JavaScript predicate rather than two `IN` clauses.
    const nodeKinds = [
      "Person",
      ...Array.from({ length: 201 }, (_, index) => `UnusedKind${index}`),
    ];

    const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
      store.backend,
      "state",
      { nodeKinds, limit: 10 },
    );

    // The mixed pair names an allowed kind on ONE side only. Including it would
    // export an assertion whose Company endpoint the importer never receives.
    expect(page.assertions.map((item) => item.id)).toEqual([
      "assertion-person",
    ]);
    expect(page.nextAfter).toBe("assertion-person");
    expect(page.done).toBe(true);
  });

  it("continues through empty in-memory-filtered pages to later matches", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const firstCompany = await store.nodes.Company.create(
      { name: "First company" },
      { id: "company-first" },
    );
    const secondCompany = await store.nodes.Company.create(
      { name: "Second company" },
      { id: "company-second" },
    );
    const firstPerson = await store.nodes.Person.create(
      { name: "First person" },
      { id: "person-first" },
    );
    const secondPerson = await store.nodes.Person.create(
      { name: "Second person" },
      { id: "person-second" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        assertion("assertion-a-filtered", firstCompany, secondCompany),
        assertion("assertion-z-included", firstPerson, secondPerson),
      ],
      "state",
    );
    const nodeKinds = [
      "Person",
      ...Array.from({ length: 201 }, (_, index) => `UnusedKind${index}`),
    ];

    const firstPage = await storeRuntime(
      store,
    ).readIdentityAssertionPageAtTarget(store.backend, "state", {
      nodeKinds,
      limit: 1,
    });
    expect(firstPage).toEqual({
      assertions: [],
      nextAfter: "assertion-a-filtered",
      done: false,
    });

    const exportedAssertionIds: string[] = [];
    for await (const chunk of exportGraphStream(store, {
      nodeKinds,
      batchSize: 1,
    })) {
      if (chunk.type === "identity") {
        exportedAssertionIds.push(...chunk.assertions.map((item) => item.id));
      }
    }
    expect(exportedAssertionIds).toEqual(["assertion-z-included"]);
  });

  it("settles the export transaction when the consumer returns early", async () => {
    const backend = createTestBackend();
    const transaction = vi.spyOn(backend, "transaction");
    const store = await createInitializedStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    const iterator = exportGraphStream(store, {
      batchSize: 1,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "header" },
    });
    // Identify the export's snapshot transaction by the options only it opens.
    // Indexing by position would pick up the `create` above, whose write
    // transaction has already fulfilled and so certifies nothing.
    const exportTransactionResult = requireDefined(
      transaction.mock.calls
        .map((call, index) => ({ options: call[1], index }))
        .filter(
          ({ options }) =>
            options?.isolationLevel === "repeatable_read" &&
            options.accessMode === "read_only",
        )
        .map(({ index }) => transaction.mock.results[index])
        .at(-1),
    );
    expect(exportTransactionResult.type).toBe("return");
    const transactionSettled = Promise.resolve(
      exportTransactionResult.value,
    ).then(
      () => ({ settled: "fulfilled" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    // `return()` does not resolve until the transaction has left its callback;
    // awaiting this would hang if the producer remained blocked on its push.
    // Cancellation unblocks the producer by REJECTING its in-flight push, so
    // the snapshot transaction rolls back with that error — asserting
    // "fulfilled" here would assert the opposite of the intended behavior.
    const outcome = await transactionSettled;
    expect(outcome.settled).toBe("rejected");
    expect(outcome).toMatchObject({
      error: { message: "Export stream consumer cancelled." },
    });
  });
});
