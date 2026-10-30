import { describe, expect, it } from "vitest";

import { deriveBackend } from "../src/backend/derive-backend";
import {
  type DriverSavepointScope,
  registerDriverSavepointScope,
  resolveDriverSavepointScope,
  runSessionSavepoint,
  SavepointRecoveryFailure,
} from "../src/backend/session-savepoint";
import { createTestBackend } from "./test-utils";

/**
 * A session whose control statements and driver-scope boundaries land in one
 * ordered log, so each case can assert exactly where the driver scope sits
 * relative to TypeGraph's own savepoint.
 */
function createRecordingSession(
  options: Readonly<{ failingControl?: string }> = {},
) {
  const events: string[] = [];
  const enterDriverScope: DriverSavepointScope = async (scope) => {
    events.push("driver scope opened");
    try {
      const value = await scope();
      events.push("driver scope left open");
      return value;
    } catch (error) {
      events.push("driver scope rolled back");
      throw error;
    }
  };
  return {
    events,
    port: {
      executeControl: (statement: string) => {
        events.push(statement);
        return statement.startsWith(options.failingControl ?? "\0") ?
            Promise.reject(new Error(`injected ${statement} failure`))
          : Promise.resolve();
      },
      enterDriverScope,
    },
  };
}

const passThroughDriverScope: DriverSavepointScope = (scope) => scope();

describe("session savepoints", () => {
  it("opens the driver scope inside the savepoint whose release also releases it", async () => {
    const { events, port } = createRecordingSession();

    const value = await runSessionSavepoint(port, "sp_release", () => {
      events.push("scope work");
      return Promise.resolve({ action: "release", value: "released" });
    });

    expect(value).toBe("released");
    expect(events).toEqual([
      "SAVEPOINT sp_release",
      "driver scope opened",
      "scope work",
      "driver scope left open",
      "RELEASE SAVEPOINT sp_release",
    ]);
  });

  it("rolls a driver scope back for a rollback decision and still returns its value", async () => {
    const { events, port } = createRecordingSession();
    let restored = 0;

    const value = await runSessionSavepoint(
      port,
      "sp_decision",
      () =>
        Promise.resolve({
          action: "rollback",
          value: "refused row",
          cause: new Error("refusal"),
        }),
      () => {
        restored += 1;
        events.push("restored");
      },
    );

    expect(value).toBe("refused row");
    expect(restored).toBe(1);
    expect(events).toEqual([
      "SAVEPOINT sp_decision",
      "driver scope opened",
      "driver scope rolled back",
      "ROLLBACK TO SAVEPOINT sp_decision",
      "restored",
      "RELEASE SAVEPOINT sp_decision",
    ]);
  });

  it("rolls back and rethrows the scope's own failure", async () => {
    const { events, port } = createRecordingSession();
    const failure = new Error("statement failed");

    await expect(
      runSessionSavepoint(port, "sp_throw", () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(events).toEqual([
      "SAVEPOINT sp_throw",
      "driver scope opened",
      "driver scope rolled back",
      "ROLLBACK TO SAVEPOINT sp_throw",
      "RELEASE SAVEPOINT sp_throw",
    ]);
  });

  it("recovers a failed release by rolling the savepoint back", async () => {
    const releaseFailure = new Error("release failed");
    const events: string[] = [];
    let releases = 0;

    await expect(
      runSessionSavepoint(
        {
          executeControl: (statement) => {
            events.push(statement);
            if (statement.startsWith("RELEASE") && releases++ === 0) {
              return Promise.reject(releaseFailure);
            }
            return Promise.resolve();
          },
        },
        "sp_release_failure",
        () => Promise.resolve({ action: "release", value: undefined }),
      ),
    ).rejects.toBe(releaseFailure);
    expect(events).toEqual([
      "SAVEPOINT sp_release_failure",
      "RELEASE SAVEPOINT sp_release_failure",
      "ROLLBACK TO SAVEPOINT sp_release_failure",
      "RELEASE SAVEPOINT sp_release_failure",
    ]);
  });

  it("reports a failed rollback with both failures", async () => {
    const { port } = createRecordingSession({ failingControl: "ROLLBACK TO" });
    const failure = new Error("statement failed");

    const error = await runSessionSavepoint(port, "sp_broken", () =>
      Promise.reject(failure),
    ).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(SavepointRecoveryFailure);
    expect((error as SavepointRecoveryFailure).cause).toBe(failure);
    expect((error as SavepointRecoveryFailure).errors).toEqual([
      failure,
      new Error("injected ROLLBACK TO SAVEPOINT sp_broken failure"),
    ]);
  });

  it("resolves a session's driver scope through backends derived from it", () => {
    const sessionBackend = createTestBackend();
    const unrelatedBackend = createTestBackend();
    registerDriverSavepointScope(sessionBackend, passThroughDriverScope);

    const derivedBackend = deriveBackend(deriveBackend(sessionBackend, {}), {});

    expect(resolveDriverSavepointScope(derivedBackend)).toBe(
      passThroughDriverScope,
    );
    expect(resolveDriverSavepointScope(unrelatedBackend)).toBeUndefined();
  });
});
