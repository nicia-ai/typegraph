import { expectType } from "tsd";

import {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
  buildSqliteEdgeIndexBuilders,
  buildSqliteNodeIndexBuilders,
} from "../dist/backend/drizzle/indexes";

expectType<typeof buildPostgresEdgeIndexBuilders>(
  buildPostgresEdgeIndexBuilders,
);
expectType<typeof buildPostgresNodeIndexBuilders>(
  buildPostgresNodeIndexBuilders,
);
expectType<typeof buildSqliteEdgeIndexBuilders>(buildSqliteEdgeIndexBuilders);
expectType<typeof buildSqliteNodeIndexBuilders>(buildSqliteNodeIndexBuilders);
