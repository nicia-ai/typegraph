/**
 * PGlite wiring of the commit-outcome check. The cases live in
 * `commit-outcome-wiring.ts`.
 */
import {
  pgliteFixture,
  registerCommitOutcomeWiringTests,
} from "./commit-outcome-wiring";

registerCommitOutcomeWiringTests(pgliteFixture);
