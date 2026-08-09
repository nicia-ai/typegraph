/**
 * The pure, dialect-free window algebra the temporal oracle is built on.
 *
 * No database, no store, no driver: these are laws about the interval semantics
 * of a validity window and about the decision a write makes when it stamps a
 * lower bound the caller did not state. They run at a high iteration count
 * because they are cheap, and because the boundary cases they cover — zero
 * width, inverted, unbounded on either side — are exactly the ones a DB-backed
 * property can only reach by getting lucky with a clock.
 *
 * WHAT IS AND IS NOT STATED HERE, AND WHY.
 * `isInvertedValidityWindow` (`src/utils/date.ts`) is the library's REFUSAL
 * predicate and exists today, so its relation to the model's own emptiness
 * decision is a law now. The CHOICE predicate (`isEmptyValidityWindow`) and the
 * stamping owner (`resolveStampedValidityLowerBound`) land with the seam, and
 * the laws that quantify over them land in the same diff. Until then the
 * stamping law is stated over {@link expectedStoredLowerBound} — the model's
 * encoding of today's contract — RESTRICTED away from the cell
 * `KNOWN_CONTRACT_GAPS` declares, exactly as P1/P1b are restricted at the
 * database level. A law that quantified over the excused cell would be red on
 * `main`, which is the one thing this batch may not be.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isInvertedValidityWindow } from "../../src/utils/date";
import { requireDefined } from "../../src/utils/presence";
import {
  expectedStoredLowerBound,
  type Instant,
  intervalContains,
  intervalIsEmpty,
  intervalIsInverted,
  intervalOf,
} from "../backends/integration/temporal-oracle-model";

const RUNS = { numRuns: 300 } as const;

/** Interchange's "confirmed open-left" wire value — the input under test here. */
// eslint-disable-next-line unicorn/no-null -- the interchange wire value
const CONFIRMED_OPEN_LEFT = null;

const LATTICE_START = new Date("2000-01-01T00:00:00.000Z");
const LATTICE_END = new Date("2100-01-01T00:00:00.000Z");

/** Canonical fixed-width UTC ISO 8601, which is what every stored bound is. */
function instantArb(): fc.Arbitrary<Instant> {
  return fc
    .date({ min: LATTICE_START, max: LATTICE_END, noInvalidDate: true })
    .map((value) => value.toISOString());
}

function optionalInstantArb(): fc.Arbitrary<Instant | undefined> {
  return fc.option(instantArb(), { nil: undefined });
}

function windowArb(): fc.Arbitrary<
  Readonly<{ validFrom: Instant | undefined; validTo: Instant | undefined }>
> {
  return fc.record({
    validFrom: optionalInstantArb(),
    validTo: optionalInstantArb(),
  });
}

/** Three instants in non-decreasing order, as a real tuple. */
function orderedTripleArb(): fc.Arbitrary<
  readonly [Instant, Instant, Instant]
> {
  return fc.tuple(instantArb(), instantArb(), instantArb()).map((instants) => {
    const sorted = instants.toSorted();
    return [
      requireDefined(sorted[0], "low"),
      requireDefined(sorted[1], "middle"),
      requireDefined(sorted[2], "high"),
    ] as const;
  });
}

describe("validity window algebra", () => {
  it("membership is an interval: anything between two contained instants is contained", () => {
    fc.assert(
      fc.property(
        windowArb(),
        orderedTripleArb(),
        (window, [low, middle, high]) => {
          const interval = intervalOf(window);
          const endpointsContained =
            intervalContains(interval, low) && intervalContains(interval, high);
          // Stated as an implication rather than a guarded assertion: a
          // conditional `expect` can silently stop asserting anything.
          expect(
            !endpointsContained || intervalContains(interval, middle),
          ).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("a zero-width window contains nothing", () => {
    fc.assert(
      fc.property(instantArb(), instantArb(), (bound, probe) => {
        const interval = intervalOf({ validFrom: bound, validTo: bound });
        expect(intervalIsEmpty(interval)).toBe(true);
        expect(intervalIsInverted(interval)).toBe(false);
        expect(intervalContains(interval, probe)).toBe(false);
      }),
      RUNS,
    );
  });

  it("an inverted window is empty, and empty-but-not-inverted is exactly zero width", () => {
    fc.assert(
      fc.property(windowArb(), (window) => {
        const interval = intervalOf(window);
        const inverted = isInvertedValidityWindow(
          window.validFrom,
          window.validTo,
        );
        // The refusal predicate implies the choice predicate. It is strictly
        // stronger: the two differ on, and only on, the zero-width boundary.
        expect(!inverted || intervalIsEmpty(interval)).toBe(true);
        expect(intervalIsInverted(interval)).toBe(inverted);
        expect(intervalIsEmpty(interval) && !inverted).toBe(
          window.validFrom !== undefined &&
            window.validTo !== undefined &&
            window.validFrom === window.validTo,
        );
      }),
      RUNS,
    );
  });

  it("an unbounded endpoint is unbounded, never a coincidence of ordering", () => {
    fc.assert(
      fc.property(instantArb(), instantArb(), (bound, probe) => {
        expect(
          intervalContains(
            intervalOf({ validFrom: undefined, validTo: undefined }),
            probe,
          ),
        ).toBe(true);
        expect(
          intervalContains(
            intervalOf({ validFrom: undefined, validTo: bound }),
            probe,
          ),
        ).toBe(probe < bound);
        expect(
          intervalContains(
            intervalOf({ validFrom: bound, validTo: undefined }),
            probe,
          ),
        ).toBe(probe >= bound);
      }),
      RUNS,
    );
  });

  it("canonical ISO 8601 sorts chronologically as text", () => {
    fc.assert(
      fc.property(instantArb(), instantArb(), (left, right) => {
        const textual =
          left < right ? -1
          : left > right ? 1
          : 0;
        const chronological =
          new Date(left).getTime() < new Date(right).getTime() ? -1
          : new Date(left).getTime() > new Date(right).getTime() ? 1
          : 0;
        expect(textual).toBe(chronological);
      }),
      RUNS,
    );
  });
});

/** Two DISTINCT instants in increasing order — never zero width. */
function orderedPairArb(): fc.Arbitrary<readonly [Instant, Instant]> {
  return fc
    .tuple(instantArb(), instantArb())
    .filter((instants) => instants[0] !== instants[1])
    .map((instants) => {
      const sorted = instants.toSorted();
      return [
        requireDefined(sorted[0], "lower"),
        requireDefined(sorted[1], "upper"),
      ] as const;
    });
}

describe("the stored lower bound", () => {
  it("returns a stated bound verbatim and a stated null as no bound", () => {
    fc.assert(
      fc.property(
        instantArb(),
        optionalInstantArb(),
        instantArb(),
        (statedValidFrom, validTo, writeInstant) => {
          expect(
            expectedStoredLowerBound(statedValidFrom, validTo, writeInstant),
          ).toBe(statedValidFrom);
          expect(
            expectedStoredLowerBound(
              CONFIRMED_OPEN_LEFT,
              validTo,
              writeInstant,
            ),
          ).toBeUndefined();
        },
      ),
      RUNS,
    );
  });

  it("stamps the write instant it was handed, never a clock it sampled", () => {
    fc.assert(
      fc.property(instantArb(), (writeInstant) => {
        expect(
          expectedStoredLowerBound(undefined, undefined, writeInstant),
        ).toBe(writeInstant);
      }),
      RUNS,
    );
  });

  it("never yields a window readable at no instant, outside the cell KNOWN_CONTRACT_GAPS declares", () => {
    // The excused cell is R-A/R-B's pure-level twin: "nothing stated, and a
    // `validTo` at or before the write instant". It is withheld by the
    // ARBITRARY rather than by a guard inside the property, for the same reason
    // the database-level restrictions are stated over op shapes — a guard that
    // stopped matching would silently stop asserting.
    fc.assert(
      fc.property(
        fc.oneof(
          // A stated, strictly ordered pair against any write instant. This is
          // where dropping the stated pass-through bites: the write instant is
          // unrelated to the pair and lands past `validTo` roughly half the time.
          orderedPairArb().chain(([validFrom, validTo]) =>
            instantArb().map((writeInstant) => ({
              statedValidFrom: validFrom,
              validTo,
              writeInstant,
            })),
          ),
          // Nothing stated at all.
          instantArb().map((writeInstant) => ({
            statedValidFrom: undefined,
            validTo: undefined,
            writeInstant,
          })),
          // Nothing stated, and a scheduled end strictly after the write instant.
          orderedPairArb().map(([writeInstant, validTo]) => ({
            statedValidFrom: undefined,
            validTo,
            writeInstant,
          })),
        ),
        ({ statedValidFrom, validTo, writeInstant }) => {
          const stored = expectedStoredLowerBound(
            statedValidFrom,
            validTo,
            writeInstant,
          );
          expect(
            intervalIsEmpty(intervalOf({ validFrom: stored, validTo })),
          ).toBe(false);
        },
      ),
      RUNS,
    );
  });
});
