import { describe, expect, it, vi } from "vitest";

import { param as parameter } from "../../../src";
import { TEMPORAL_ANCHORS } from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

/**
 * Forces a real wall-clock millisecond boundary. The bound "current" read
 * instant is an ISO-8601 string at millisecond precision, so without this a
 * fast runner could compile-and-cache then insert within the same
 * millisecond — a frozen-instant cache would pass `valid_from <= now` by
 * coincidence, silently weakening the freshness guard below.
 */
async function waitForNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function registerTemporalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Temporal Query Execution", () => {
    it("excludes soft-deleted nodes by default", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      await store.nodes.Person.create({ name: "Bob", age: 25 });

      // Delete Alice
      await store.nodes.Person.delete(alice.id);

      const results = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Bob");
    });

    it("includes soft-deleted nodes with includeTombstones mode", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      await store.nodes.Person.create({ name: "Bob", age: 25 });

      await store.nodes.Person.delete(alice.id);

      const results = await store
        .query()
        .from("Person", "p")
        .temporal("includeTombstones")
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice", "Bob"]);
    });

    it("keeps a freshly-created row visible to an immediately-following current read despite app-vs-database clock skew (#242)", async () => {
      const store = context.getStore();

      // Simulate the app-server clock running AHEAD of the database clock by
      // pinning `Date` to a far-future instant. An omitted `validFrom` is
      // stamped from this (app) clock, so a "current" read must compare
      // against the same app clock to see the row. Under a database-clock read
      // (`valid_from <= NOW()`), the row's future `validFrom` would exceed the
      // database's real wall clock and vanish from the very read that created
      // it — the read-after-write regression from issue #242.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));

        const created = await store.nodes.Person.create({
          name: "Skewed",
          age: 42,
        });

        const queried = await store
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.eq("Skewed"))
          .select((ctx) => ctx.p.name)
          .execute();
        expect(queried).toEqual(["Skewed"]);

        const fetched = await store.nodes.Person.getById(created.id);
        expect(fetched?.name).toBe("Skewed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a reused prepared current query stays fresh across writes (compiled-template cache refreshes the read instant)", async () => {
      const store = context.getStore();

      // A "current" query compiles once into a cached template whose read
      // instant is a placeholder filled fresh per execute(). prepare() runs
      // before either row exists; both must still be visible on the execute()
      // that queries them, or the cache has frozen "now" (the #246 regression).
      const personByName = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .select((ctx) => ctx.p.name)
        .prepare();

      await waitForNextMillisecond();
      await store.nodes.Person.create({ name: "Alice", age: 30 });
      expect(await personByName.execute({ name: "Alice" })).toEqual(["Alice"]);

      // Created after the FIRST execute() too: the cached template must not
      // have frozen the instant on first use either.
      await waitForNextMillisecond();
      await store.nodes.Person.create({ name: "Bob", age: 25 });
      expect(await personByName.execute({ name: "Bob" })).toEqual(["Bob"]);
    });

    it("creates edges with validTo for temporal relationships", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const pastDate = new Date(Date.now() - 86_400_000).toISOString(); // Yesterday

      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Former Employee" },
        { validTo: pastDate },
      );

      expect(edge.meta.validTo).toBe(pastDate);
    });

    it("includes ended edges with includeEnded mode", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const pastDate = new Date(Date.now() - 86_400_000).toISOString();

      // Current job
      await store.edges.worksAt.create(alice, techCorp, { role: "Engineer" });

      // Past job (ended)
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Intern" },
        { validTo: pastDate },
      );

      // Default query - only current
      const currentJobs = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ctx.c.name)
        .execute();

      expect(currentJobs).toHaveLength(1);
      expect(currentJobs[0]).toBe("TechCorp");

      // With includeEnded - both jobs
      const allJobs = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .temporal("includeEnded")
        .traverse("worksAt", "e2")
        .to("Company", "c2")
        .select((ctx) => ctx.c2.name)
        .execute();

      expect(allJobs).toHaveLength(2);
      expect(allJobs.toSorted()).toEqual(["Acme Corp", "TechCorp"]);
    });

    it("queries with asOf temporal mode to filter by validity window", async () => {
      // asOf mode filters records based on their valid_from/valid_to windows.
      // It shows records that were "valid" at a specific point in time.

      const store = context.getStore();
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
      const twoHoursAgo = new Date(now.getTime() - 7_200_000).toISOString();
      const oneHourFromNow = new Date(now.getTime() + 3_600_000).toISOString();

      // Create a person who became valid one hour ago (still valid now)
      await store.nodes.Person.create(
        { name: "Alice", age: 30 },
        { validFrom: oneHourAgo },
      );

      // Create a person who will become valid in the future
      await store.nodes.Person.create(
        { name: "Bob", age: 25 },
        { validFrom: oneHourFromNow },
      );

      // Current query - Alice is valid now, Bob is not valid yet
      const currentResults = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.name)
        .execute();

      expect(currentResults).toHaveLength(1);
      expect(currentResults[0]).toBe("Alice");

      // Query asOf two hours ago - neither existed yet (Alice's validFrom is one hour ago)
      const twoHoursAgoResults = await store
        .query()
        .from("Person", "p")
        .temporal("asOf", twoHoursAgo)
        .select((ctx) => ctx.p.name)
        .execute();

      expect(twoHoursAgoResults).toHaveLength(0);

      // Query asOf now - only Alice is valid
      const nowResults = await store
        .query()
        .from("Person", "p")
        .temporal("asOf", now.toISOString())
        .select((ctx) => ctx.p.name)
        .execute();

      expect(nowResults).toHaveLength(1);
      expect(nowResults[0]).toBe("Alice");
    });

    it("defaults an omitted validFrom to the create timestamp, not open-left NULL", async () => {
      // Regression test for #240: an omitted validFrom must stamp the
      // operation's creation time, not persist as NULL — NULL is
      // interpreted as "valid since forever" by asOf filters, which made a
      // node created today visible at any historical asOf, including
      // instants before it existed.
      const { PAST } = TEMPORAL_ANCHORS;
      const store = context.getStore();

      const alice = await store.nodes.Person.create({ name: "Alice" });

      expect(alice.meta.validFrom).toBeDefined();

      const pastNode = await store.nodes.Person.getById(alice.id, {
        temporalMode: "asOf",
        asOf: PAST,
      });
      expect(pastNode).toBeUndefined();
    });

    it("defaults an omitted edge validFrom to the create timestamp, even when both endpoints predate it", async () => {
      // Regression test for #240's "test gap": pair the implicit-validFrom
      // edge with endpoints that are ALREADY valid at the historical asOf,
      // so only the edge's own (formerly NULL) validFrom can hide or
      // surface it — a future-dated endpoint would mask the edge bug.
      const { PAST, BEFORE } = TEMPORAL_ANCHORS;
      const store = context.getStore();

      const [alice, bob] = await Promise.all([
        store.nodes.Person.create({ name: "Alice" }, { validFrom: PAST }),
        store.nodes.Person.create({ name: "Bob" }, { validFrom: PAST }),
      ]);
      const edge = await store.edges.knows.create(alice, bob);

      expect(edge.meta.validFrom).toBeDefined();

      const pastEdges = await store.edges.knows.findFrom(alice, {
        temporalMode: "asOf",
        asOf: BEFORE,
      });
      expect(pastEdges).toHaveLength(0);

      const currentEdges = await store.edges.knows.findFrom(alice, {
        temporalMode: "current",
      });
      expect(currentEdges.map((row) => row.id)).toEqual([edge.id]);
    });
  });
}
