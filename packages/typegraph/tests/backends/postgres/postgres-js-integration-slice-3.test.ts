import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { registerPostgresJsIntegrationLane } from "./postgres-js-integration-lane";

registerPostgresJsIntegrationLane({
  databaseUrl: await provisionPostgresTestDatabase(import.meta.url),
  slice: { index: 3, count: 4 },
});
