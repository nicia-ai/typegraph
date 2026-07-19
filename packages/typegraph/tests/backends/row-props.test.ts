/**
 * Pins the RowProps contract: PostgreSQL drivers hand `jsonb` columns back as
 * already-parsed objects, and the row-mapping layer must carry that object
 * through untouched — no stringify → re-parse round trip per row. SQLite
 * stores JSON as TEXT and must keep rejecting anything else. Consumers
 * normalize at the point of use via rowPropsToObject / rowPropsToJsonText.
 */
import { describe, expect, it } from "vitest";

import {
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  POSTGRES_ROW_MAPPER_CONFIG,
  SQLITE_ROW_MAPPER_CONFIG,
} from "../../src/backend/row-mappers";
import { rowPropsToJsonText, rowPropsToObject } from "../../src/backend/types";
import { DatabaseOperationError } from "../../src/errors";
import { rowToNode } from "../../src/store/row-mappers";

const TIMESTAMP = "2026-07-03T00:00:00.000Z";

function rawNodeRow(props: unknown): Record<string, unknown> {
  return {
    graph_id: "g",
    kind: "Person",
    id: "person-1",
    props,
    version: 1,
    valid_from: TIMESTAMP,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

describe("RowProps mapping", () => {
  describe("postgres mapper", () => {
    const mapNode = createNodeRowMapper(POSTGRES_ROW_MAPPER_CONFIG);

    it("passes driver-parsed jsonb objects through by reference (zero re-serialization)", () => {
      const parsedProps = { name: "Alice", nested: { a: 1, b: [2, 3] } };
      const mapped = mapNode(rawNodeRow(parsedProps));
      expect(mapped.props).toBe(parsedProps);
    });

    it("passes JSON text through unchanged when a driver returns text", () => {
      const jsonText = '{"name":"Alice"}';
      const mapped = mapNode(rawNodeRow(jsonText));
      expect(mapped.props).toBe(jsonText);
    });

    it("keeps schema_doc a JSON string even when jsonb arrives parsed", () => {
      const mapSchema = createSchemaVersionRowMapper(
        POSTGRES_ROW_MAPPER_CONFIG,
      );
      const schemaDocument = { version: 2, nodes: { Person: {} } };
      const mapped = mapSchema({
        graph_id: "g",
        version: 2,
        schema_hash: "hash",
        schema_doc: schemaDocument,
        created_at: TIMESTAMP,
        is_active: true,
      });
      expect(typeof mapped.schema_doc).toBe("string");
      expect(JSON.parse(mapped.schema_doc)).toEqual(schemaDocument);
    });
  });

  describe("sqlite mapper", () => {
    const mapNode = createNodeRowMapper(SQLITE_ROW_MAPPER_CONFIG);

    it("passes TEXT props through unchanged", () => {
      const jsonText = '{"name":"Alice"}';
      const mapped = mapNode(rawNodeRow(jsonText));
      expect(mapped.props).toBe(jsonText);
    });

    it("rejects non-string props — SQLite JSON columns are TEXT", () => {
      expect(() => mapNode(rawNodeRow({ name: "Alice" }))).toThrow(
        DatabaseOperationError,
      );
    });
  });

  describe("point-of-use normalization", () => {
    const objectProps = { name: "Alice", tags: ["x"] };

    it("rowPropsToObject parses strings and passes objects through", () => {
      expect(rowPropsToObject('{"name":"Alice","tags":["x"]}')).toEqual(
        objectProps,
      );
      expect(rowPropsToObject(objectProps)).toBe(objectProps);
    });

    it("rowPropsToJsonText stringifies objects and passes strings through", () => {
      const jsonText = '{"name":"Alice","tags":["x"]}';
      expect(rowPropsToJsonText(jsonText)).toBe(jsonText);
      expect(JSON.parse(rowPropsToJsonText(objectProps))).toEqual(objectProps);
    });

    it("rowToNode produces identical nodes from string and object props", () => {
      const fromObject = rowToNode({
        kind: "Person",
        id: "person-1",
        props: objectProps,
        version: 1,
        valid_from: TIMESTAMP,
        valid_to: undefined,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        deleted_at: undefined,
      });
      const fromString = rowToNode({
        kind: "Person",
        id: "person-1",
        props: JSON.stringify(objectProps),
        version: 1,
        valid_from: TIMESTAMP,
        valid_to: undefined,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        deleted_at: undefined,
      });
      expect(fromObject).toEqual(fromString);
      expect(fromObject["name"]).toBe("Alice");
    });
  });
});
