import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { registerPostgresIntegrationLane } from "./postgres-integration-lane";

registerPostgresIntegrationLane({
  databaseUrl: await provisionPostgresTestDatabase(import.meta.url),
  slice: { index: 3, count: 4 },
});
