/**
 * Known defects, pinned at the value main produces today.
 *
 * `it.fails` around a whole test body passes on ANY failure — a broken
 * setup, a timeout, an unrelated regression that happens to throw — so it
 * certifies nothing about the defect it names. A test written with this
 * helper instead runs its setup and its other checks as ordinary assertions,
 * and states, for ONE observation, both values:
 *
 *  - `correct`: what the observation should be;
 *  - per known defect, the lanes it affects and the exact value main produces
 *    on them `today`.
 *
 * On an affected lane the observation must equal `today` exactly. If it
 * equals `correct` instead, the test fails with "defect fixed, flip this
 * marker": the fix landed, and the marker has to go so the lane is held to
 * the correct value from then on. Any third value fails as a change in the
 * defect's shape. On every other lane the observation must equal `correct`.
 *
 * A lane is a set of named facets (`{ lane: "SQLite", receiver:
 * "transaction" }`); a defect names, per facet, the values it affects. The
 * helper knows no facet names and no suite types, so any suite can adopt it.
 *
 * @example
 * ```typescript
 * expectObservation({
 *   lane: { dialect: backend.dialect, receiver },
 *   observed: outcome,
 *   correct: { error: "EndpointNotFoundError", rows: [] },
 *   defects: [
 *     {
 *       label: "#946",
 *       on: { dialect: ["sqlite"] },
 *       today: { error: "CardinalityError", rows: [] },
 *     },
 *   ],
 * });
 * ```
 */
import { expect } from "vitest";

/** The facets naming the lane an observation was made on. */
export type LaneFacets = Readonly<Record<string, string>>;

/**
 * Which lanes a defect affects: per facet, the values it affects. A facet the
 * scope leaves out matches every value, so `{}` is every lane.
 */
export type DefectScope = Readonly<Record<string, readonly string[]>>;

/** A defect main has today, on the lanes `on` names. */
export type KnownDefect<TValue> = Readonly<{
  /** The issue (`#946`) or the design-note label (`D2`) that tracks it. */
  label: string;
  on: DefectScope;
  /** The exact value main produces on those lanes today. */
  today: TValue;
}>;

/** Whether `observed` equals `expected` under `toEqual`'s rules. */
function equalsAsToEqual(observed: unknown, expected: unknown): boolean {
  try {
    expect(observed).toEqual(expected);
    return true;
  } catch {
    return false;
  }
}

function renderLane(lane: LaneFacets): string {
  return Object.entries(lane)
    .map(([facet, value]) => `${facet}=${value}`)
    .join(", ");
}

/**
 * Whether `scope` covers `lane`. A facet the scope names but the lane does
 * not carry is a wiring mistake, refused rather than read as "no match" — a
 * silently unmatched scope would hold an affected lane to the correct value
 * and report the defect as absent.
 */
function scopeCovers(
  label: string,
  scope: DefectScope,
  lane: LaneFacets,
): boolean {
  return Object.entries(scope).every(([facet, values]) => {
    const value = lane[facet];
    if (value === undefined) {
      throw new Error(
        `Known defect ${label} is scoped on facet "${facet}", which lane {${renderLane(lane)}} does not carry.`,
      );
    }
    return values.includes(value);
  });
}

/** The one defect that covers `lane`, if any; two is a wiring mistake. */
function defectOnLane<TValue>(
  defects: readonly KnownDefect<TValue>[],
  lane: LaneFacets,
): KnownDefect<TValue> | undefined {
  const covering = defects.filter((defect) =>
    scopeCovers(defect.label, defect.on, lane),
  );
  if (covering.length > 1) {
    throw new Error(
      `Known defects ${covering.map((defect) => defect.label).join(" and ")} both cover lane {${renderLane(lane)}}; ` +
        "state one combined today value under one marker, or narrow their scopes.",
    );
  }
  return covering[0];
}

/**
 * Asserts one observation: `today` of the defect covering `lane`, or
 * `correct` where none does. See the module comment.
 */
export function expectObservation<TValue>(
  params: Readonly<{
    lane: LaneFacets;
    observed: TValue;
    correct: NoInfer<TValue>;
    defects?: readonly KnownDefect<NoInfer<TValue>>[];
  }>,
): void {
  const { lane, observed, correct } = params;
  const defect = defectOnLane(params.defects ?? [], lane);
  if (defect === undefined) {
    expect(observed, `correct value on lane {${renderLane(lane)}}`).toEqual(
      correct,
    );
    return;
  }
  if (equalsAsToEqual(defect.today, correct)) {
    throw new Error(
      `Known defect ${defect.label} states a today value equal to the correct value; a marker must name a difference.`,
    );
  }
  if (equalsAsToEqual(observed, correct)) {
    throw new Error(
      `Known defect ${defect.label} is fixed on lane {${renderLane(lane)}}: the observation now equals the correct value. ` +
        `Defect fixed, flip this marker: remove ${defect.label} from this case, or narrow its scope to the lanes that still produce its today value.`,
    );
  }
  expect(
    observed,
    `known defect ${defect.label} on lane {${renderLane(lane)}}: today's value changed shape, and it is not the correct value either`,
  ).toEqual(defect.today);
}
