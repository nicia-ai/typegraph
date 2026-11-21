/**
 * The id minting the write-shape golden substitutes for `nanoid`.
 *
 * Each golden test file mocks `nanoid` with {@link traceIds}`.next`; the
 * scenarios restart minting per trace, so a trace's generated ids depend only
 * on its own name. This module imports nothing, so a `vi.mock` factory can
 * load it without loading the module it mocks.
 */
let namespace = "t00000000";
let issued = 0;
let occupied: string | undefined;

export const traceIds = {
  /** Restarts id minting in a namespace owned by one trace. */
  begin(traceNamespace: string): void {
    namespace = traceNamespace;
    issued = 0;
    occupied = undefined;
  },
  /** Makes the next mint hand out `id`, an id a seed row already holds. */
  occupyNextMint(id: string): void {
    occupied = id;
  },
  /** The occupied id `occupyNextMint` armed and no mint has handed out. */
  pendingOccupiedMint(): string | undefined {
    return occupied;
  },
  next(): string {
    if (occupied !== undefined) {
      const id = occupied;
      occupied = undefined;
      return id;
    }
    issued += 1;
    return `${namespace}n${String(issued).padStart(4, "0")}`;
  },
} as const;
