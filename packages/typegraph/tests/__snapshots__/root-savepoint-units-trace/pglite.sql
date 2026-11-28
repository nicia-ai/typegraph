savepoint sp1
INSERT INTO "rsu_nodes" ("graph_id", "kind", "id", "props", "version", "valid_from", "valid_to", "created_at", "updated_at") SELECT $1, $2, $3, $4, 1, $5, NULL, $6, $7 FROM ( SELECT "rsu_schema_versions"."version" FROM "rsu_schema_versions" WHERE "rsu_schema_versions"."graph_id" = $8 AND "rsu_schema_versions"."version" = $9 AND "rsu_schema_versions"."is_active" = TRUE FOR SHARE ) AS "schema_fence" WHERE TRUE ON CONFLICT ("graph_id", "kind", "id") DO NOTHING RETURNING *
release savepoint sp1
savepoint sp1
INSERT INTO "rsu_nodes" ("graph_id", "kind", "id", "props", "version", "valid_from", "valid_to", "created_at", "updated_at") SELECT $1, $2, $3, $4, 1, $5, NULL, $6, $7 FROM ( SELECT "rsu_schema_versions"."version" FROM "rsu_schema_versions" WHERE "rsu_schema_versions"."graph_id" = $8 AND "rsu_schema_versions"."version" = $9 AND "rsu_schema_versions"."is_active" = TRUE FOR SHARE ) AS "schema_fence" WHERE TRUE ON CONFLICT ("graph_id", "kind", "id") DO NOTHING RETURNING *
release savepoint sp1
SELECT * FROM "rsu_nodes" WHERE "rsu_nodes"."graph_id" = $1 AND "rsu_nodes"."kind" = $2 AND "rsu_nodes"."deleted_at" IS NULL AND ("rsu_nodes"."valid_from" IS NULL OR "rsu_nodes"."valid_from" <= $3) AND ("rsu_nodes"."valid_to" IS NULL OR "rsu_nodes"."valid_to" > $4) ORDER BY "rsu_nodes"."created_at" DESC, "rsu_nodes"."id" DESC
