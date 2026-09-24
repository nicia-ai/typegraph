import { describe, expect, it, vi } from "vitest";

import type { CreateBaseSchemaMembersDeps } from "../src/backend/drizzle/engine/members/base-schema-members";
import { createBaseSchemaMembers } from "../src/backend/drizzle/engine/members/base-schema-members";
import {
  createIdentityMembers,
  type CreateIdentityMembersDeps,
} from "../src/backend/drizzle/engine/members/identity-members";
import { ConfigurationError } from "../src/errors";

describe("engine member dependency compatibility", () => {
  it("accepts legacy base-schema deps and refuses version-4 adoption without journal DDL", async () => {
    const ensureTable = vi.fn((_ddl: string): Promise<void> =>
      Promise.resolve(),
    );
    const deps: CreateBaseSchemaMembersDeps = {
      baseSchemaVersionsTableDdl: "CREATE TABLE versions",
      ensureTable,
      executeDdl: (_ddl: string): Promise<void> => Promise.resolve(),
      generateDdl: () => [],
      readVersion: () => Promise.resolve(3),
      writeVersion: (version) => Promise.resolve(version),
      ensureGraphTemplatesTable: () => Promise.resolve(),
      fencesTableDdl: "CREATE TABLE fences",
      ensureEdgeMatchIdentityStorage: () => Promise.resolve(),
      sinceIndexDdl: [],
    };
    const members = createBaseSchemaMembers(deps);

    await expect(members.adoptBaseSchema()).rejects.toThrow(ConfigurationError);
    expect(ensureTable).not.toHaveBeenCalled();
  });

  it("accepts legacy identity deps and refuses journal setup before partial DDL", async () => {
    const ensureTable = vi.fn((_ddl: string): Promise<void> =>
      Promise.resolve(),
    );
    const deps: CreateIdentityMembersDeps = {
      revisionOriginsTableDdl: "CREATE TABLE origins",
      ensureTable,
      contributionTableExists: () => Promise.resolve(true),
      contributionsForTableNames: () => [],
    };
    const members = createIdentityMembers(deps);

    await expect(members.ensureRevisionChangesJournal()).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      details: {
        missingDependencies: [
          "revisionChangesTableDdl",
          "revisionChangesTriggerDdl",
          "executeDdl",
        ],
      },
    });
    expect(ensureTable).not.toHaveBeenCalled();
  });
});
