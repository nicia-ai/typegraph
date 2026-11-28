/**
 * A query expression's date decodes by the leaf its origin names: a date the
 * caller stated (a literal or parameter, or a composition of only those) as
 * the `Date` stated, and stored property text by the strict stored leaf
 * (portable text only). The decoded inputs here are the values an engine
 * returns, so every leaf choice is checked on text the two leaves disagree on:
 * a year-0000 instant, which `Date` holds and portable storage does not.
 */
import { describe, expect, it } from "vitest";

import { expr } from "../src";
import { decodeExpressionValue } from "../src/query/builder/executable-projection-query";
import { resultDateOrigin } from "../src/query/compiler/typed-json-extract";
import { createFieldExpression } from "../src/query/expressions";
import { jsonPointer } from "../src/query/json-pointer";
import { fieldRef } from "../src/query/predicates";
import {
  decodeEngineTimestamp,
  decodeStatedDate,
} from "../src/store/stored-date-revival";

const YEAR_ZERO_TEXT = "0000-06-01T00:00:00.000Z";
const YEAR_ZERO = new Date(YEAR_ZERO_TEXT);

const scope = Symbol("date origin test scope");

function storedDate() {
  return createFieldExpression<Date, "d">(
    fieldRef("d", ["props"], {
      jsonPointer: jsonPointer(["at"]),
      valueType: "date",
    }),
    scope,
    true,
  );
}

function storedTitle() {
  return createFieldExpression<string, "d">(
    fieldRef("d", ["props"], {
      jsonPointer: jsonPointer(["title"]),
      valueType: "string",
    }),
    scope,
    false,
  );
}

const ORDER = { orderBy: [{ expression: storedTitle() }] } as const;

describe("a query expression's date decodes by its origin", () => {
  it("decodes a stated scalar date as the Date stated and a stored one as portable text only", () => {
    const decoded = {
      literal: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.literal(new Date(YEAR_ZERO)),
        "sqlite",
      ),
      parameter: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.param("at", "date"),
        "sqlite",
      ),
      statedCoalesce: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.coalesce(expr.param("at", "date"), expr.literal(YEAR_ZERO)),
        "sqlite",
      ),
      statedExtreme: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.max(expr.literal(YEAR_ZERO)),
        "sqlite",
      ),
      stored: decodeExpressionValue(YEAR_ZERO_TEXT, storedDate(), "sqlite"),
      mixedCoalesce: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.coalesce(storedDate(), expr.literal(YEAR_ZERO)),
        "sqlite",
      ),
      storedExtreme: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.min(storedDate()),
        "sqlite",
      ),
    };
    expect(decoded).toEqual({
      literal: YEAR_ZERO,
      parameter: YEAR_ZERO,
      statedCoalesce: YEAR_ZERO,
      statedExtreme: YEAR_ZERO,
      stored: YEAR_ZERO_TEXT,
      mixedCoalesce: YEAR_ZERO_TEXT,
      storedExtreme: YEAR_ZERO_TEXT,
    });
  });

  it("decodes collected elements and record fields by the origin of the expression collected", () => {
    const collectedText = `["${YEAR_ZERO_TEXT}",null]`;
    expect({
      stated: decodeExpressionValue(
        collectedText,
        expr.collect(expr.literal(YEAR_ZERO), ORDER),
        "sqlite",
      ),
      stored: decodeExpressionValue(
        collectedText,
        expr.collect(storedDate(), ORDER),
        "sqlite",
      ),
    }).toEqual({
      stated: [YEAR_ZERO, undefined],
      stored: [YEAR_ZERO_TEXT, undefined],
    });

    const records = expr.collect(
      { stated: expr.literal(YEAR_ZERO), stored: storedDate() },
      ORDER,
    );
    expect(
      decodeExpressionValue(
        JSON.stringify([{ stated: YEAR_ZERO_TEXT, stored: YEAR_ZERO_TEXT }]),
        records,
        "sqlite",
      ),
    ).toEqual([{ stated: YEAR_ZERO, stored: YEAR_ZERO_TEXT }]);
  });

  it("a stated date's leaf accepts any valid instant and never produces an Invalid Date", () => {
    expect([
      decodeStatedDate(YEAR_ZERO_TEXT),
      decodeStatedDate(YEAR_ZERO.getTime()),
      decodeStatedDate(YEAR_ZERO),
      decodeStatedDate("not a date"),
      decodeStatedDate(true),
    ]).toEqual([YEAR_ZERO, YEAR_ZERO, YEAR_ZERO, "not a date", true]);
  });
});

describe("a date column the compiler cast to an engine timestamp decodes as an engine timestamp", () => {
  const INSTANT = new Date("2024-01-02T03:04:05.678Z");
  // What postgres-js hands back for a `timestamptz` column, in two session zones.
  const UTC_ENGINE_TEXT = "2024-01-02 03:04:05.678+00";
  const KOLKATA_ENGINE_TEXT = "2024-01-02 08:34:05.678+05:30";

  it("types every non-stated scalar date column by the dialect's extraction, and a stated one as stated", () => {
    expect({
      postgresStored: resultDateOrigin(undefined, "postgres"),
      postgresStated: resultDateOrigin("stated", "postgres"),
      sqliteStored: resultDateOrigin(undefined, "sqlite"),
      sqliteStated: resultDateOrigin("stated", "sqlite"),
    }).toEqual({
      postgresStored: "engine",
      postgresStated: "stated",
      sqliteStored: undefined,
      sqliteStated: "stated",
    });
  });

  it("reads the instant of the engine's offset-bearing text or a Date in every scalar shape", () => {
    expect({
      utc: decodeExpressionValue(UTC_ENGINE_TEXT, storedDate(), "postgres"),
      kolkata: decodeExpressionValue(
        KOLKATA_ENGINE_TEXT,
        storedDate(),
        "postgres",
      ),
      driverDate: decodeExpressionValue(INSTANT, storedDate(), "postgres"),
      extreme: decodeExpressionValue(
        KOLKATA_ENGINE_TEXT,
        expr.max(storedDate()),
        "postgres",
      ),
      mixedCoalesce: decodeExpressionValue(
        KOLKATA_ENGINE_TEXT,
        expr.coalesce(storedDate(), expr.literal(INSTANT)),
        "postgres",
      ),
    }).toEqual({
      utc: INSTANT,
      kolkata: INSTANT,
      driverDate: INSTANT,
      extreme: INSTANT,
      mixedCoalesce: INSTANT,
    });
  });

  it("leaves text without an offset, and the same text on SQLite, under the strict stored leaf", () => {
    expect({
      zoneless: decodeExpressionValue(
        "2024-01-02 03:04:05.678",
        storedDate(),
        "postgres",
      ),
      dateOnly: decodeExpressionValue("2024-01-02", storedDate(), "postgres"),
      sqliteOffsetText: decodeExpressionValue(
        KOLKATA_ENGINE_TEXT,
        storedDate(),
        "sqlite",
      ),
      engineLeafZoneless: decodeEngineTimestamp("2024-01-02 03:04:05.678"),
      engineLeafCanonical: decodeEngineTimestamp(INSTANT.toISOString()),
    }).toEqual({
      zoneless: "2024-01-02 03:04:05.678",
      dateOnly: "2024-01-02",
      sqliteOffsetText: KOLKATA_ENGINE_TEXT,
      engineLeafZoneless: "2024-01-02 03:04:05.678",
      engineLeafCanonical: INSTANT,
    });
  });

  it("keeps collected elements, which the compiler built into JSON, under their expression's origin", () => {
    expect(
      decodeExpressionValue(
        JSON.stringify([KOLKATA_ENGINE_TEXT]),
        expr.collect(storedDate(), ORDER),
        "postgres",
      ),
    ).toEqual([KOLKATA_ENGINE_TEXT]);
  });
});
