/** Physical relation names of one PostgreSQL working-copy allocation. */
import { shortHash } from "../../query/dialect/vector-strategy";
import { sha256Hex } from "../../utils/hash";
import { requireDefined } from "../../utils/presence";
import {
  defaultPostgresTableNames,
  type PostgresTableNames,
} from "./schema/postgres";

const PHYSICAL_PREFIX_LEAD = "tgw_";
const ALLOCATION_DIGEST_BYTES = 12;
const RELATION_SUFFIX_LENGTH = 15;

type RelationKey = keyof PostgresTableNames;

function truncatedSuffix(key: string): string {
  return key.slice(0, RELATION_SUFFIX_LENGTH);
}

function hashedSuffix(key: string): string {
  const hash = shortHash(key);
  const readable = key.slice(0, RELATION_SUFFIX_LENGTH - hash.length - 1);
  return `${readable}_${hash}`;
}

/**
 * One suffix per relation key, distinct across `keys`.
 *
 * A key keeps its leading characters while no other key shares them, which is
 * what every allocation already on disk was named with. Keys that share them
 * are told apart by a hash of the whole key instead. Distinctness is asserted
 * rather than assumed: two relations with one physical name would fail the
 * allocation's `CREATE TABLE` only after its ledger row was written.
 */
export function allocationRelationSuffixes<K extends string>(
  keys: readonly K[],
): ReadonlyMap<K, string> {
  const sharing = new Map<string, number>();
  for (const key of keys) {
    const truncated = truncatedSuffix(key);
    sharing.set(truncated, (sharing.get(truncated) ?? 0) + 1);
  }
  const suffixes = new Map<K, string>();
  const owners = new Map<string, K>();
  for (const key of keys) {
    const truncated = truncatedSuffix(key);
    const suffix = sharing.get(truncated) === 1 ? truncated : hashedSuffix(key);
    const owner = owners.get(suffix);
    if (owner !== undefined) {
      throw new Error(
        `Working-copy relations "${owner}" and "${key}" resolve to the same physical suffix "${suffix}".`,
      );
    }
    owners.set(suffix, key);
    suffixes.set(key, suffix);
  }
  return suffixes;
}

const RELATION_SUFFIXES = allocationRelationSuffixes(
  Object.keys(defaultPostgresTableNames) as RelationKey[],
);

/** The ledger-reserved prefix every relation of `allocationId` is named under. */
async function allocationPhysicalPrefixFor(
  allocationId: string,
): Promise<string> {
  const digest = await sha256Hex(allocationId, ALLOCATION_DIGEST_BYTES);
  return `${PHYSICAL_PREFIX_LEAD}${digest}_`;
}

export async function allocationNames(
  allocationId: string,
): Promise<PostgresTableNames> {
  const prefix = await allocationPhysicalPrefixFor(allocationId);
  return Object.fromEntries(
    [...RELATION_SUFFIXES].map(([key, suffix]) => [key, `${prefix}${suffix}`]),
  ) as PostgresTableNames;
}

/** Recovers the allocation prefix from the names {@link allocationNames} built. */
export function allocationPhysicalPrefix(names: PostgresTableNames): string {
  const nodesSuffix = requireDefined(RELATION_SUFFIXES.get("nodes"));
  return names.nodes.slice(0, -nodesSuffix.length);
}
