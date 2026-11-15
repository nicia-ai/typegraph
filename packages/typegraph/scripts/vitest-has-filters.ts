import { parseCLI } from "vitest/node";

// Keep positional-filter detection aligned with Vitest's own option parsing.
const { filter } = parseCLI(["vitest", "run", ...process.argv.slice(2)]);
process.stdout.write(filter.length === 0 ? "0" : "1");
