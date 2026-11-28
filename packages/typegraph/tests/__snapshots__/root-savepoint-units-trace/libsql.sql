savepoint sp0
INSERT INTO "rsu_nodes" ("graph_id", "kind", "id", "props", "version", "valid_from", "valid_to", "created_at", "updated_at") SELECT ?, ?, ?, ?, 1, ?, NULL, ?, ? FROM ( SELECT "rsu_schema_versions"."version" FROM "rsu_schema_versions" WHERE "rsu_schema_versions"."graph_id" = ? AND "rsu_schema_versions"."version" = ? AND "rsu_schema_versions"."is_active" = TRUE ) AS "schema_fence" WHERE TRUE ON CONFLICT ("graph_id", "kind", "id") DO NOTHING RETURNING *
release savepoint sp0
savepoint sp0
INSERT INTO "rsu_nodes" ("graph_id", "kind", "id", "props", "version", "valid_from", "valid_to", "created_at", "updated_at") SELECT ?, ?, ?, ?, 1, ?, NULL, ?, ? FROM ( SELECT "rsu_schema_versions"."version" FROM "rsu_schema_versions" WHERE "rsu_schema_versions"."graph_id" = ? AND "rsu_schema_versions"."version" = ? AND "rsu_schema_versions"."is_active" = TRUE ) AS "schema_fence" WHERE TRUE ON CONFLICT ("graph_id", "kind", "id") DO NOTHING RETURNING *
release savepoint sp0
SELECT * FROM "rsu_nodes" WHERE "rsu_nodes"."graph_id" = ? AND "rsu_nodes"."kind" = ? AND "rsu_nodes"."deleted_at" IS NULL AND ("rsu_nodes"."valid_from" IS NULL OR "rsu_nodes"."valid_from" <= ?) AND ("rsu_nodes"."valid_to" IS NULL OR "rsu_nodes"."valid_to" > ?) ORDER BY "rsu_nodes"."created_at" DESC, "rsu_nodes"."id" DESC
