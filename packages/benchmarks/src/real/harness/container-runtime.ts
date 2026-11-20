/**
 * Container-runtime steps shared by the imperative-container engine drivers,
 * written to behave the same under Docker and under Podman's Docker-compatible
 * CLI (a `docker` alias or the podman-docker shim), whose semantics differ in
 * ways that only show up at run time:
 *
 * - `volume create <existing name>` succeeds on Docker but exits 125 on
 *   Podman, so a volume is created only after `volume inspect` says it is
 *   absent, and each driver creates it exactly once, before its first use.
 * - `info` reports host memory as `{{.MemTotal}}` on Docker and
 *   `{{.Host.MemTotal}}` on Podman.
 * - A container that has stopped reads `exited` (or `dead`) on Docker and
 *   may read `stopped` on Podman.
 * - Removing a container or volume that does not exist is an error on both,
 *   so teardown checks for the object first and is safe to repeat.
 */
import { spawnCapture } from "./process";

/** Runs one `docker <args>` command, resolving stdout; rejects on non-zero exit. */
export type ContainerRuntime = (args: readonly string[]) => Promise<string>;

/** The `docker` CLI on PATH (Docker, or Podman behind a `docker` alias). */
export function dockerCli(args: readonly string[]): Promise<string> {
  return spawnCapture("docker", args);
}

async function succeeds(
  runtime: ContainerRuntime,
  args: readonly string[],
): Promise<boolean> {
  try {
    await runtime(args);
    return true;
  } catch {
    return false;
  }
}

function volumeExists(
  runtime: ContainerRuntime,
  name: string,
): Promise<boolean> {
  return succeeds(runtime, ["volume", "inspect", name]);
}

function containerExists(
  runtime: ContainerRuntime,
  name: string,
): Promise<boolean> {
  return succeeds(runtime, ["container", "inspect", name]);
}

/** Creates the named volume unless it already exists. */
export async function ensureNamedVolume(
  runtime: ContainerRuntime,
  name: string,
): Promise<void> {
  if (await volumeExists(runtime, name)) return;
  await runtime(["volume", "create", name]);
}

/**
 * Removes a container if it exists. `anonymousVolumes` also removes the
 * anonymous volumes its image declares (`rm -v`), which otherwise outlive it.
 */
export async function removeContainerIfPresent(
  runtime: ContainerRuntime,
  name: string,
  options: Readonly<{ anonymousVolumes: boolean }>,
): Promise<void> {
  if (!(await containerExists(runtime, name))) return;
  await runtime([
    "rm",
    "-f",
    ...(options.anonymousVolumes ? ["-v"] : []),
    name,
  ]);
}

/** Removes a named volume if it exists. Remove its containers first. */
export async function removeVolumeIfPresent(
  runtime: ContainerRuntime,
  name: string,
): Promise<void> {
  if (!(await volumeExists(runtime, name))) return;
  await runtime(["volume", "rm", name]);
}

/** Container states after which a container will not accept connections. */
const STOPPED_CONTAINER_STATES: ReadonlySet<string> = new Set([
  "exited",
  "dead",
  "stopped",
]);

export function isStoppedContainerState(state: string): boolean {
  return STOPPED_CONTAINER_STATES.has(state);
}

/** `inspect` arguments printing a container's state (`running`, `exited`, ...). */
export function containerStateArgs(name: string): readonly string[] {
  return ["inspect", "--type", "container", "-f", "{{.State.Status}}", name];
}

/** Docker's then Podman's `info` template for the memory the runtime sees. */
const MEMORY_TOTAL_TEMPLATES = ["{{.MemTotal}}", "{{.Host.MemTotal}}"] as const;

/**
 * Bytes of memory visible to the container runtime, or `undefined` when
 * neither the Docker nor the Podman `info` shape yields a positive number.
 */
export async function runtimeMemoryBytes(
  runtime: ContainerRuntime,
): Promise<number | undefined> {
  for (const template of MEMORY_TOTAL_TEMPLATES) {
    try {
      const bytes = Number(
        (await runtime(["info", "--format", template])).trim(),
      );
      if (Number.isFinite(bytes) && bytes > 0) return bytes;
    } catch {
      // Try the other runtime's template.
    }
  }
  return undefined;
}
