import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/errors";
import {
  buildEdgeMatchKey,
  canonicalPersistedJsonValue,
  normalizePersistedEdgeMatchProps,
  resolveEdgeMatchIdentityStorage,
} from "../src/store/edge-match-key";

function captureConfigurationError(run: () => unknown): ConfigurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("Expected a ConfigurationError");
}

describe("edge match keys", () => {
  it("encodes directed endpoints and sorted match fields injectively", () => {
    const first = buildEdgeMatchKey({
      fromKind: "Person",
      fromId: "alice\u001Dbob",
      toKind: "Person",
      toId: "carol",
      props: { role: "engineer", team: "platform" },
      matchOn: ["team", "role"],
    });
    const reordered = buildEdgeMatchKey({
      fromKind: "Person",
      fromId: "alice\u001Dbob",
      toKind: "Person",
      toId: "carol",
      props: { role: "engineer", team: "platform" },
      matchOn: ["role", "team", "role"],
    });
    const reversed = buildEdgeMatchKey({
      fromKind: "Person",
      fromId: "carol",
      toKind: "Person",
      toId: "alice\u001Dbob",
      props: { role: "engineer", team: "platform" },
      matchOn: ["role", "team"],
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(reversed);
    // This string is persisted and indexed. Changing its encoder is a storage
    // migration, not an implementation detail.
    expect(first).toBe(
      String.raw`["Person","alice\u001dbob","Person","carol","role","\"engineer\"","team","\"platform\""]`,
    );
    expect(JSON.parse(first)).toEqual([
      "Person",
      "alice\u001Dbob",
      "Person",
      "carol",
      "role",
      '"engineer"',
      "team",
      '"platform"',
    ]);
  });

  it("keeps an absent match property distinct from JSON null", () => {
    const absent = buildEdgeMatchKey({
      fromKind: "Person",
      fromId: "alice",
      toKind: "Person",
      toId: "bob",
      props: {},
      matchOn: ["label"],
    });
    const undefinedValue = buildEdgeMatchKey({
      fromKind: "Person",
      fromId: "alice",
      toKind: "Person",
      toId: "bob",
      props: { label: undefined },
      matchOn: ["label"],
    });
    const jsonNullKey = buildEdgeMatchKey({
      fromKind: "Person",
      fromId: "alice",
      toKind: "Person",
      toId: "bob",
      // eslint-disable-next-line unicorn/no-null -- JSON null must remain distinct from an absent field
      props: { label: null },
      matchOn: ["label"],
    });

    expect(absent).toBe(undefinedValue);
    expect(absent).not.toBe(jsonNullKey);
  });

  it("normalizes raw values through persisted JSON", () => {
    const createdAt = new Date("2026-08-23T12:00:00.000Z");
    const raw = {
      metadata: { retained: true, dropped: undefined },
      createdAt,
      tags: ["first", undefined, "third"],
    };
    const persisted = normalizePersistedEdgeMatchProps(raw);

    expect(persisted).toEqual({
      metadata: { retained: true },
      createdAt: "2026-08-23T12:00:00.000Z",
      // eslint-disable-next-line unicorn/no-null -- JSON persistence converts array holes to null
      tags: ["first", null, "third"],
    });
    expect(
      buildEdgeMatchKey({
        fromKind: "Person",
        fromId: "alice",
        toKind: "Document",
        toId: "readme",
        props: raw,
        matchOn: ["metadata", "createdAt", "tags"],
      }),
    ).toBe(
      buildEdgeMatchKey({
        fromKind: "Person",
        fromId: "alice",
        toKind: "Document",
        toId: "readme",
        props: persisted,
        matchOn: ["tags", "createdAt", "metadata"],
      }),
    );
  });

  it("canonicalizes object keys independently of insertion order", () => {
    expect(canonicalPersistedJsonValue({ nested: { alpha: 1, beta: 2 } })).toBe(
      canonicalPersistedJsonValue({ nested: { beta: 2, alpha: 1 } }),
    );
    expect(
      canonicalPersistedJsonValue(new Date("2026-08-23T12:00:00.000Z")),
    ).toBe(canonicalPersistedJsonValue("2026-08-23T12:00:00.000Z"));
  });

  it("refuses oversized durable index tuples before either backend writes", () => {
    const error = captureConfigurationError(() =>
      resolveEdgeMatchIdentityStorage(
        { name: "label", fields: ["label"] },
        {
          fromKind: "Person",
          fromId: "alice",
          toKind: "Person",
          toId: "bob",
          props: { label: "x".repeat(2600) },
        },
        { graphId: "portable", edgeKind: "knows" },
      ),
    );

    expect(error.details).toMatchObject({
      code: "EDGE_MATCH_IDENTITY_KEY_TOO_LARGE",
      edgeKind: "knows",
      graphId: "portable",
      identityName: "label",
      maxIndexBytes: 2000,
    });
    expect(typeof error.details["indexBytes"]).toBe("number");
  });

  it("refuses non-scalar durable values instead of collapsing them through JSON", () => {
    const error = captureConfigurationError(() =>
      resolveEdgeMatchIdentityStorage(
        { name: "labels", fields: ["labels"] },
        {
          fromKind: "Person",
          fromId: "alice",
          toKind: "Person",
          toId: "bob",
          props: { labels: new Set(["friend"]) },
        },
        { graphId: "portable", edgeKind: "knows" },
      ),
    );

    expect(error.details).toMatchObject({
      code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
      edgeKind: "knows",
      fields: ["labels"],
      graphId: "portable",
      identityName: "labels",
    });
  });

  it.each([
    ["Date", new Date("2026-08-23T12:00:00.000Z")],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["BigInt", 1n],
  ])("refuses %s before JSON normalization", (_name, value) => {
    const error = captureConfigurationError(() =>
      resolveEdgeMatchIdentityStorage(
        { name: "label", fields: ["label"] },
        {
          fromKind: "Person",
          fromId: "alice",
          toKind: "Person",
          toId: "bob",
          props: { label: value },
        },
        { graphId: "portable", edgeKind: "knows" },
      ),
    );

    expect(error.details).toMatchObject({
      code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
      fields: ["label"],
    });
  });

  it("does not blame identity fields for an unrelated non-JSON property", () => {
    const storage = resolveEdgeMatchIdentityStorage(
      { name: "label", fields: ["label"] },
      {
        fromKind: "Person",
        fromId: "alice",
        toKind: "Person",
        toId: "bob",
        props: { label: "friend", metadata: 1n },
      },
      { graphId: "portable", edgeKind: "knows" },
    );

    expect(storage).toMatchObject({ name: "label" });
  });
});
