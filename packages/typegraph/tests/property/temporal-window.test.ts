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
 * WHAT IS STATED HERE, AND OVER WHAT.
 * Three owners meet in this file, all in `src/utils/date.ts`:
 * `isInvertedValidityWindow` is the REFUSAL predicate (strict `>`),
 * `isEmptyValidityWindow` the CHOICE predicate (non-strict `>=`), and
 * `resolveStampedValidityLowerBound` the one function every write that stamps a
 * bound its caller did not state decides through. The oracle model's
 * `expectedStoredLowerBound` is a second, independent encoding of that same
 * rule, and the laws below quantify over BOTH, so neither can drift into a
 * contract the other does not hold.
 *
 * The stamping law is TOTAL: no input makes a stamped bound yield a window
 * readable at no instant. It was restricted to the shapes outside the born-ended
 * cell while `KNOWN_CONTRACT_GAPS` still excused that cell; the seam closed it,
 * so the arbitrary draws the whole space and the guard is gone.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isEmptyValidityWindow,
  isInvertedValidityWindow,
  resolveStampedValidityLowerBound,
} from "../../src/utils/date";
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
        const empty = isEmptyValidityWindow(window.validFrom, window.validTo);
        // The refusal predicate implies the choice predicate. It is strictly
        // stronger: the two differ on, and only on, the zero-width boundary.
        expect(!inverted || empty).toBe(true);
        // ...and the library's two predicates say what the model's interval
        // algebra says, which is what lets the database properties ask the model
        // and the write paths ask the library without the two disagreeing.
        expect(empty).toBe(intervalIsEmpty(interval));
        expect(intervalIsInverted(interval)).toBe(inverted);
        expect(empty && !inverted).toBe(
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

/**
 * Both encodings of the stamping rule, so every law below is stated once and
 * checked against each: the library owner every write path calls, and the oracle
 * model's independent restatement the database properties predict with.
 */
const STAMPING_OWNERS = [
  ["resolveStampedValidityLowerBound", resolveStampedValidityLowerBound],
  ["expectedStoredLowerBound", expectedStoredLowerBound],
] as const satisfies readonly (readonly [
  string,
  (
    statedValidFrom: Instant | null | undefined,
    validTo: Instant | undefined,
    writeInstant: Instant,
  ) => Instant | undefined,
])[];

describe.each(STAMPING_OWNERS)(
  "the stored lower bound (%s)",
  (_name, resolve) => {
    it("returns a stated bound verbatim and a stated null as no bound", () => {
      fc.assert(
        fc.property(
          instantArb(),
          optionalInstantArb(),
          instantArb(),
          (statedValidFrom, validTo, writeInstant) => {
            expect(resolve(statedValidFrom, validTo, writeInstant)).toBe(
              statedValidFrom,
            );
            expect(
              resolve(CONFIRMED_OPEN_LEFT, validTo, writeInstant),
            ).toBeUndefined();
          },
        ),
        RUNS,
      );
    });

    it("stamps the write instant it was handed, never a clock it sampled", () => {
      fc.assert(
        fc.property(instantArb(), (writeInstant) => {
          expect(resolve(undefined, undefined, writeInstant)).toBe(
            writeInstant,
          );
        }),
        RUNS,
      );
    });

    it("never yields a window readable at no instant", () => {
      // TOTAL, over the whole input space: the born-ended cell this used to be
      // restricted away from is the one the seam closed, so it is drawn here like
      // any other. `windowArb` covers "nothing stated with a `validTo` at or
      // before the write instant" — including the exact zero-width boundary,
      // which `instantArb` reaches by drawing the same instant twice — and that is
      // the cell a strict `>` comparison inside the rule would fail.
      fc.assert(
        fc.property(
          fc.oneof(optionalInstantArb(), fc.constant(CONFIRMED_OPEN_LEFT)),
          optionalInstantArb(),
          instantArb(),
          (statedValidFrom, validTo, writeInstant) => {
            const stored = resolve(statedValidFrom, validTo, writeInstant);
            // A window the caller STATED in full may legitimately be zero width,
            // and an inverted stated pair is refused above this layer rather than
            // here — so the law binds the cell where the WRITE chose the bound.
            const chosen = statedValidFrom === undefined;
            expect(
              !chosen ||
                !intervalIsEmpty(intervalOf({ validFrom: stored, validTo })),
            ).toBe(true);
          },
        ),
        RUNS,
      );
    });

    it("stamps the write instant exactly when it leaves the window readable somewhere", () => {
      // The boundary itself, stated as an equivalence rather than as an example:
      // a stated end at or before the write instant means no bound, a strictly
      // later one means the instant. `orderedPairArb` supplies the strictly-later
      // half and the shared-instant draw the equal one.
      fc.assert(
        fc.property(
          fc.oneof(
            orderedPairArb().map(([writeInstant, validTo]) => ({
              writeInstant,
              validTo,
            })),
            orderedPairArb().map(([validTo, writeInstant]) => ({
              writeInstant,
              validTo,
            })),
            instantArb().map((instant) => ({
              writeInstant: instant,
              validTo: instant,
            })),
          ),
          ({ writeInstant, validTo }) => {
            expect(resolve(undefined, validTo, writeInstant)).toBe(
              writeInstant < validTo ? writeInstant : undefined,
            );
          },
        ),
        RUNS,
      );
    });
  },
);
