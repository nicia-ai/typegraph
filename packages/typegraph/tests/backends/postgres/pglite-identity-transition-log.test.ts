/**
 * G1-05: `readIdentityTransitions` must decode `recorded_at` / `valid_at`
 * through `toCanonicalIdentityTimestamp` (row-codec.ts) — the identity
 * module's one owner of "how is a raw driver timestamp value turned into a
 * canonical ISO string" — rather than a private, stricter
 * string-only decoder. Both columns are declared
 * `timestamp(..., { withTimezone: true }).notNull()` on PostgreSQL
 * (schema/postgres.ts), and `pg` decodes `timestamptz` into a JS `Date`; a
 * decoder that only accepts a string throws on that value.
 *
 * PGlite's own driver returns text rather than a `Date` for a timestamp
 * column, so this lane cannot exercise the `Date`-typed branch a real `pg`
 * connection would hit (see `toCanonicalIdentityTimestamp`'s `instanceof
 * Date` branch) — the lane note the finding itself calls out. It still
 * exercises the PostgreSQL DDL/dialect end to end and pins that the decode
 * path produces genuinely canonical ISO output, not merely "does not throw".
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { recordedInstantWallTime } from "../../../src/core/temporal";
import { identityTransitionsOf } from "../../../src/identity/replay";
import { createStore } from "../../../src/store";
import { storeRuntime } from "../../../src/store/runtime-port";
import { isCanonicalIsoDate } from "../../../src/utils/date";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "pglite_identity_transition_log",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

describe("identity transition log on PGlite (PostgreSQL dialect)", () => {
  it("round-trips recorded_at and valid_at as canonical ISO instants", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const store = createStore(graph, backend, { history: true });
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertSame(
        { kind: "Person", id: alice.id },
        { kind: "Person", id: bob.id },
      );

      const ctx = storeRuntime(store).identityContext();
      const { transitions } = await identityTransitionsOf(ctx, {
        kind: "Person",
        id: alice.id,
      });

      expect(transitions.length).toBeGreaterThan(0);
      for (const transition of transitions) {
        expect(
          isCanonicalIsoDate(recordedInstantWallTime(transition.recorded)),
        ).toBe(true);
        expect(isCanonicalIsoDate(transition.validAt)).toBe(true);
      }
    } finally {
      await backend.close();
    }
  });
});
