import { describe, expect, it } from "vitest";

import {
  POSTGRES_CONTAINER_NAME,
  renderRegressionBootstrapScript,
} from "../../../src/regression/ec2/bootstrap";

const BASE_OPTIONS = {
  repoUrl: "https://github.com/nicia-ai/typegraph.git",
  ref: "abc123",
  postgresImage: "pgvector/pgvector:pg18",
  deadManSwitchMinutes: 120,
  sshPublicKey: undefined,
} as const;

describe("renderRegressionBootstrapScript", () => {
  it("clones with full history and tags", () => {
    const script = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    expect(script).toContain(
      `git clone "${BASE_OPTIONS.repoUrl}" "/opt/typegraph"`,
    );
    expect(script).not.toContain("--depth");
    expect(script).not.toContain("--single-branch");
  });

  it("refuses a clone that cannot resolve main or a published tag", () => {
    const script = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    expect(script).toContain("git rev-parse --verify main");
    expect(script).toContain(
      "test -n \"$(git tag --list '@nicia-ai/typegraph@*')\"",
    );
  });

  it("checks out the requested ref after cloning", () => {
    const script = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    expect(script).toContain(`git checkout "${BASE_OPTIONS.ref}"`);
  });

  it("starts and health-checks Postgres only for a postgres backend", () => {
    const sqliteOnly = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    const withPostgres = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite", "postgres"],
    });

    expect(sqliteOnly).not.toContain("docker run");
    expect(sqliteOnly).not.toContain(POSTGRES_CONTAINER_NAME);

    expect(withPostgres).toContain(
      `docker run -d --name ${POSTGRES_CONTAINER_NAME}`,
    );
    expect(withPostgres).toContain(BASE_OPTIONS.postgresImage);
    expect(withPostgres).toContain("pg_isready");
    expect(withPostgres).toContain("exit 1");
  });

  it("installs Docker only when the postgres backend is requested", () => {
    const sqliteOnly = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    const withPostgres = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite", "postgres"],
    });
    expect(sqliteOnly).not.toContain("docker-ce docker-ce-cli");
    expect(withPostgres).toContain("docker-ce docker-ce-cli");
  });

  it("installs and builds the workspace, then writes the completion sentinel", () => {
    const script = renderRegressionBootstrapScript({
      ...BASE_OPTIONS,
      backends: ["sqlite"],
    });
    expect(script).toContain("pnpm install --frozen-lockfile");
    expect(script).toContain("pnpm --filter @nicia-ai/typegraph build");
    expect(script).toContain("touch /opt/typegraph-bootstrap-complete");
  });
});
