/**
 * Runtime guards for the identity surface on an identity-DISABLED graph.
 *
 * The identity accessors type as `never` for a graph without an `identity`
 * config, so a TypeScript caller cannot reach them — but a JS caller (or a
 * cast) can. Each must fail loudly with a typed `ConfigurationError`
 * (`IDENTITY_NOT_ENABLED`) rather than a bare `TypeError` or a silent empty
 * result: `store.identity`, a time-pinned `StoreView`'s `.identity`, and the
 * `rebuildIdentityClosure(store)` repair helper.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import { ConfigurationError } from "../src/errors";
import { rebuildIdentityClosure } from "../src/identity";
import { createTestBackend, matchingObject } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const disabledGraph = defineGraph({
  id: "identity_disabled_guards",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * The identity accessors resolve to `never` on a disabled graph, so reach them
 * through an untyped view to exercise the runtime guard a JS caller would hit.
 */
type IdentityProbe = Readonly<{
  identity: unknown;
  asOf: (asOf: string) => Readonly<{ identity: unknown }>;
}>;

function identityNotEnabled(): unknown {
  return expect.objectContaining({
    name: "ConfigurationError",
    details: matchingObject({ code: "IDENTITY_NOT_ENABLED" }),
  });
}

describe("identity surface guards on an identity-disabled graph", () => {
  it("throws IDENTITY_NOT_ENABLED for store.identity", () => {
    const store = createStore(disabledGraph, createTestBackend());
    const probe = store as unknown as IdentityProbe;
    expect(() => probe.identity).toThrow(ConfigurationError);
    expect(() => probe.identity).toThrow(identityNotEnabled());
  });

  it("throws IDENTITY_NOT_ENABLED for a StoreView's identity", () => {
    const store = createStore(disabledGraph, createTestBackend());
    const probe = store as unknown as IdentityProbe;
    const view = probe.asOf("2026-01-01T00:00:00.000Z");
    expect(() => view.identity).toThrow(ConfigurationError);
    expect(() => view.identity).toThrow(identityNotEnabled());
  });

  it("rejects with IDENTITY_NOT_ENABLED for rebuildIdentityClosure(store)", async () => {
    const store = createStore(disabledGraph, createTestBackend());
    // The helper's type demands an identity-enabled store; a JS caller can
    // still pass a disabled one, so the runtime guard must reject.
    await expect(rebuildIdentityClosure(store as never)).rejects.toThrow(
      identityNotEnabled(),
    );
  });
});
