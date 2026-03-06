import { spawnSync } from "node:child_process";

import type { Issue, ReviewComment } from "../domain/models.js";

export class SolverRunner {
  constructor(
    private readonly command: string,
    private readonly commandCwd: string
  ) {}

  run(input: {
    repoPath: string;
    branchName: string;
    issue: Issue;
    reviewComments?: readonly ReviewComment[];
    action?: "solve" | "reorganize";
  }): void {
    const result = spawnSync(this.command, {
      cwd: this.commandCwd,
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        CODEBOT_WORKSPACE_PATH: this.commandCwd,
        CODEBOT_REPO_PATH: input.repoPath,
        CODEBOT_BRANCH_NAME: input.branchName,
        CODEBOT_ISSUE_NUMBER: String(input.issue.number),
        CODEBOT_ISSUE_TITLE: input.issue.title,
        CODEBOT_ISSUE_BODY: input.issue.body,
        CODEBOT_ISSUE_URL: input.issue.url,
        CODEBOT_ACTION: input.action ?? "solve",
        CODEBOT_REVIEW_COMMENTS_JSON: JSON.stringify(input.reviewComments ?? [])
      }
    });
    if (result.status !== 0) {
      throw new Error(`Solver command failed with exit code ${result.status ?? "unknown"}`);
    }
  }
}
