/**
 * Unit tests for the recorded/system-time pieces of the read coordinate:
 * sentinel + canonical-timestamp validation in `withRecordedCoordinate`, and
 * the recorded projection in `describeCoordinate` / `coordinateContext`.
 */
import { describe, expect, it } from "vitest";

import {
  asRecordedInstant,
  coordinateContext,
  describeCoordinate,
  type ReadCoordinate,
  RECORDED_MAX,
  type RecordedInstant,
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../src/core/temporal";

const VALID_AT = "2026-01-01T00:00:00.000Z";
const RECORDED_AT = asRecordedInstant("2026-02-02T00:00:00.000Z");

function validCoordinate(): ReadCoordinate {
  return resolveReadCoordinate("asOf", VALID_AT);
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
    ).toThrow("must be before the recorded-time open sentinel");
  });

  it("rejects a non-canonical recorded timestamp", () => {
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
      "must be before the recorded-time open sentinel",
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

    expect(context.recordedAsOf).toBe(RECORDED_AT);
    expect(context.temporalMode).toBe("asOf");
  });
});
