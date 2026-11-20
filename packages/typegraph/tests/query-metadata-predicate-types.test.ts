/**
 * The `$meta` namespace of predicate accessors (`whereNode` / `whereEdge`)
 * and of the expression context: which metadata fields each alias exposes,
 * with which operators, and that a declared property of the same name is
 * never shadowed.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { ConfigurationError } from "../src/errors";
import { createQueryBuilder } from "../src/query";
import type { ComparisonPredicate, ParameterRef } from "../src/query/ast";
import type {
  DateFieldAccessor,
  EdgeAccessor,
  EdgeMetadataAccessor,
  NodeAccessor,
  NodeMetadataAccessor,
  NumberFieldAccessor,
  StringFieldAccessor,
} from "../src/query/builder/types";
import { buildKindRegistry } from "../src/registry";

/** A kind whose own properties reuse metadata names. */
const Release = defineNode("Release", {
  schema: z.object({
    title: z.string(),
    version: z.string(),
    createdAt: z.string(),
  }),
});
const supersedes = defineEdge("supersedes", {
  schema: z.object({ version: z.number() }),
});

const graph = defineGraph({
  id: "query_metadata_predicate_types",
  nodes: { Release: { type: Release } },
  edges: { supersedes: { type: supersedes, from: [Release], to: [Release] } },
});
const registry = buildKindRegistry(graph);

function query() {
  return createQueryBuilder<typeof graph>(graph.id, registry);
}

/** The `ConfigurationError` `build` throws. */
function refusal(build: () => unknown): ConfigurationError {
  try {
    build();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected a metadata refusal");
}

describe("predicate accessor $meta", () => {
  it("types node metadata: timestamps as dates, version as a number", () => {
    type ReleaseAccessor = NodeAccessor<typeof Release>;
    expectTypeOf<
      ReleaseAccessor["$meta"]
    >().toEqualTypeOf<NodeMetadataAccessor>();
    expectTypeOf<
      NodeMetadataAccessor["version"]
    >().toEqualTypeOf<NumberFieldAccessor>();
    expectTypeOf<
      NodeMetadataAccessor["createdAt"]
    >().toEqualTypeOf<DateFieldAccessor>();
    expectTypeOf<
      NodeMetadataAccessor["updatedAt"]
    >().toEqualTypeOf<DateFieldAccessor>();
    expectTypeOf<
      NodeMetadataAccessor["validFrom"]
    >().toEqualTypeOf<DateFieldAccessor>();
    expectTypeOf<
      NodeMetadataAccessor["validTo"]
    >().toEqualTypeOf<DateFieldAccessor>();
    expectTypeOf<
      NodeMetadataAccessor["deletedAt"]
    >().toEqualTypeOf<DateFieldAccessor>();
    expectTypeOf<NodeMetadataAccessor["version"]["gt"]>()
      .parameter(0)
      .toEqualTypeOf<number | ParameterRef>();
    expectTypeOf<NodeMetadataAccessor["version"]>().toHaveProperty("in");
    expectTypeOf<NodeMetadataAccessor["createdAt"]>().toHaveProperty("between");
    expectTypeOf<NodeMetadataAccessor["createdAt"]>().toHaveProperty(
      "isNotNull",
    );
    expectTypeOf<NodeMetadataAccessor["createdAt"]>().not.toHaveProperty(
      "contains",
    );
  });

  it("puts metadata only under $meta, leaving same-named properties as properties", () => {
    type ReleaseAccessor = NodeAccessor<typeof Release>;
    expectTypeOf<ReleaseAccessor>().not.toHaveProperty("deletedAt");
    expectTypeOf<ReleaseAccessor>().not.toHaveProperty("updatedAt");
    expectTypeOf<
      ReleaseAccessor["version"]
    >().toEqualTypeOf<StringFieldAccessor>();
    expectTypeOf<
      ReleaseAccessor["createdAt"]
    >().toEqualTypeOf<StringFieldAccessor>();

    const ast = query()
      .from("Release", "r")
      .whereNode("r", (r) => r.$meta.version.gte(2).and(r.version.eq("2.0")))
      .select((ctx) => ctx.r.title)
      .toAst();
    const conjunction = ast.predicates[0]?.expression;
    expect(conjunction?.__type).toBe("and");
    const [metadata, property] = (
      conjunction as { predicates: readonly ComparisonPredicate[] }
    ).predicates;
    expect(metadata?.left).toMatchObject({ path: ["version"] });
    expect(property?.left).toMatchObject({
      path: ["props"],
      jsonPointer: "/version",
    });
  });

  it("types edge metadata without a version", () => {
    type LinkAccessor = EdgeAccessor<typeof supersedes>;
    expectTypeOf<LinkAccessor["$meta"]>().toEqualTypeOf<EdgeMetadataAccessor>();
    expectTypeOf<EdgeMetadataAccessor>().not.toHaveProperty("version");
    expectTypeOf<
      EdgeMetadataAccessor["validTo"]
    >().toEqualTypeOf<DateFieldAccessor>();
    expectTypeOf<
      LinkAccessor["version"]
    >().toEqualTypeOf<NumberFieldAccessor>();
  });

  it("refuses a metadata name the alias does not store", () => {
    const edgeVersion = refusal(() =>
      query()
        .from("Release", "newer")
        .traverse("supersedes", "link")
        .whereEdge("link", (link) =>
          (link.$meta as unknown as NodeMetadataAccessor).version.eq(1),
        ),
    );
    expect(edgeVersion.details).toMatchObject({
      code: "METADATA_FIELD_UNKNOWN",
      alias: "link",
      field: "version",
    });

    const unknownName = refusal(() =>
      query()
        .from("Release", "r")
        .whereNode("r", (r) =>
          (
            r.$meta as unknown as Readonly<{ revision: NumberFieldAccessor }>
          ).revision.eq(1),
        ),
    );
    expect(unknownName.details).toMatchObject({
      code: "METADATA_FIELD_UNKNOWN",
      field: "revision",
    });
  });
});

describe("expression context $meta", () => {
  it("exposes version on node aliases only", () => {
    const projected = query()
      .from("Release", "newer")
      .optionalTraverse("supersedes", "link")
      .to("Release", "older")
      .project((expressions) => {
        expectTypeOf(expressions.link.$meta).not.toHaveProperty("version");
        return {
          newerVersion: expressions.newer.$meta.version,
          olderVersion: expressions.older.$meta.version,
          linkVersion: expressions.link.version,
        };
      });
    type Row = Awaited<ReturnType<typeof projected.execute>>[number];
    void projected;
    expectTypeOf<Row>().toEqualTypeOf<{
      newerVersion: number;
      olderVersion: number | undefined;
      linkVersion: number | undefined;
    }>();
  });

  it("refuses version on an edge alias at runtime", () => {
    const edgeVersion = refusal(() =>
      query()
        .from("Release", "newer")
        .traverse("supersedes", "link")
        .to("Release", "older")
        .project((expressions) => ({
          version: (
            expressions.link.$meta as unknown as typeof expressions.newer.$meta
          ).version,
        })),
    );
    expect(edgeVersion.details).toMatchObject({
      code: "METADATA_FIELD_UNKNOWN",
      alias: "link",
      field: "version",
    });
  });
});
