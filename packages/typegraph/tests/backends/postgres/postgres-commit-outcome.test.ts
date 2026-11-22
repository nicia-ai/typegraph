/**
 * Server-driver wiring of the commit-outcome check (node-postgres and
 * postgres-js). The cases live in `commit-outcome-wiring.ts`.
 */
import { describe } from "vitest";

import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  nodePostgresFixture,
  postgresJsFixture,
  registerCommitOutcomeWiringTests,
} from "./commit-outcome-wiring";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

describe.runIf(process.env["POSTGRES_URL"])("server drivers", () => {
  registerCommitOutcomeWiringTests(nodePostgresFixture(TEST_DATABASE_URL));
  registerCommitOutcomeWiringTests(postgresJsFixture(TEST_DATABASE_URL));
});
