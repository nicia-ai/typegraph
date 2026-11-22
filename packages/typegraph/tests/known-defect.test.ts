import { describe, expect, it } from "vitest";

import { expectObservation, type KnownDefect } from "./helpers/known-defect";

type Observation = Readonly<{ error: string; rows: readonly string[] }>;

const CORRECT: Observation = { error: "EndpointNotFound", rows: [] };
const TODAY: Observation = { error: "Cardinality", rows: [] };

const ON_SQLITE: KnownDefect<Observation> = {
  label: "#946",
  on: { dialect: ["sqlite"] },
  today: TODAY,
};

const SQLITE_ROOT = { dialect: "sqlite", receiver: "root" } as const;
const POSTGRES_ROOT = { dialect: "postgres", receiver: "root" } as const;

function observe(
  lane: Readonly<Record<string, string>>,
  observed: Observation,
  defects: readonly KnownDefect<Observation>[] = [ON_SQLITE],
): void {
  expectObservation({ lane, observed, correct: CORRECT, defects });
}

describe("expectObservation", () => {
  it("holds a lane no defect covers to the correct value", () => {
    expect(() => {
      observe(POSTGRES_ROOT, CORRECT);
    }).not.toThrow();
    expect(() => {
      observe(POSTGRES_ROOT, TODAY);
    }).toThrow(/correct value on lane \{dialect=postgres, receiver=root\}/u);
  });

  it("holds a covered lane to today's exact value", () => {
    expect(() => {
      observe(SQLITE_ROOT, TODAY);
    }).not.toThrow();
  });

  it("fails a covered lane whose observation became correct, asking for the marker to be flipped", () => {
    expect(() => {
      observe(SQLITE_ROOT, CORRECT);
    }).toThrow(
      /Known defect #946 is fixed on lane \{dialect=sqlite, receiver=root\}.*Defect fixed, flip this marker/su,
    );
  });

  it("fails a covered lane whose observation is neither today's value nor the correct one", () => {
    expect(() => {
      observe(SQLITE_ROOT, { error: "Timeout", rows: [] });
    }).toThrow(/known defect #946 .*today's value changed shape/u);
    expect(() => {
      observe(SQLITE_ROOT, { error: "Cardinality", rows: ["leftover"] });
    }).toThrow(/known defect #946/u);
  });

  it("matches every facet a scope names, and every value of a facet it leaves out", () => {
    const transactionOnly: KnownDefect<Observation> = {
      label: "D2",
      on: { dialect: ["sqlite"], receiver: ["transaction"] },
      today: TODAY,
    };
    expect(() => {
      observe(SQLITE_ROOT, CORRECT, [transactionOnly]);
    }).not.toThrow();
    expect(() => {
      observe({ dialect: "sqlite", receiver: "transaction" }, TODAY, [
        transactionOnly,
      ]);
    }).not.toThrow();
    const everyLane: KnownDefect<Observation> = {
      label: "D1",
      on: {},
      today: TODAY,
    };
    expect(() => {
      observe(POSTGRES_ROOT, TODAY, [everyLane]);
    }).not.toThrow();
  });

  it("refuses a scope naming a facet the lane does not carry", () => {
    expect(() => {
      observe(SQLITE_ROOT, TODAY, [
        { label: "D7", on: { lane: ["PGlite"] }, today: TODAY },
      ]);
    }).toThrow(/scoped on facet "lane", which lane .* does not carry/u);
  });

  it("refuses two defects covering one lane", () => {
    expect(() => {
      observe(SQLITE_ROOT, TODAY, [
        ON_SQLITE,
        { label: "D2", on: {}, today: TODAY },
      ]);
    }).toThrow(/Known defects #946 and D2 both cover lane/u);
  });

  it("refuses a defect whose today value is the correct value", () => {
    expect(() => {
      observe(SQLITE_ROOT, CORRECT, [{ label: "#1", on: {}, today: CORRECT }]);
    }).toThrow(/states a today value equal to the correct value/u);
  });
});
