import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runDoctor } from "./doctor";
import {
  neo4jServerVerdict,
  pgGraphServerVerdict,
  postgresServerVerdict,
} from "./external-server-probes";
import {
  EXTERNAL_NEO4J_URL_ENV,
  EXTERNAL_PGGRAPH_URL_ENV,
  EXTERNAL_POSTGRES_URL_ENV,
} from "./external-servers";

// Nothing listens on port 1, so every probe fails fast without a network.
const UNREACHABLE_ENV = {
  [EXTERNAL_POSTGRES_URL_ENV]: "postgresql://u:secret@127.0.0.1:1/db",
  [EXTERNAL_PGGRAPH_URL_ENV]: "postgresql://u:secret@127.0.0.1:1/db",
  [EXTERNAL_NEO4J_URL_ENV]: "bolt://u:secret@127.0.0.1:1",
};

describe("runDoctor with existing servers", () => {
  it("probes each named server instead of requiring Docker, and refuses unreachable ones", async () => {
    const result = await runDoctor({
      engines: ["typegraph-postgres", "neo4j", "pggraph"],
      env: UNREACHABLE_ENV,
    });
    const docker = result.checks.find(
      (check) => check.name === "Docker daemon",
    );
    assert.equal(docker?.required, false);
    const servers = result.checks.filter(
      (check) => check.category === "external-server",
    );
    assert.deepEqual(
      servers.map((check) => [check.name, check.status]),
      [
        [`typegraph-postgres (${EXTERNAL_POSTGRES_URL_ENV})`, "failed"],
        [`neo4j (${EXTERNAL_NEO4J_URL_ENV})`, "failed"],
        [`pggraph (${EXTERNAL_PGGRAPH_URL_ENV})`, "failed"],
      ],
    );
    for (const check of servers) {
      assert.doesNotMatch(check.detail, /secret/);
    }
    assert.equal(result.runnable["typegraph-postgres"], false);
    assert.equal(result.runnable.neo4j, false);
    assert.equal(result.runnable.pggraph, false);
    assert.equal(result.status, "failed");
  });

  it("still requires Docker for a server engine without a URL", async () => {
    const result = await runDoctor({ engines: ["pggraph"], env: {} });
    const docker = result.checks.find(
      (check) => check.name === "Docker daemon",
    );
    assert.equal(docker?.required, true);
    assert.equal(
      result.checks.some((check) => check.category === "external-server"),
      false,
    );
  });
});

describe("external server verdicts", () => {
  it("requires CREATEDB for the TypeGraph/PostgreSQL per-run database", () => {
    assert.equal(
      postgresServerVerdict({ serverVersion: "18.4", canCreateDatabase: true })
        .ok,
      true,
    );
    assert.equal(
      postgresServerVerdict({ serverVersion: "18.4", canCreateDatabase: false })
        .ok,
      false,
    );
  });

  it("requires the graph extension and a superuser for pgGraph", () => {
    assert.equal(
      pgGraphServerVerdict({
        serverVersion: "17.6",
        graphExtensionVersion: "1.2.1",
        superuser: true,
      }).ok,
      true,
    );
    assert.match(
      pgGraphServerVerdict({
        serverVersion: "17.6",
        graphExtensionVersion: undefined,
        superuser: true,
      }).detail,
      /not installed/,
    );
    assert.match(
      pgGraphServerVerdict({
        serverVersion: "17.6",
        graphExtensionVersion: "1.2.1",
        superuser: false,
      }).detail,
      /not a superuser/,
    );
  });

  it("requires Graph Data Science on a Neo4j server", () => {
    assert.equal(
      neo4jServerVerdict({
        version: "2026.10.2",
        edition: "community",
        gdsVersion: "2026.10.2",
      }).ok,
      true,
    );
    assert.equal(
      neo4jServerVerdict({
        version: "2026.10.2",
        edition: "community",
        gdsVersion: undefined,
      }).ok,
      false,
    );
  });
});

describe("runDoctor against this session's PostgreSQL server", () => {
  const sessionServer = process.env["POSTGRES_URL"];
  it(
    "accepts it for typegraph-postgres and refuses it for pggraph without the extension",
    { skip: sessionServer === undefined ? "POSTGRES_URL is not set" : false },
    async () => {
      const result = await runDoctor({
        engines: ["typegraph-postgres", "pggraph"],
        env: {
          [EXTERNAL_POSTGRES_URL_ENV]: sessionServer,
          [EXTERNAL_PGGRAPH_URL_ENV]: sessionServer,
        },
      });
      assert.equal(result.runnable["typegraph-postgres"], true);
      const pggraph = result.checks.find(
        (check) => check.name === `pggraph (${EXTERNAL_PGGRAPH_URL_ENV})`,
      );
      assert.equal(pggraph?.status, "failed");
      assert.equal(result.runnable.pggraph, false);
    },
  );
});
