import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { registerPostgresJsIntegrationLane } from "./postgres-js-integration-lane";

registerPostgresJsIntegrationLane({
  databaseUrl: await provisionPostgresTestDatabase(import.meta.url),
  slice: { index: 1, count: 4 },
});
