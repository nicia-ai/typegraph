import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  expr,
  type RelationProjection,
  type Store,
  type TopPerPartitionOptions,
  type TopPerPartitionOrder,
} from "..";

const Document = defineNode("Document", {
  schema: z.object({
    parentId: z.string(),
    score: z.number(),
    publishedAt: z.date().optional(),
    metadata: z.object({ flag: z.boolean() }).optional(),
  }),
});

const graph = defineGraph({
  id: "top-per-partition-types",
  nodes: { Document: { type: Document } },
  edges: {},
});

declare const store: Store<typeof graph>;
const rows = store
  .query()
  .from("Document", "document")
  .project((fields) => ({
    parentId: fields.document.parentId,
    score: fields.document.score,
    publishedAt: fields.document.publishedAt,
    metadata: fields.document.metadata,
  }))
  .asRelation();

const order: TopPerPartitionOrder = {
  expression: expr.literal(1),
  direction: "desc",
  nulls: "last",
};
expectAssignable<TopPerPartitionOrder>(order);

type Columns = Parameters<Parameters<typeof rows.where>[0]>[0];
type Fields = Readonly<{ [Key in keyof Columns]: Columns[Key] }> &
  RelationProjection;
const options: TopPerPartitionOptions<Fields> = {
  partitionBy: (columns) => [columns.parentId],
  orderBy: (columns) => [
    { expression: columns.score, direction: "desc" },
    { expression: columns.parentId },
  ],
  limit: 2,
};
expectAssignable<TopPerPartitionOptions<Fields>>(options);
expectError<TopPerPartitionOptions<Fields>>({
  ...options,
  partitionBy: () => [],
});
expectError<TopPerPartitionOptions<Fields>>({
  ...options,
  orderBy: () => [],
});

const top = rows.topPerPartition({
  partitionBy: (columns) => [columns.parentId],
  orderBy: (columns) => [{ expression: columns.score, direction: "desc" }],
  limit: 2,
});
expectType<
  Promise<
    readonly {
      parentId: string;
      score: number;
      publishedAt: Date | undefined;
      metadata: { flag: boolean } | undefined;
    }[]
  >
>(top.execute());

const offset = expr.param("offset", "number");
const prepared = rows
  .topPerPartition({
    partitionBy: (columns) => [columns.parentId],
    orderBy: (columns) => [{ expression: expr.add(columns.score, offset) }],
    limit: 1,
  })
  .prepare({ offset });
expectType<
  Promise<
    readonly {
      parentId: string;
      score: number;
      publishedAt: Date | undefined;
      metadata: { flag: boolean } | undefined;
    }[]
  >
>(prepared.execute({ offset: 1 }));
expectError(prepared.execute({ offset: "one" }));
expectError(prepared.execute({}));
