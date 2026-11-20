/**
 * Test support: an in-memory container runtime for the command-sequence
 * tests of `./container-runtime.ts` and the Neo4j container path.
 */
import { type ContainerRuntime } from "./container-runtime";

/**
 * A runtime with Podman's semantics where they differ from Docker's: creating
 * a volume that exists, or removing a container or volume that does not,
 * exits 125. `run -v <name>:...` creates a missing named volume, as both do.
 */
export function podmanLikeRuntime(): Readonly<{
  runtime: ContainerRuntime;
  commands: string[][];
  volumes: Set<string>;
  containers: Set<string>;
}> {
  const commands: string[][] = [];
  const volumes = new Set<string>();
  const containers = new Set<string>();
  function fail(message: string): Promise<string> {
    return Promise.reject(new Error(`docker failed (125): Error: ${message}`));
  }
  const runtime: ContainerRuntime = (args) => {
    commands.push([...args]);
    const [verb, sub] = args;
    const name = args.at(-1) ?? "";
    if (verb === "volume" && sub === "create") {
      if (volumes.has(name)) {
        return fail(
          `volume with name ${name} already exists: volume already exists`,
        );
      }
      volumes.add(name);
      return Promise.resolve(`${name}\n`);
    }
    if (verb === "volume" && (sub === "inspect" || sub === "rm")) {
      if (!volumes.has(name)) return fail(`no such volume ${name}`);
      if (sub === "rm") volumes.delete(name);
      return Promise.resolve("");
    }
    if (verb === "container" && sub === "inspect") {
      return containers.has(name) ?
          Promise.resolve("")
        : fail(`no such container ${name}`);
    }
    if (verb === "rm") {
      if (!containers.has(name)) return fail(`no such container ${name}`);
      containers.delete(name);
      return Promise.resolve("");
    }
    if (verb === "run") {
      for (const [index, argument] of args.entries()) {
        const mount = args[index + 1];
        if (
          argument === "-v" &&
          mount !== undefined &&
          !mount.startsWith("/")
        ) {
          volumes.add(mount.split(":")[0] ?? "");
        }
      }
      const nameIndex = args.indexOf("--name");
      if (nameIndex !== -1) containers.add(args[nameIndex + 1] ?? "");
      return Promise.resolve("");
    }
    return fail(`unexpected command ${args.join(" ")}`);
  };
  return { runtime, commands, volumes, containers };
}
