/**
 * `bulkFindFrom` / `bulkFindTo` refuse a backend that cannot read an endpoint
 * set, instead of degrading.
 *
 * The failure this guards is the reason the operation is separate from
 * `findEdgesByKind` rather than optional fields on it. A backend that ignored
 * an id set would still satisfy the type, return every edge of the kind, and
 * let the collection rebucket it into a *correct-looking* answer at unbounded
 * cost — correct results, catastrophic load, no error. Support is therefore
 * detected by the method's presence, before any statement is issued.
 *
 * Degrading to one `findFrom` per endpoint is deliberately not offered: a
 * caller reaching for a bulk read is asking for set-oriented statements, and
 * quietly issuing N singleton statements is the same class of cost surprise,
 * just smaller.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string().optional() }),
});

const graph = defineGraph({
  id: "bulk_endpoint_capability",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

/**
 * The same backend with the endpoint-set operation hidden — a stand-in for a
 * third-party backend written before the operation existed. Everything else,
 * including the singleton `findEdgesByKind`, still works.
 */
function withoutEndpointSetReads(backend: GraphBackend): GraphBackend {
  return new Proxy(backend, {
    get(target, property, receiver) {
      // eslint-disable-next-line unicorn/no-useless-undefined -- the proxy must answer "absent"
      if (property === "findEdgesByEndpointSet") return undefined;
      return Reflect.get(target, property, receiver) as unknown;
    },
    has(target, property) {
      if (property === "findEdgesByEndpointSet") return false;
      return Reflect.has(target, property);
    },
  });
}

function withoutHeterogeneousEndpointSetReads(
  backend: GraphBackend,
): GraphBackend {
  return new Proxy(backend, {
    get(target, property, receiver) {
      // eslint-disable-next-line unicorn/no-useless-undefined -- the proxy must answer "absent"
      if (property === "findEdgesByHeterogeneousEndpointSet") return undefined;
      return Reflect.get(target, property, receiver) as unknown;
    },
    has(target, property) {
      if (property === "findEdgesByHeterogeneousEndpointSet") return false;
      return Reflect.has(target, property);
    },
  });
}

describe("bulk endpoint reads on a backend without the capability", () => {
  it("refuses with a typed error naming the missing capability", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutEndpointSetReads(createTestBackend()),
    );
    const alice = await store.nodes.Person.create({ name: "Alice" });

    const error = await store.edges.knows
      .bulkFindFrom([alice])
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).details).toMatchObject({
      capability: "findEdgesByEndpointSet",
      operation: "bulkFindFrom",
    });
    // The refusal must name the alternative rather than just say "no".
    expect((error as ConfigurationError).message).toContain(
      "findEdgesByEndpointSet",
    );
  });

  it("refuses bulkFindTo the same way", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutEndpointSetReads(createTestBackend()),
    );
    const alice = await store.nodes.Person.create({ name: "Alice" });

    await expect(store.edges.knows.bulkFindTo([alice])).rejects.toMatchObject({
      details: { operation: "bulkFindTo" },
    });
  });

  it("refuses BEFORE issuing any read", async () => {
    const backend = createTestBackend();
    let findEdgesByKindCalls = 0;
    async function countedFindEdgesByKind(params: never) {
      findEdgesByKindCalls += 1;
      return backend.findEdgesByKind(params);
    }
    const counting = new Proxy(withoutEndpointSetReads(backend), {
      get(target, property, receiver) {
        if (property === "findEdgesByKind") return countedFindEdgesByKind;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const [store] = await createStoreWithSchema(graph, counting);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    findEdgesByKindCalls = 0;

    await expect(store.edges.knows.bulkFindFrom([alice])).rejects.toThrow(
      ConfigurationError,
    );
    // A fallback loop — the degradation this design rejects — would show up here.
    expect(findEdgesByKindCalls).toBe(0);
  });

  it("leaves the singleton findFrom path working on the same backend", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutEndpointSetReads(createTestBackend()),
    );
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, { since: "2024" });

    const edges = await store.edges.knows.findFrom(alice);
    expect(edges).toHaveLength(1);
  });

  it("returns [] for empty input without consulting the backend at all", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutEndpointSetReads(createTestBackend()),
    );

    // Empty input short-circuits ahead of the capability check: there is no
    // read to refuse, so an empty page must not become an error.
    await expect(store.edges.knows.bulkFindFrom([])).resolves.toEqual([]);
  });
});

describe("heterogeneous bulk endpoint reads without the capability", () => {
  it("refuses rather than expanding to collection reads", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutHeterogeneousEndpointSetReads(createTestBackend()),
    );
    const alice = await store.nodes.Person.create({ name: "Alice" });

    await expect(
      store.bulkFindEdgesFrom({
        sources: [{ kind: "Person", ids: [alice.id] }],
        edgeKinds: ["knows"],
      }),
    ).rejects.toMatchObject({
      details: {
        capability: "findEdgesByHeterogeneousEndpointSet",
        operation: "bulkFindEdgesFrom",
      },
    });
  });

  it("keeps empty inputs harmless", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      withoutHeterogeneousEndpointSetReads(createTestBackend()),
    );

    await expect(
      store.bulkFindEdgesFrom({ sources: [], edgeKinds: ["knows"] }),
    ).resolves.toEqual([]);
  });
});
