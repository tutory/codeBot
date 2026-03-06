import { loadConfig } from "./config.js";
import { GitRepository } from "./adapters/git.js";
import { GitHubClient } from "./adapters/github.js";
import { SolverRunner } from "./adapters/solver.js";
import { StateStore } from "./adapters/state.js";
import { AutonomousWorker } from "./app/worker.js";
import { Logger } from "./logger.js";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v") || process.env.DEBUG === "1";
const command = args.find((arg) => arg === "run-once" || arg === "loop");

if (command === undefined) {
  console.error("Usage: node dist/cli.js <run-once|loop> [--verbose]");
  process.exit(1);
}

const config = loadConfig();
const logger = new Logger(verbose);
const worker = new AutonomousWorker(config, {
  github: new GitHubClient(config.githubToken, config.githubOwner, config.githubRepo),
  git: new GitRepository(config.repoPath),
  solver: new SolverRunner(config.solverCommand, process.cwd()),
  state: new StateStore(config.stateFile),
  logger
});

logger.info("Loaded configuration for %s/%s", config.githubOwner, config.githubRepo);
logger.debug("Repository path: %s", config.repoPath);
logger.debug("Base branch: %s", config.githubBaseBranch);
logger.debug("Dry run: %s", config.dryRun);
logger.debug("Create draft PRs: %s", config.createDraftPrs);
logger.debug("GitHub comment prefix: %s", config.githubCommentPrefix);
logger.debug("Solver command: %s", config.solverCommand);

if (command === "run-once") {
  await worker.runOnce();
} else {
  await worker.loopForever();
}
