import { describe, expect, it } from "vitest";

import { asNodeId, newStore, P } from "./harness";

describe("identity transition log: history and discoverability", () => {
  it("departed-member-lineage", async () => {
    // A=B then soft-delete the non-canonical B: B left A's class, so the
    // history of B's membership must be discoverable from B.
    const store = await newStore();
    for (const id of ["a", "b", "c"])
      await store.nodes.Person.create({ name: id }, { id });
    await store.identity.assertSame(P("a"), P("b"));
    await store.identity.assertSame(P("b"), P("c"));
    await store.nodes.Person.delete(asNodeId("b"));

    const { transitions } = await store.identity.transitionsOf(P("b"));
    expect(transitions.map((transition) => transition.cause)).toContain(
      "assert",
    );
    expect(transitions.map((transition) => transition.cause)).toContain(
      "detach",
    );
    const { steps } = await store.identity.replay(P("b"));
    expect(steps.length).toBeGreaterThan(0);
  });

  it("changes-since-identity-only-history", async () => {
    // Documented: Store.changesSince reports `unbounded` for identity-only
    // changes. With history capture it instead answers an empty exact delta,
    // so a consumer concludes nothing changed although a class fused.
    const store = await newStore();
    await store.nodes.Person.create({ name: "a" }, { id: "a" });
    await store.nodes.Person.create({ name: "b" }, { id: "b" });
    const since = await store.lineageRevisionNow();
    if (since === undefined) throw new Error("lineage revision expected");

    await store.identity.assertSame(P("a"), P("b"));
    const delta = await store.changesSince(since);

    expect(await store.identity.areSame(P("a"), P("b"))).toBe(true);
    if (delta.kind === "keys") {
      const touched = delta.nodes.map((key) => `${key.kind}:${key.id}`);
      expect(touched).toEqual(
        expect.arrayContaining(["Person:a", "Person:b"]),
      );
    } else {
      expect(delta.kind).toBe("unbounded");
    }
  });
});
