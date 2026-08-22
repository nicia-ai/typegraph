/**
 * Renders the cloud-init user-data bash script for the regression-lane EC2
 * runner. Unlike the SNB runner's bootstrap (`real/ec2/bootstrap-script.ts`),
 * this one clones with full history and tags (never `--depth`/
 * `--single-branch`) — `bench:regression` resolves its `tag` and `base`
 * baselines via `git tag --list '@nicia-ai/typegraph@*'` and
 * `git merge-base <candidate> main`, both of which need a resolvable `main`
 * and the full tag set, which a shallow clone cannot provide (see
 * `docs/ec2-regression-lane.md`).
 */
import {
  BOOTSTRAP_COMPLETE_SENTINEL,
  renderBootstrapPrelude,
  REPO_DIR,
} from "../../real/ec2/bootstrap-common";
import { type LaneBackend } from "../lanes";

export const POSTGRES_CONTAINER_NAME = "typegraph-regression-postgres";
export const REMOTE_POSTGRES_URL =
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const PG_READY_TIMEOUT_SECONDS = 120;

export type RegressionBootstrapOptions = Readonly<{
  repoUrl: string;
  ref: string;
  backends: readonly LaneBackend[];
  postgresImage: string;
  /**
   * Minutes until the dead-man's-switch `shutdown` fires. See
   * `bootstrap-common.ts`'s `deadManSwitchMinutes` for the shared formula.
   */
  deadManSwitchMinutes: number;
  sshPublicKey: string | undefined;
}>;

/**
 * Renders the full bootstrap script: the shared prelude
 * (`renderBootstrapPrelude`, Docker installed only when a postgres leg is
 * requested), a full-history clone + checkout, a guard that fails loudly
 * (under `set -e`, so it writes the failed sentinel via the prelude's `ERR`
 * trap) when `main` or a published `@nicia-ai/typegraph` tag cannot be
 * resolved, dependency install + build, an optional Postgres container with
 * a bounded health-check loop, and the completion sentinel.
 */
export function renderRegressionBootstrapScript(
  options: RegressionBootstrapOptions,
): string {
  const wantsPostgres = options.backends.includes("postgres");

  const prelude = renderBootstrapPrelude({
    deadManSwitchMinutes: options.deadManSwitchMinutes,
    sshPublicKey: options.sshPublicKey,
    extraAptPackages: [],
    installDocker: wantsPostgres,
  });

  const postgresLines: readonly string[] =
    wantsPostgres ?
      [
        "",
        "# Postgres leg requested: start a container matching CI's test-postgres",
        "# service (pgvector/pgvector:pg18) and wait for it to accept connections",
        "# before the regression run tries to reach it.",
        `docker run -d --name ${POSTGRES_CONTAINER_NAME} ` +
          "-e POSTGRES_USER=typegraph -e POSTGRES_PASSWORD=typegraph " +
          "-e POSTGRES_DB=typegraph_test -p 5432:5432 " +
          `"${options.postgresImage}"`,
        `for i in $(seq 1 ${PG_READY_TIMEOUT_SECONDS}); do`,
        `  if docker exec ${POSTGRES_CONTAINER_NAME} pg_isready -U typegraph -d typegraph_test >/dev/null 2>&1; then`,
        "    echo POSTGRES_READY",
        "    break",
        "  fi",
        "  sleep 1",
        `  if [ "$i" -eq ${PG_READY_TIMEOUT_SECONDS} ]; then`,
        `    echo "Postgres did not become ready within ${PG_READY_TIMEOUT_SECONDS}s" >&2`,
        "    exit 1",
        "  fi",
        "done",
      ]
    : [];

  const lines: readonly string[] = [
    prelude,
    "",
    `git clone "${options.repoUrl}" "${REPO_DIR}"`,
    `cd "${REPO_DIR}"`,
    `git checkout "${options.ref}"`,
    "",
    "# Baseline resolvability guard: bench:regression's --tag and --base",
    "# defaults need a full clone with tags and a resolvable main — fail loudly",
    "# here rather than hours later inside the regression run itself.",
    "git rev-parse --verify main >/dev/null",
    `test -n "$(git tag --list '@nicia-ai/typegraph@*')"`,
    "",
    "pnpm install --frozen-lockfile",
    "pnpm --filter @nicia-ai/typegraph build",
    ...postgresLines,
    "",
    `touch ${BOOTSTRAP_COMPLETE_SENTINEL}`,
    "",
  ];

  return lines.join("\n");
}
