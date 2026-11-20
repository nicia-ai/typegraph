import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_NEO4J_DATABASE,
  EXTERNAL_NEO4J_DATABASE_ENV,
  EXTERNAL_PGGRAPH_URL_ENV,
  parseNeo4jServerAddress,
  readExternalUrl,
  redactUrl,
} from "./external-servers";

describe("readExternalUrl", () => {
  it("treats unset and blank as the container path and trims a set value", () => {
    assert.equal(readExternalUrl({}, EXTERNAL_PGGRAPH_URL_ENV), undefined);
    assert.equal(
      readExternalUrl(
        { [EXTERNAL_PGGRAPH_URL_ENV]: " " },
        EXTERNAL_PGGRAPH_URL_ENV,
      ),
      undefined,
    );
    assert.equal(
      readExternalUrl(
        { [EXTERNAL_PGGRAPH_URL_ENV]: " postgresql://u:p@h:5432/db " },
        EXTERNAL_PGGRAPH_URL_ENV,
      ),
      "postgresql://u:p@h:5432/db",
    );
  });
});

describe("redactUrl", () => {
  it("replaces the password and keeps everything else", () => {
    assert.equal(
      redactUrl(
        "postgresql://bench:s3cret@db.internal:5432/graph?sslmode=require",
      ),
      "postgresql://bench:***@db.internal:5432/graph?sslmode=require",
    );
    assert.equal(
      redactUrl("bolt://neo4j:s3cret@10.0.0.5:7687"),
      "bolt://neo4j:***@10.0.0.5:7687",
    );
  });

  it("withholds a value that does not parse instead of echoing it", () => {
    assert.equal(redactUrl("user:s3cret@host"), "<unparseable URL withheld>");
  });
});

describe("parseNeo4jServerAddress", () => {
  it("moves URL credentials into a basic-auth token and strips them from the URL", () => {
    const address = parseNeo4jServerAddress(
      "bolt://neo4j:p%40ss%3Aword@10.0.0.5:7687",
      {},
    );
    assert.equal(address.url, "bolt://10.0.0.5:7687");
    assert.deepEqual(address.credentials, {
      username: "neo4j",
      password: "p@ss:word",
    });
    assert.equal(address.database, DEFAULT_NEO4J_DATABASE);
  });

  it("connects without auth when the URL has no userinfo", () => {
    const address = parseNeo4jServerAddress("neo4j+s://graph.example:7687", {});
    assert.equal(address.url, "neo4j+s://graph.example:7687");
    assert.equal(address.credentials, undefined);
  });

  it("takes the database from its own variable", () => {
    assert.equal(
      parseNeo4jServerAddress("bolt://h:7687", {
        [EXTERNAL_NEO4J_DATABASE_ENV]: " snbbench ",
      }).database,
      "snbbench",
    );
  });

  it("refuses a URL that is not bolt or neo4j", () => {
    assert.throws(
      () => parseNeo4jServerAddress("http://h:7474", {}),
      /bolt:\/\/ or neo4j:\/\/ scheme/,
    );
    assert.throws(
      () => parseNeo4jServerAddress("not a url", {}),
      /is not a URL/,
    );
  });
});
