/**
 * Unit tests for the recorded/system-time pieces of the read coordinate:
 * sentinel + versioned-anchor validation in `withRecordedCoordinate`, and
 * the recorded projection in `describeCoordinate` / `coordinateContext`.
 */
import { describe, expect, it } from "vitest";

import {
  asRecordedInstant,
  coordinateContext,
  createRecordedInstant,
  describeCoordinate,
  parseRecordedInstant,
  type ReadCoordinate,
  RECORDED_MAX,
  type RecordedInstant,
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../src/core/temporal";
import { ValidationError } from "../src/errors";

const VALID_AT = "2026-01-01T00:00:00.000Z";
const RECORDED_AT = asRecordedInstant(
  "r1:0000000000000042:2026-02-02T00:00:00.000Z",
);

function validCoordinate(): ReadCoordinate {
  return resolveReadCoordinate("asOf", VALID_AT);
}

function captureValidationError(action: () => unknown): ValidationError {
  try {
    action();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected action to throw ValidationError");
}

describe("withRecordedCoordinate", () => {
  it("adds a recorded sibling while preserving the valid coordinate", () => {
    const coordinate = withRecordedCoordinate(validCoordinate(), RECORDED_AT);

    expect(coordinate.valid).toEqual({ mode: "asOf", asOf: VALID_AT });
    expect(coordinate.recorded).toEqual({ asOf: RECORDED_AT });
  });

  it("rejects the open-interval sentinel itself", () => {
    expect(() =>
      withRecordedCoordinate(
        validCoordinate(),
        RECORDED_MAX as RecordedInstant,
      ),
    ).toThrow("canonical versioned recorded instant");
  });

  it("rejects timestamp-only and malformed recorded anchors", () => {
    expect(() =>
      withRecordedCoordinate(
        validCoordinate(),
        "2026-02-02" as RecordedInstant,
      ),
    ).toThrow();
    expect(() =>
      withRecordedCoordinate(
        validCoordinate(),
        "not-a-timestamp" as RecordedInstant,
      ),
    ).toThrow();
  });
});

describe("asRecordedInstant", () => {
  it("rejects the open-interval sentinel itself", () => {
    expect(() => asRecordedInstant(RECORDED_MAX)).toThrow(
      "canonical versioned recorded instant",
    );
  });

  it("round-trips the logical revision and physical wall time", () => {
    const instant = createRecordedInstant(42, VALID_AT);

    expect(instant).toBe("r1:0000000000000042:2026-01-01T00:00:00.000Z");
    expect(parseRecordedInstant(instant)).toEqual({
      revision: 42,
      recordedAt: VALID_AT,
    });
  });

  it("rejects timestamp-only preview anchors with migration guidance", () => {
    const error = captureValidationError(() => asRecordedInstant(VALID_AT));

    expect(error.suggestion).toContain(
      "timestamp-only anchors from the initial recorded-time schema are not compatible",
    );
  });
});

describe("describeCoordinate", () => {
  it("omits the recorded axis when absent", () => {
    const description = describeCoordinate(validCoordinate());

    expect(description).toContain(`asOf ${VALID_AT}`);
    expect(description).not.toContain("recorded");
  });

  it("appends the recorded axis when present", () => {
    const description = describeCoordinate(
      withRecordedCoordinate(validCoordinate(), RECORDED_AT),
    );

    expect(description).toContain(`recorded asOf ${RECORDED_AT}`);
  });
});

describe("coordinateContext", () => {
  it("omits recordedAsOf when absent", () => {
    const context = coordinateContext(validCoordinate());

    expect(context).not.toHaveProperty("recordedAsOf");
  });

  it("surfaces recordedAsOf when present", () => {
    const context = coordinateContext(
      withRecordedCoordinate(validCoordinate(), RECORDED_AT),
    );

    expect(context["recordedAsOf"]).toBe(RECORDED_AT);
    expect(context["temporalMode"]).toBe("asOf");
  });
});
