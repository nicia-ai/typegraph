/**
 * An attachment names its whole under `whole`, and a typed collection limits
 * `whole.kind` to the whole kinds the graph's ontology declares for that part
 * kind. Where the restriction cannot be proven from the ontology tuple, any
 * node kind of the graph is accepted and the runtime refusal decides.
 */
import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type CompositionWholeKinds,
  type CreateNodeInput,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  type Node,
  type NodeCollection,
  type OntologyRelation,
  partOf,
  type Store,
  type StoreProjection,
  subClassOf,
} from "..";

const Episode = defineNode("Episode", {
  schema: z.object({ title: z.string() }),
});
const Show = defineNode("Show", { schema: z.object({ name: z.string() }) });
const Anthology = defineNode("Anthology", { schema: z.object({}) });
const Album = defineNode("Album", { schema: z.object({}) });
const Track = defineNode("Track", { schema: z.object({}) });
const episodeOf = defineEdge("episodeOf", { schema: z.object({}) });
const collectedIn = defineEdge("collectedIn", { schema: z.object({}) });
const hasTrack = defineEdge("hasTrack", { schema: z.object({}) });

const nodes = {
  Episode: {
    type: Episode,
    unique: [
      {
        name: "episode_title",
        fields: ["title"],
        scope: "kind",
        collation: "binary",
      },
    ],
  },
  Show: { type: Show },
  Anthology: { type: Anthology },
  Album: { type: Album },
  Track: { type: Track },
} as const;
const edges = {
  episodeOf: { type: episodeOf, from: [Episode], to: [Show] },
  collectedIn: { type: collectedIn, from: [Episode], to: [Anthology] },
  hasTrack: { type: hasTrack, from: [Album], to: [Track] },
} as const;

const graph = defineGraph({
  id: "typed-whole",
  nodes,
  edges,
  ontology: [
    partOf(Episode, Show, { via: episodeOf }),
    partOf(Episode, Anthology, { via: collectedIn }),
    hasPart(Album, Track, { via: hasTrack }),
  ],
});

declare const store: Store<typeof graph>;
declare const show: Node<typeof Show>;
declare const album: Node<typeof Album>;
declare const episodeId: Node<typeof Episode>["id"];
declare const trackId: Node<typeof Track>["id"];

// ============================================================
// Declared whole kinds, both declaration directions
// ============================================================

expectType<"Show" | "Anthology">(
  {} as CompositionWholeKinds<typeof graph, "Episode">,
);
expectType<"Album">({} as CompositionWholeKinds<typeof graph, "Track">);
expectType<never>({} as CompositionWholeKinds<typeof graph, "Show">);

store.nodes.Episode.create({ title: "one" }, { partOf: { whole: show } });
store.nodes.Episode.create(
  { title: "one" },
  { partOf: { whole: { kind: "Anthology", id: "anthology" } } },
);
store.nodes.Track.create({}, { partOf: { whole: album } });

expectError(
  store.nodes.Episode.create({ title: "one" }, { partOf: { whole: album } }),
);
expectError(
  store.nodes.Episode.create(
    { title: "one" },
    { partOf: { whole: { kind: "Album", id: "album" } } },
  ),
);
expectError(
  store.nodes.Track.create(
    {},
    { partOf: { whole: { kind: "Show", id: "show" } } },
  ),
);

// A kind that is no declared part accepts no attachment at all.
expectError(
  store.nodes.Show.create(
    { name: "one" },
    { partOf: { whole: { kind: "Anthology", id: "anthology" } } },
  ),
);

// ============================================================
// Every attachment surface carries the same restriction
// ============================================================

store.nodes.Episode.bulkCreate([
  { props: { title: "one" }, partOf: { whole: show } },
]);
expectError(
  store.nodes.Episode.bulkCreate([
    { props: { title: "one" }, partOf: { whole: album } },
  ]),
);

store.nodes.Episode.getOrCreateByConstraint(
  "episode_title",
  { title: "one" },
  { partOf: { whole: show } },
);
expectError(
  store.nodes.Episode.getOrCreateByConstraint(
    "episode_title",
    { title: "one" },
    { partOf: { whole: album } },
  ),
);

store.nodes.Episode.bulkGetOrCreateByConstraint(
  "episode_title",
  [{ props: { title: "one" } }],
  { partOf: { whole: show } },
);
expectError(
  store.nodes.Episode.bulkGetOrCreateByConstraint(
    "episode_title",
    [{ props: { title: "one" } }],
    { partOf: { whole: album } },
  ),
);

store.nodes.Episode.reparent(episodeId, { whole: show });
expectError(store.nodes.Episode.reparent(episodeId, { whole: album }));

store.nodes.Episode.bulkReparent([{ id: episodeId, options: { whole: show } }]);
expectError(
  store.nodes.Episode.bulkReparent([
    { id: episodeId, options: { whole: album } },
  ]),
);

store.nodes.Track.reparent(trackId, { whole: album });

// ============================================================
// The flat form is gone
// ============================================================

expectError(
  store.nodes.Episode.create(
    { title: "one" },
    { partOf: { kind: "Show", id: "show" } },
  ),
);
expectError(
  store.nodes.Episode.reparent(episodeId, { kind: "Show", id: "show" }),
);
expectError<CreateNodeInput<typeof Episode>>({
  kind: "Episode",
  props: { title: "one" },
  partOf: { kind: "Show", id: "show" },
});
expectAssignable<CreateNodeInput<typeof Episode>>({
  kind: "Episode",
  props: { title: "one" },
  partOf: { whole: { kind: "Show", id: "show" } },
});

// ============================================================
// reparent has one instant
// ============================================================

store.nodes.Episode.reparent(episodeId, {
  whole: show,
  at: "2026-01-01T00:00:00.000Z",
});
expectError(
  store.nodes.Episode.reparent(episodeId, {
    whole: show,
    validFrom: "2026-01-01T00:00:00.000Z",
  }),
);
expectError(
  store.nodes.Episode.reparent(episodeId, {
    whole: show,
    validTo: "2027-01-01T00:00:00.000Z",
  }),
);
// Create-time attachments keep the realizing edge's whole window.
store.nodes.Episode.create(
  { title: "one" },
  {
    partOf: {
      whole: show,
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
    },
  },
);

// ============================================================
// Conservative fallbacks: any node kind of the graph
// ============================================================

const Special = defineNode("Special", {
  schema: z.object({ title: z.string() }),
});
const subsumptionGraph = defineGraph({
  id: "typed-whole-subsumption",
  nodes: { ...nodes, Special: { type: Special } },
  edges,
  ontology: [
    partOf(Episode, Show, { via: episodeOf }),
    subClassOf(Special, Episode),
  ],
});
declare const subsumptionStore: Store<typeof subsumptionGraph>;

type SubsumptionKinds = keyof (typeof subsumptionGraph)["nodes"] & string;
expectType<SubsumptionKinds>(
  {} as CompositionWholeKinds<typeof subsumptionGraph, "Special">,
);
expectType<SubsumptionKinds>(
  {} as CompositionWholeKinds<typeof subsumptionGraph, "Episode">,
);
// The subclass inherits its parent's declared whole; the type cannot compute
// that closure, so it must not reject it.
subsumptionStore.nodes.Special.create(
  { title: "one" },
  { partOf: { whole: show } },
);
expectError(
  subsumptionStore.nodes.Special.create(
    { title: "one" },
    { partOf: { whole: { kind: "NotAKind", id: "x" } } },
  ),
);

const erasedOntology: readonly OntologyRelation[] = [
  partOf(Episode, Show, { via: episodeOf }),
];
const erasedGraph = defineGraph({
  id: "typed-whole-erased",
  nodes,
  edges,
  ontology: erasedOntology,
});
declare const erasedStore: Store<typeof erasedGraph>;
expectType<keyof typeof nodes>(
  {} as CompositionWholeKinds<typeof erasedGraph, "Episode">,
);
erasedStore.nodes.Episode.create({ title: "one" }, { partOf: { whole: show } });

// ============================================================
// Dynamic collections and projections
// ============================================================

const dynamicEpisodes = store.getNodeCollection("Episode");
dynamicEpisodes?.create(
  { title: "one" },
  { partOf: { whole: { kind: "AnyRuntimeKind", id: "x" } } },
);

type EpisodeProjection = StoreProjection<typeof graph, "Episode" | "Show">;
expectAssignable<EpisodeProjection>(store);
declare const projection: EpisodeProjection;
projection.nodes.Episode.create({ title: "one" }, { partOf: { whole: show } });
projection.nodes.Episode.reparent(episodeId, { whole: show });
expectError(
  projection.nodes.Episode.create(
    { title: "one" },
    { partOf: { whole: album } },
  ),
);
expectError(projection.nodes.Episode.reparent(episodeId, { whole: album }));

// A collection named with the default whole kinds is not the graph's own: the
// kinds sit in contravariant positions, so it must say which kinds it takes.
expectError<NodeCollection<typeof Episode, "episode_title">>(
  store.nodes.Episode,
);
expectAssignable<
  NodeCollection<
    typeof Episode,
    "episode_title",
    CompositionWholeKinds<typeof graph, "Episode">
  >
>(store.nodes.Episode);
