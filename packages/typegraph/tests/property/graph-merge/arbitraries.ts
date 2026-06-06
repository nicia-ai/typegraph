/**
 * Bounded fast-check arbitraries for the determinism property test (T12).
 *
 * The arbitrary produces a PURE DATA scenario spec — never a live store. The
 * property body materializes it twice (a base + N branches) and merges a natural
 * and a permuted branch order onto two fresh target clones, so the same logical
 * scenario drives both runs with identical node/edge ids (deep-equal is only
 * meaningful when both merges see the SAME ids).
 *
 * The scenario deliberately exercises every order-sensitive merge path the gate
 * must prove commutative:
 *
 *   - DUPLICATE NEW NODES — two branches add patients whose names collide under
 *     the Dice-trigram threshold (`"Anna Rivera"` / `"Ana Rivera"`), so they
 *     cluster into one canonical (pure canonical selection + property union).
 *   - MODIFIED INHERITED PROPS — branches re-set props on a base patient, so the
 *     property union surfaces a cross-branch conflict.
 *   - DELETE/MODIFY — a base patient is DELETED by one branch and MODIFIED by
 *     another on the same scenario (hits T8a).
 *   - COLLAPSING EDGES — each duplicate patient carries an edge; after the
 *     cluster collapses, the edges repoint onto the single canonical and dedupe.
 *   - ONTOLOGY — a cluster mixes `Doctor` and `SpecialistDoctor` so
 *     `reconcileTypes: "ontology"` collapses to the most-specific type.
 */

import fc from "fast-check";

/** A near-duplicate patient-name pair that clears the Dice-trigram 0.85 threshold. */
export type DuplicateNamePair = Readonly<{ left: string; right: string }>;

/**
 * Name pairs chosen so the in-memory Sørensen–Dice trigram scorer rates them
 * STRICTLY ABOVE the demo threshold of 0.85 (they MUST cluster). Each is a real
 * near-duplicate spelling, mirroring the FHIR `"Anna Rivera"` / `"Ana Rivera"`
 * case; the scores below were measured against `diceTrigramSimilarity` so the
 * duplicate pair always produces an entity resolution.
 */
const DUPLICATE_NAME_PAIRS: readonly DuplicateNamePair[] = [
  { left: "Anna Rivera", right: "Ana Rivera" }, // 0.857
  { left: "Catherine Brooks", right: "Katherine Brooks" }, // 0.875
  { left: "Gabriella Stone", right: "Gabriela Stone" }, // 0.897
  { left: "Maximilian Cross", right: "Maximillian Cross" }, // 0.909
];

/** A distinct (non-duplicate) name that must NOT cluster with the duplicate pair. */
const DISTINCT_NAMES: readonly string[] = [
  "Robert Smith",
  "Maria Gonzalez",
  "Wei Chen",
  "Olu Adeyemi",
];

/** Birth dates used to co-block duplicate patients (same date → same block). */
const BIRTH_DATES: readonly string[] = [
  "1974-03-09",
  "1988-11-21",
  "1965-07-02",
  "1991-02-14",
];

/** A doctor-name pair whose two members are added under different kinds. */
const DOCTOR_NAME_PAIRS: readonly DuplicateNamePair[] = [
  { left: "Helen Park", right: "Helen Park" },
  { left: "Marcus Webb", right: "Marcus Webb" },
];

/**
 * The full scenario the property materializes. Every field is pure data; the
 * property body turns it into a base store + branches with concrete ids.
 */
export type DeterminismScenario = Readonly<{
  /**
   * A base patient both branches inherit. One branch DELETES it while the other
   * MODIFIES its `mrn` — a delete/modify conflict (T8a). The boolean chooses
   * which branch deletes (branch 0) vs modifies (branch 1).
   */
  inherited: Readonly<{
    name: string;
    birthDate: string;
    baseMrn: string;
    modifiedMrn: string;
  }>;
  /**
   * The duplicate patient pair: branch 0 adds `pair.left` + an encounter edge,
   * branch 1 adds `pair.right` + a condition edge, both on `birthDate`. They
   * cluster into one canonical; the two edges collapse onto it.
   */
  duplicate: Readonly<{
    pair: DuplicateNamePair;
    birthDate: string;
    leftMrn: string;
    encounterReason: string;
  }>;
  /** A distinct patient one branch adds that must remain its own singleton. */
  distinct: Readonly<{ name: string; birthDate: string }>;
  /**
   * The ontology pair: branch 0 adds the name as a `Doctor`, branch 1 adds the
   * same name as a `SpecialistDoctor`, on a shared block key. They cluster and
   * `reconcileTypes: "ontology"` collapses them to `SpecialistDoctor`.
   */
  ontology: Readonly<{ pair: DuplicateNamePair }>;
}>;

/** A non-empty alphanumeric token usable as an mrn / reason / code value. */
const tokenArb = fc
  .string({ minLength: 3, maxLength: 8, unit: "binary-ascii" })
  .map((value) => value.replaceAll(/[^A-Za-z0-9]/g, "") || "x")
  .map((value) => value.toUpperCase());

/**
 * The bounded scenario arbitrary. Constrained so `numRuns ~ 30` stays fast on
 * both backends (PGlite boots an in-process Postgres per fixture) while still
 * covering the full cross-product of name pairs, birth dates, and value tokens.
 */
export const determinismScenarioArb: fc.Arbitrary<DeterminismScenario> =
  fc.record({
    // `modifiedMrn` is DERIVED from `baseMrn` so it is GUARANTEED distinct — the
    // delete/modify conflict (T8a) only arises if the "modify" actually changes
    // the canonicalized props, so an equal value would silently skip that path.
    inherited: fc
      .record({
        name: fc.constantFrom(...DISTINCT_NAMES),
        birthDate: fc.constantFrom(...BIRTH_DATES),
        baseMrn: tokenArb,
      })
      .map((inherited) => ({
        ...inherited,
        modifiedMrn: `${inherited.baseMrn}-MOD`,
      })),
    duplicate: fc.record({
      pair: fc.constantFrom(...DUPLICATE_NAME_PAIRS),
      birthDate: fc.constantFrom(...BIRTH_DATES),
      leftMrn: tokenArb,
      encounterReason: tokenArb,
    }),
    distinct: fc.record({
      name: fc.constantFrom(...DISTINCT_NAMES),
      birthDate: fc.constantFrom(...BIRTH_DATES),
    }),
    ontology: fc.record({
      pair: fc.constantFrom(...DOCTOR_NAME_PAIRS),
    }),
  });
