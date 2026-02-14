---
title: LLM Support
description: Machine-readable documentation for AI assistants and coding tools
---

TypeGraph documentation is available in formats optimized for Large Language
Models (LLMs) following the [llms.txt specification](https://llmstxt.org/). All
files are generated from the same source docs as the website.

## Recommended Retrieval Order

For coding agents, use these files progressively:

1. Start with [`/llms-small.txt`](/llms-small.txt) for implementation and debugging tasks.
2. Use [`/llms-full.txt`](/llms-full.txt) only when you need deep reference content.
3. Load [`/_llms-txt/examples.txt`](/_llms-txt/examples.txt) only when you need full end-to-end patterns.

## Available Files

| File | Purpose | Size |
|------|---------|------|
| [`/llms.txt`](/llms.txt) | Index with page titles, descriptions, and links | Small |
| [`/llms-small.txt`](/llms-small.txt) | Core docs for implementation and debugging tasks | Medium |
| [`/llms-full.txt`](/llms-full.txt) | Complete documentation in a single file | Large |
| [`/_llms-txt/examples.txt`](/_llms-txt/examples.txt) | Complete application examples | Medium |

## Copy-Paste Agent Instructions

Use this in repository-level agent instruction files (`AGENTS.md`,
`CLAUDE.md`, etc.):

```md
TypeGraph (`@nicia-ai/typegraph`) is a TypeScript-first embedded knowledge graph
library with typed nodes, edges, queries, and schema management over SQLite and
PostgreSQL backends.

When working with TypeGraph code (graph definitions, node/edge schemas, store
operations, query builder, backend setup, or migrations):

1. Load https://typegraph.dev/llms-small.txt first.
2. Use https://typegraph.dev/llms-full.txt only for deep API/reference lookup.
3. Load https://typegraph.dev/_llms-txt/examples.txt only for end-to-end implementation patterns.
4. Prefer current API docs over inferred behavior from old snippets.
```
