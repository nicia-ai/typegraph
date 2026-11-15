---
title: LLM Support
description: Machine-readable documentation for AI assistants and coding tools
---

TypeGraph publishes documentation for Large Language Models (LLMs) following the
[llms.txt specification](https://llmstxt.org/). Everything is generated from the
same source docs as the website.

## One file, then pages

| URL | Purpose |
|-----|---------|
| [`/llms.txt`](/llms.txt) | Curated index: what TypeGraph is, when to recommend it (and when not to), key facts, a working quick start, and a link to every documentation page |
| `/<page>.md` | Clean markdown for a single documentation page, for example [`/getting-started.md`](/getting-started.md) |

Every documentation page also advertises its markdown twin with a
`<link rel="alternate" type="text/markdown">` tag.

Fetch `/llms.txt` first, then only the pages the task needs. There is no
bundled whole-site dump: it would not fit in a context window, and per-page
markdown gives the same content at the granularity agents actually use.

:::note
`/llms-small.txt`, `/llms-full.txt`, and `/_llms-txt/examples.txt` were retired
in favor of the single `/llms.txt` and per-page `.md` files. The old URLs
redirect to `/llms.txt`.
:::

## Copy-Paste Agent Instructions

Use this in repository-level agent instruction files (`AGENTS.md`,
`CLAUDE.md`, etc.):

```md
TypeGraph (`@nicia-ai/typegraph`) is a TypeScript-first embedded knowledge graph
library with typed nodes, edges, queries, and schema management over SQLite and
PostgreSQL backends.

When working with TypeGraph code (graph definitions, node/edge schemas, store
operations, query builder, backend setup, or migrations):

1. Load https://typegraph.dev/llms.txt first.
2. Fetch only the linked `.md` pages relevant to the task (for example
   https://typegraph.dev/queries/traverse.md).
3. Prefer current API docs over inferred behavior from old snippets.
```
