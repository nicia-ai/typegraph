/**
 * T16 (I9) — the two construction gates refuse at `createStore`, never
 * mid-flush, and the refusal message is the migration guide (OQ-B).
 *
 * Six rows:
 *
 *  (a) `history: true` on an `unfenced` backend refuses at `createStore`,
 *      zero statements.
 *  (b) an identity graph on an `unfenced` backend refuses, zero statements.
 *  (c) `history: true` on a backend declaring `recordedTimeOwnership:
 *      "engine-native"` refuses with the INTERIM error (a version-free
 *      message naming the missing engine-native path), on both an unfenced
 *      AND a fenced engine-native backend (the interim gate is not the fence
 *      gate wearing a different hat) — plus an R-2 exemption sub-row: an
 *      unfenced engine-native backend constructed WITHOUT
 *      `history`/`revisionTracking` succeeds. A pilot-freeze row (§B11)
 *      additionally asserts the message names no release version.
 *  (d) an undeclared non-factory backend refuses (a) and (b) via M-5's
 *      `unfenced` default.
 *  (e) the refusal message contains the LITERAL declaration line for the
 *      backend's dialect, not a substring like "pessimisticLocks".
 *  (f) `{ revisionTracking: true }` alone (no `history`) on an `unfenced`
 *      backend refuses, zero statements (ruling F3) — repeated through
 *      `cloneWorkingCopyStrategy`, which propagates the base store's
 *      `revisionTrackingEnabled` into a fresh store without the caller
 *      naming the option.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import { pessimisticLockDeclarationLine } from "../src/backend/capabilities/write-fence";
import { TypeGraphError } from "../src/errors";
import { cloneWorkingCopyStrategy } from "../src/graph-merge";
import {
  createLoggedPostgresBackend,
  createLoggedSqliteBackend,
  overlayCapabilities,
  UNFENCED_CAPABILITIES,
} from "./lock-fence-test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const plainGraph = defineGraph({
  id: "lock-fence-refusal-plain",
  nodes: { Person: { type: Person } },
  edges: {},
});
const identityGraph = defineGraph({
  id: "lock-fence-refusal-identity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

function writeFenceRefusal(code: string): unknown {
  return expect.objectContaining({
    details: expect.objectContaining({ code }) as unknown,
  });
}

describe("T16 — (a) history: true on unfenced refuses, zero statements", () => {
  it("SQLite unfenced", () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    // Factory construction itself probes the driver (a `PRAGMA
    // compile_options` sync-detection read) — reset AFTER the backend
    // exists so only `createStore`'s own statements (there must be none)
    // are counted.
    logged.reset();
    expect(() =>
      createStore(plainGraph, logged.backend, { history: true }),
    ).toThrow(writeFenceRefusal("RECORDED_CLOCK_REQUIRES_WRITE_FENCE"));
    expect(logged.statements).toHaveLength(0);
  });
});

describe("T16 — (b) identity graph on unfenced refuses, zero statements", () => {
  it("SQLite unfenced", () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    logged.reset();
    expect(() => createStore(identityGraph, logged.backend)).toThrow(
      writeFenceRefusal("IDENTITY_REQUIRES_WRITE_FENCE"),
    );
    expect(logged.statements).toHaveLength(0);
  });
});

describe("T16 — (c) engine-native interim refusal", () => {
  it("unfenced engine-native + history: refuses with the interim error, zero statements", () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
      recordedTimeOwnership: "engine-native",
    });
    logged.reset();
    expect(() =>
      createStore(plainGraph, logged.backend, { history: true }),
    ).toThrow(writeFenceRefusal("ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED"));
    expect(logged.statements).toHaveLength(0);
  });

  it("fenced engine-native + history: STILL refuses with the interim error (not the fence gate wearing a different hat)", async () => {
    const logged = await createLoggedPostgresBackend({
      recordedTimeOwnership: "engine-native",
    });
    try {
      expect(() =>
        createStore(plainGraph, logged.backend, { history: true }),
      ).toThrow(
        writeFenceRefusal("ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED"),
      );
    } finally {
      await logged.close();
    }
  });

  it("R-2 exemption: unfenced engine-native WITHOUT history/revisionTracking constructs successfully", () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
      recordedTimeOwnership: "engine-native",
    });
    expect(() => createStore(plainGraph, logged.backend)).not.toThrow();
  });

  it("the engine-native interim refusal names no release version", () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
      recordedTimeOwnership: "engine-native",
    });
    let caught: unknown;
    try {
      createStore(plainGraph, logged.backend, { history: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeGraphError);
    const error = caught as TypeGraphError;
    expect(error.details["code"]).toBe(
      "ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED",
    );
    expect(error.message).toContain("without `history`");
    expect(error.message).toContain('"typegraph-relations"');
    expect(error.message).not.toMatch(/\b0\.\d+(\.\d+)?\b/);
  });
});

describe("T16 — (d) undeclared non-factory refuses (a) and (b)", () => {
  it("history: true", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      expect(() => createStore(plainGraph, target, { history: true })).toThrow(
        writeFenceRefusal("RECORDED_CLOCK_REQUIRES_WRITE_FENCE"),
      );
    } finally {
      await logged.close();
    }
  });

  it("identity graph", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      expect(() => createStore(identityGraph, target)).toThrow(
        writeFenceRefusal("IDENTITY_REQUIRES_WRITE_FENCE"),
      );
    } finally {
      await logged.close();
    }
  });
});

describe("T16 — (e) the refusal message carries the literal declaration line", () => {
  it('names the exact string, not a substring like "pessimisticLocks"', () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    let caught: unknown;
    try {
      createStore(identityGraph, logged.backend);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(pessimisticLockDeclarationLine("sqlite"));
    // The exact string, not merely the word "pessimisticLocks" in isolation:
    // a pointer like "declare pessimisticLocks on this backend" would still
    // contain the bare word without carrying the migration guide's line.
    expect(message).not.toBe("pessimisticLocks");
  });
});

describe("T16 — (f) revisionTracking: true alone on unfenced refuses, zero statements", () => {
  it("direct construction", () => {
    const logged = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    logged.reset();
    expect(() =>
      createStore(plainGraph, logged.backend, { revisionTracking: true }),
    ).toThrow(writeFenceRefusal("RECORDED_CLOCK_REQUIRES_WRITE_FENCE"));
    expect(logged.statements).toHaveLength(0);
  });

  it("through cloneWorkingCopyStrategy, which propagates the base store's revisionTrackingEnabled", async () => {
    const base = createLoggedSqliteBackend();
    const baseStore = createStore(plainGraph, base.backend, {
      revisionTracking: true,
    });
    expect(baseStore.revisionTrackingEnabled).toBe(true);

    const fresh = createLoggedSqliteBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    const strategy = cloneWorkingCopyStrategy<typeof plainGraph>(() =>
      Promise.resolve(fresh.backend),
    );
    await expect(strategy.create(baseStore)).rejects.toThrow(
      writeFenceRefusal("RECORDED_CLOCK_REQUIRES_WRITE_FENCE"),
    );
  });
});
