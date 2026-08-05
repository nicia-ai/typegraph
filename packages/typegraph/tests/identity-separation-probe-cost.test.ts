/**
 * What the separation probe costs, counted rather than claimed.
 *
 * The read it replaced resolved both identity classes and then loaded every
 * current `different` assertion touching the first one — a scan whose statement
 * count grows with class size, because the endpoint list is chunked to fit the
 * backend's bind budget. The probe is one equality lookup on the relation's
 * primary key, so the ledger is not read at all and the count does not move
 * when the class grows.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  type GraphBackend,
  type TransactionBackend,
} from "../src";
import { MAX_REFERENCE_CHUNK_SIZE } from "../src/identity/sql-target";
import { createSqlSchema } from "../src/query/compiler/schema";
import { type SqlFragment } from "../src/query/sql-fragment";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity_probe_cost",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

interface RelationCounts {
  assertionStatements: number;
  separationStatements: number;
}

// Table names arrive as identifier chunks, not literal SQL text.
function fragmentText(compiled: SqlFragment): string {
  return compiled.chunks
    .map((chunk) =>
      chunk.kind === "text" || chunk.kind === "identifier" ? chunk.value : "",
    )
    .join(" ");
}

function relationCountingBackend(): Readonly<{
  backend: GraphBackend;
  counts: RelationCounts;
  reset: () => void;
}> {
  const base = createTestBackend();
  const tables = createSqlSchema(base.tableNames).tables;
  const counts = { assertionStatements: 0, separationStatements: 0 };

  function count(compiled: SqlFragment): void {
    const text = fragmentText(compiled);
    // The separation table name contains the assertions table name in neither
    // direction, so a plain substring test attributes each statement once.
    if (text.includes(tables.identityAssertions)) {
      counts.assertionStatements += 1;
    }
    if (text.includes(tables.identitySeparation)) {
      counts.separationStatements += 1;
    }
  }

  // A Proxy rather than a spread: transaction targets carry methods on a
  // prototype that spreading would drop.
  function countStatements<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    return new Proxy(target, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property !== "execute" && property !== "executeStatement") {
          return value;
        }
        return (...args: unknown[]) => {
          count(args[0] as SqlFragment);
          return method.apply(source, args);
        };
      },
    });
  }

  const backend: GraphBackend = countStatements({
    ...base,
    transaction: (fn, options) =>
      base.transaction((tx) => fn(countStatements(tx)), options),
  } satisfies GraphBackend);

  return {
    backend,
    counts,
    reset: () => {
      counts.assertionStatements = 0;
      counts.separationStatements = 0;
    },
  };
}

describe("cost of a current different-ness read", () => {
  it("probes the relation once and never reads the ledger, whatever the class size", async () => {
    const { backend, counts, reset } = relationCountingBackend();
    const store = await createInitializedStore(graph, backend);

    // One class large enough that the replaced ledger scan could not have named
    // its members in a single statement, and a peer held apart from it.
    const memberCount = MAX_REFERENCE_CHUNK_SIZE + 50;
    const members = [];
    for (let index = 0; index < memberCount; index += 1) {
      members.push(
        await store.nodes.Person.create(
          { name: `member-${index}` },
          { id: `member-${String(index).padStart(4, "0")}` },
        ),
      );
    }
    const peer = await store.nodes.Person.create({ name: "Peer" });
    const anchor = requireDefined(members[0]);
    await store.identity.bulkAssertSame(
      members.slice(1).map((member) => ({ a: anchor, b: member })),
    );
    await store.identity.assertDifferent(anchor, peer);
    expect(await store.identity.membersOf(anchor)).toHaveLength(memberCount);

    reset();
    expect(await store.identity.areDifferent(anchor, peer)).toBe(true);
    expect(counts).toEqual({
      assertionStatements: 0,
      separationStatements: 1,
    });

    // The negative answer costs the same probe, and so does the answer for a
    // singleton class: the cost is a property of the relation's index, not of
    // how much identity state the classes carry.
    const stranger = await store.nodes.Person.create({ name: "Stranger" });
    reset();
    expect(await store.identity.areDifferent(anchor, stranger)).toBe(false);
    expect(counts).toEqual({
      assertionStatements: 0,
      separationStatements: 1,
    });
  });
});
