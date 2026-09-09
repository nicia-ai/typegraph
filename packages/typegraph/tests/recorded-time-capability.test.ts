/**
 * The optional `recordedTime` capability module: the refusal
 * `requireRecordedTime` gives a caller when a backend declares no
 * `recordedTime`, that it returns the backend's own member unchanged when
 * one is present, and `resolveRecordedTimeOwnership`'s derivation of
 * ownership from the member's presence.
 *
 * No bundled backend implements `recordedTime` yet, so the "present" cases
 * here overlay a scripted `EngineRecordedTimeMembers` directly, the same
 * shape a future engine profile would supply through
 * `EngineProvisioning.recordedTime`.
 */
import { describe, expect, it } from "vitest";

import {
  type EngineRecordedTimeMembers,
  requireRecordedTime,
} from "../src/backend/capabilities/recorded-time";
import { resolveRecordedTimeOwnership } from "../src/backend/capabilities/recorded-time-ownership";
import { deriveBackend } from "../src/backend/derive-backend";
import { type GraphBackend } from "../src/backend/types";
import { ConfigurationError } from "../src/errors";
import { sql } from "../src/query/sql-fragment";
import { createTestBackend } from "./test-utils";

function scriptedRecordedTime(): EngineRecordedTimeMembers {
  return {
    source: (table) => sql.identifier(`engine_${table}`),
    revisionNow: () =>
      Promise.resolve({
        revision: "engine-r1",
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
  };
}

describe("requireRecordedTime refusals", () => {
  it("refuses a backend with no recordedTime member, naming both recordedTime and the caller's operation", () => {
    const backendWithNoRecordedTime: Pick<GraphBackend, "recordedTime"> = {
      recordedTime: undefined,
    };

    let thrown: unknown;
    try {
      requireRecordedTime(
        backendWithNoRecordedTime,
        "engine-native read binding",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "RECORDED_TIME_UNAVAILABLE",
    );
    expect(configurationError.message).toContain("recordedTime");
    expect(configurationError.message).toContain("engine-native read binding");
  });

  it("returns the backend's own recordedTime member, unchanged, when present", () => {
    const recordedTime = scriptedRecordedTime();
    const backend = deriveBackend(createTestBackend(), { recordedTime });

    expect(requireRecordedTime(backend, "test")).toBe(recordedTime);
  });

  it("is absent by default on a bundled backend, since neither dialect implements it yet", () => {
    const backend = createTestBackend();

    expect(backend.recordedTime).toBeUndefined();
    expect(() => requireRecordedTime(backend, "test")).toThrow(
      ConfigurationError,
    );
  });
});

describe("resolveRecordedTimeOwnership", () => {
  it('derives "typegraph-relations" when the backend declares no recordedTime', () => {
    const backend = createTestBackend();

    expect(backend.recordedTime).toBeUndefined();
    expect(resolveRecordedTimeOwnership(backend)).toBe("typegraph-relations");
  });

  it('derives "engine-native" when the backend declares recordedTime', () => {
    const backend = deriveBackend(createTestBackend(), {
      recordedTime: scriptedRecordedTime(),
    });

    expect(resolveRecordedTimeOwnership(backend)).toBe("engine-native");
  });
});
