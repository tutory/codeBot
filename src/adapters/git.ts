import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const runGit = (repoPath: string, args: readonly string[], cwd = repoPath): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

type WorktreeRecord = {
  path: string;
  branch?: string;
};

const listWorktrees = (repoPath: string): WorktreeRecord[] => {
  const output = runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (!output) {
    return [];
  }

  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) {
        records.push(current);
      }
      current = { path: line.slice("worktree ".length) };
      continue;
    }

    if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    }
  }

  if (current) {
    records.push(current);
  }

  return records;
};

export class GitRepository {
  constructor(readonly repoPath: string) {}

  verify(): void {
    runGit(this.repoPath, ["rev-parse", "--is-inside-work-tree"]);
  }

  refreshBase(baseBranch: string): void {
    runGit(this.repoPath, ["fetch", "origin", baseBranch]);
  }

  worktreePath(branchName: string): string {
    return path.join(
      path.dirname(this.repoPath),
      `${path.basename(this.repoPath)}-${branchName.replaceAll("/", "-")}`
    );
  }

  createWorktree(branchName: string, baseBranch: string): string {
    const worktree = this.worktreePath(branchName);
    runGit(this.repoPath, ["worktree", "prune"]);

    const existing = listWorktrees(this.repoPath).find(
      (record) => record.branch === branchName
    );
    if (existing && existing.path === worktree && fs.existsSync(worktree)) {
      return worktree;
    }

    if (!existing && fs.existsSync(worktree)) {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    runGit(this.repoPath, [
      "worktree",
      "add",
      "-B",
      branchName,
      worktree,
      `origin/${baseBranch}`
    ]);
    return worktree;
  }

  hasChanges(cwd: string): boolean {
    return runGit(this.repoPath, ["status", "--short"], cwd).length > 0;
  }

  commitAll(cwd: string, message: string): string {
    runGit(this.repoPath, ["add", "-A"], cwd);
    runGit(this.repoPath, ["commit", "-m", message], cwd);
    return runGit(this.repoPath, ["rev-parse", "HEAD"], cwd);
  }

  pushBranch(cwd: string, branchName: string): void {
    runGit(this.repoPath, ["push", "-u", "origin", branchName], cwd);
  }

  pushBranchForceWithLease(cwd: string, branchName: string): void {
    runGit(this.repoPath, ["push", "--force-with-lease", "-u", "origin", branchName], cwd);
  }

  rebaseOntoBase(cwd: string, baseBranch: string): void {
    runGit(this.repoPath, ["rebase", `origin/${baseBranch}`], cwd);
  }

  removeWorktree(branchName: string): void {
    const worktree = this.worktreePath(branchName);
    if (fs.existsSync(worktree)) {
      runGit(this.repoPath, ["worktree", "remove", "--force", worktree]);
    }
  }
}
