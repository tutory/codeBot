import { setTimeout as sleep } from "node:timers/promises";

import type { Config } from "../config.js";
import { selectIssue, type SelectIssueResult } from "../domain/selectIssue.js";
import {
  branchTypeForIssue,
  toIssueSlug,
  type Issue,
  type ReviewComment,
  type TaskRecord,
} from "../domain/models.js";
import { GitRepository } from "../adapters/git.js";
import { GitHubClient } from "../adapters/github.js";
import { SolverRunner } from "../adapters/solver.js";
import { StateStore } from "../adapters/state.js";
import { Logger } from "../logger.js";

export type Dependencies = {
  github: GitHubClient;
  git: GitRepository;
  solver: SolverRunner;
  state: StateStore;
  logger: Logger;
};

export class AutonomousWorker {
  private static readonly actionSectionMarker = "<!-- codebot-actions -->";

  constructor(
    private readonly config: Config,
    private readonly deps: Dependencies,
  ) {}

  private applyTemplate(
    template: string,
    values: Record<string, string>,
  ): string {
    return template.replace(/\{([a-zA-Z0-9]+)\}/g, (match, key: string) =>
      values[key] ?? match,
    );
  }

  private branchNameForIssue(issue: Issue): string {
    const branchType = branchTypeForIssue(
      issue.labels,
      this.config.githubBugLabel,
    );
    return this.applyTemplate(this.config.branchNameTemplate, {
      branchType,
      issueNumber: String(issue.number),
      slug: toIssueSlug(issue.title),
      title: issue.title,
    });
  }

  private commitMessageForIssue(issue: Issue, reason: string): string {
    return this.applyTemplate(this.config.commitMessageTemplate, {
      branchType: branchTypeForIssue(issue.labels, this.config.githubBugLabel),
      issueNumber: String(issue.number),
      slug: toIssueSlug(issue.title),
      title: issue.title,
      reason,
    });
  }

  private touchRecord(record: TaskRecord): void {
    record.lastTouchedAt = new Date().toISOString();
  }

  private processedCommentKeys(record: TaskRecord): Set<string> {
    const keys = new Set<string>(record.lastProcessedCommentKeys ?? []);
    for (const id of record.lastReviewCommentIds) {
      keys.add(`pull:${id}`);
    }
    return keys;
  }

  private commentKey(comment: { source: "issue" | "pull" | "check"; id: number }): string {
    return `${comment.source}:${comment.id}`;
  }

  private isGitHubComment(
    comment: ReviewComment,
  ): comment is ReviewComment & { source: "issue" | "pull" } {
    return comment.source === "issue" || comment.source === "pull";
  }

  private isReorganizeCommand(comment: { body: string }): boolean {
    return comment.body.trim().toLowerCase() === "reorganize";
  }

  private isRebaseCommand(comment: { body: string }): boolean {
    return comment.body.trim().toLowerCase() === "rebase";
  }

  private isRebaseAndReorganizeCommand(comment: { body: string }): boolean {
    return comment.body.trim().toLowerCase() === "rebase + reorganize";
  }

  private isActionCommand(comment: { body: string }): boolean {
    return (
      this.isReorganizeCommand(comment) ||
      this.isRebaseCommand(comment) ||
      this.isRebaseAndReorganizeCommand(comment)
    );
  }

  private startsWithBotPrefix(comment: { body: string }): boolean {
    const prefix = this.config.githubCommentPrefix.trim();
    return prefix.length > 0 && comment.body.trim().startsWith(prefix);
  }

  private actionSectionBody(): string {
    return [
      AutonomousWorker.actionSectionMarker,
      `${this.config.githubCommentPrefix} Bot actions`,
      "",
      "- [ ] `rebase`",
      "- [ ] `rebase + reorganize`",
    ].join("\n");
  }

  private mergePullRequestBodyWithActionSection(body: string): string {
    const normalizedBody = body.trimEnd();
    const section = this.actionSectionBody();
    if (!normalizedBody.includes(AutonomousWorker.actionSectionMarker)) {
      return normalizedBody ? `${normalizedBody}\n\n${section}\n` : `${section}\n`;
    }
    const markerIndex = normalizedBody.indexOf(AutonomousWorker.actionSectionMarker);
    return `${normalizedBody.slice(0, markerIndex).trimEnd()}\n\n${section}\n`;
  }

  private extractBodyAction(body: string): "rebase" | "rebase+reorganize" | null {
    const markerIndex = body.indexOf(AutonomousWorker.actionSectionMarker);
    if (markerIndex === -1) {
      return null;
    }
    const section = body.slice(markerIndex);
    if (section.includes("- [x] `rebase + reorganize`")) {
      return "rebase+reorganize";
    }
    if (section.includes("- [x] `rebase`")) {
      return "rebase";
    }
    return null;
  }

  private async acknowledgeComments(
    prNumber: number,
    comments: readonly { id: number; source: "issue" | "pull" | "check" }[],
  ): Promise<void> {
    for (const comment of comments) {
      try {
        if (comment.source === "pull") {
          await this.deps.github.addPullRequestCommentReaction(comment.id, "eyes");
        } else if (comment.source === "issue") {
          await this.deps.github.addIssueCommentReaction(comment.id, "eyes");
        }
      } catch (error) {
        this.deps.logger.debug(
          "Failed to add acknowledgement reaction to comment %d on PR #%d: %o",
          comment.id,
          prNumber,
          error,
        );
      }
    }
  }

  private async reportFailure(prNumber: number, summary: string): Promise<void> {
    try {
      await this.deps.github.createIssueComment(
        prNumber,
        `${this.config.githubCommentPrefix} ${summary}`,
      );
    } catch (error) {
      this.deps.logger.debug(
        "Failed to post failure comment on PR #%d: %o",
        prNumber,
        error,
      );
    }
  }

  private async ensureActionSection(
    prNumber: number,
  ): Promise<"rebase" | "rebase+reorganize" | null> {
    const pullRequest = await this.deps.github.getPullRequest(prNumber);
    const action = this.extractBodyAction(pullRequest.body);
    const nextBody = this.mergePullRequestBodyWithActionSection(pullRequest.body);
    if (nextBody !== pullRequest.body) {
      await this.deps.github.updatePullRequestBody(prNumber, nextBody);
    }
    return action;
  }

  private async processActionCommand(
    record: TaskRecord,
    issue: Issue,
    command: "rebase" | "rebase+reorganize" | "reorganize",
    comment?: ReviewComment,
  ): Promise<void> {
    const worktree = this.deps.git.createWorktree(
      record.branchName,
      this.config.githubBaseBranch,
    );
    this.deps.git.refreshBase(this.config.githubBaseBranch);
    this.deps.git.refreshBranch(record.branchName);
    if (this.deps.git.resetWorktreeToRemoteBranch(worktree, record.branchName)) {
      this.deps.logger.debug(
        "Reset branch %s to origin/%s before action command",
        record.branchName,
        record.branchName,
      );
    }

    if (command === "rebase+reorganize") {
      this.deps.logger.info(
        "Rebasing and reorganizing branch %s for issue #%d",
        record.branchName,
        issue.number,
      );
      if (comment) {
        await this.acknowledgeComments(record.prNumber!, [comment]);
      }
      this.deps.git.rebaseOntoBase(worktree, this.config.githubBaseBranch);
      this.deps.solver.run({
        repoPath: worktree,
        branchName: record.branchName,
        issue,
        reviewComments: comment ? [comment] : [],
        action: "reorganize",
      });
      this.deps.git.pushBranchForceWithLease(worktree, record.branchName);
      await this.ensureActionSection(record.prNumber!);
      return;
    }

    if (command === "rebase") {
      this.deps.logger.info(
        "Rebasing branch %s for issue #%d",
        record.branchName,
        issue.number,
      );
      if (comment) {
        await this.acknowledgeComments(record.prNumber!, [comment]);
      }
      this.deps.git.rebaseOntoBase(worktree, this.config.githubBaseBranch);
      this.deps.git.pushBranchForceWithLease(worktree, record.branchName);
      await this.ensureActionSection(record.prNumber!);
      return;
    }

    if (command === "reorganize") {
      this.deps.logger.info(
        "Reorganizing commit history for issue #%d in %s",
        issue.number,
        worktree,
      );
      if (comment) {
        await this.acknowledgeComments(record.prNumber!, [comment]);
      }
      this.deps.solver.run({
        repoPath: worktree,
        branchName: record.branchName,
        issue,
        reviewComments: comment ? [comment] : [],
        action: "reorganize",
      });
      this.deps.git.pushBranchForceWithLease(worktree, record.branchName);
      await this.ensureActionSection(record.prNumber!);
    }
  }

  private async cleanupMergedPrs(active: Map<number, TaskRecord>): Promise<boolean> {
    let removedAny = false;
    for (const [issueNumber, record] of [...active.entries()]) {
      if (record.prNumber === undefined) {
        continue;
      }
      const pullRequest = await this.deps.github.getPullRequest(record.prNumber);
      if (!pullRequest.merged) {
        continue;
      }
      this.deps.logger.info(
        "Cleaning up merged PR #%d for issue #%d",
        record.prNumber,
        issueNumber,
      );
      this.deps.git.removeWorktree(record.branchName);
      active.delete(issueNumber);
      removedAny = true;
    }
    return removedAny;
  }

  private findResumableTask(
    issues: readonly Issue[],
    active: ReadonlyMap<number, TaskRecord>,
  ): { issue: Issue; record: TaskRecord } | undefined {
    const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
    const resumable = [...active.values()]
      .filter((record) => record.prNumber === undefined)
      .map((record) => ({
        record,
        issue: issueByNumber.get(record.issueNumber),
      }))
      .filter((entry): entry is { issue: Issue; record: TaskRecord } => entry.issue !== undefined)
      .sort((left, right) => {
        const leftTouched = left.record.lastTouchedAt ?? "";
        const rightTouched = right.record.lastTouchedAt ?? "";
        return rightTouched.localeCompare(leftTouched) || right.issue.number - left.issue.number;
      });

    return resumable[0];
  }

  private async finalizeIssue(
    issue: Issue,
    record: TaskRecord,
    worktree: string,
  ): Promise<void> {
    this.touchRecord(record);
    const hasChanges = this.deps.git.hasChanges(worktree);
    if (!hasChanges && record.prNumber === undefined && this.config.dryRun) {
      this.deps.logger.info(
        "Dry run enabled; issue #%d is left in progress without commit or PR",
        issue.number,
      );
      record.status = "in_progress";
      return;
    }

    if (!hasChanges && record.prNumber === undefined) {
      this.deps.logger.info(
        "No uncommitted changes for issue #%d; attempting to push branch and create PR if needed",
        issue.number,
      );
      record.status = "in_progress";
    }

    if (hasChanges) {
      if (this.config.dryRun) {
        this.deps.logger.info(
          "Dry run enabled; skipping commit, push, and PR creation for issue #%d",
          issue.number,
        );
        return;
      }

      this.deps.logger.info(
        "Committing and pushing changes for issue #%d",
        issue.number,
      );
      this.deps.git.commitAll(
        worktree,
        this.commitMessageForIssue(issue, issue.title),
      );
    } else if (record.prNumber !== undefined) {
      return;
    }

    if (this.config.dryRun) {
      return;
    }

    this.deps.git.pushBranch(worktree, record.branchName);
    if (record.prNumber !== undefined) {
      return;
    }

    const pr = await this.deps.github.createPullRequest({
      title: `Resolve #${issue.number}: ${issue.title}`,
      body: `Closes #${issue.number}`,
      head: record.branchName,
      base: this.config.githubBaseBranch,
      draft: this.config.createDraftPrs,
    });
    record.prNumber = pr.number;
    this.touchRecord(record);
    this.deps.logger.info(
      "Created %sPR #%d for issue #%d",
      this.config.createDraftPrs ? "draft " : "",
      pr.number,
      issue.number,
    );
    await this.ensureActionSection(pr.number);
  }

  private logSelection(result: SelectIssueResult): void {
    this.deps.logger.debug(
      "Available issues after filtering active tasks: %d",
      result.availableIssues.length,
    );
    this.deps.logger.debug(
      "Assigned candidates: %d; labeled candidates: %d",
      result.assignedCandidates.length,
      result.labeledCandidates.length,
    );
    if (result.assignedCandidates.length > 0) {
      this.deps.logger.debug(
        "Assigned candidate issue numbers: %s",
        result.assignedCandidates.map((issue) => issue.number).join(", "),
      );
    }
    if (result.labeledCandidates.length > 0) {
      this.deps.logger.debug(
        "Labeled candidate issue numbers: %s",
        result.labeledCandidates.map((issue) => issue.number).join(", "),
      );
    }
  }

  async syncReviewComments(active: Map<number, TaskRecord>): Promise<boolean> {
    if (active.size === 0) {
      this.deps.logger.debug("No active tasks to inspect for review comments");
      return false;
    }
    const issues = await this.deps.github.listOpenIssues();
    const viewerLogin = await this.deps.github.getViewerLogin();
    const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
    this.deps.logger.debug(
      "Checking review comments for %d active tasks",
      active.size,
    );
    let processedAnyComments = false;
    for (const [issueNumber, record] of active.entries()) {
      if (record.prNumber === undefined) {
        this.deps.logger.debug(
          "Skipping review sync for issue #%d because no PR is recorded yet",
          issueNumber,
        );
        continue;
      }
      const bodyAction = await this.ensureActionSection(record.prNumber);
      if (bodyAction) {
        const issue = issueByNumber.get(issueNumber);
        const targetIssue = issue ?? await this.deps.github.getIssue(issueNumber);
        processedAnyComments = true;
        await this.processActionCommand(record, targetIssue, bodyAction);
      }
      const pullComments = await this.deps.github.listPullRequestComments(record.prNumber);
      const issueComments = await this.deps.github.listIssueComments(record.prNumber);
      const allComments = [...pullComments, ...issueComments].filter((comment) =>
        this.isGitHubComment(comment),
      );
      const processedKeys = this.processedCommentKeys(record);
      const unseen = allComments.filter(
        (comment) =>
          (!this.config.ignoreSelfComments || comment.authorLogin !== viewerLogin) &&
          !this.startsWithBotPrefix(comment) &&
          !processedKeys.has(this.commentKey(comment)),
      );
      if (unseen.length === 0) {
        this.deps.logger.debug(
          "No new PR comments for PR #%d",
          record.prNumber,
        );
        continue;
      }
      const issue = issueByNumber.get(issueNumber);
      const targetIssue = issue ?? await this.deps.github.getIssue(issueNumber);
      const worktree = this.deps.git.worktreePath(record.branchName);
      const actionComments = unseen.filter((comment) => this.isActionCommand(comment));
      const normalComments = unseen.filter((comment) => !this.isActionCommand(comment));

      if (actionComments.length > 0) {
        processedAnyComments = true;
        const latestActionComment = [...actionComments]
          .sort((left, right) => left.id - right.id)
          .at(-1);
        if (latestActionComment) {
          const command = this.isRebaseAndReorganizeCommand(latestActionComment)
            ? "rebase+reorganize"
            : this.isRebaseCommand(latestActionComment)
              ? "rebase"
              : "reorganize";
          try {
            await this.processActionCommand(record, targetIssue, command, latestActionComment);
          } catch (error) {
            await this.reportFailure(
              record.prNumber,
              `Failed to execute action \`${latestActionComment.body.trim()}\`: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            throw error;
          }
        }
      }

      if (normalComments.length === 0) {
        record.lastReviewCommentIds.push(...unseen.map((comment) => comment.id));
        record.lastProcessedCommentKeys = [
          ...processedKeys,
          ...unseen.map((comment) => this.commentKey(comment)),
        ];
        this.touchRecord(record);
        this.deps.state.save(active);
        this.deps.logger.debug(
          "Saved state after processing PR feedback for issue #%d",
          targetIssue.number,
        );
        continue;
      }

      this.deps.logger.info(
        "Applying %d new PR comments for issue #%d in %s",
        normalComments.length,
        targetIssue.number,
        worktree,
      );
      processedAnyComments = true;
        await this.acknowledgeComments(
          record.prNumber,
          normalComments,
        );
      try {
        this.deps.solver.run({
          repoPath: worktree,
          branchName: record.branchName,
          issue: targetIssue,
          reviewComments: normalComments,
        });
        if (this.deps.git.hasChanges(worktree) && !this.config.dryRun) {
          this.deps.logger.info(
            "Committing and pushing review follow-up for issue #%d",
            targetIssue.number,
          );
          this.deps.git.commitAll(
            worktree,
            this.commitMessageForIssue(targetIssue, "address review feedback"),
          );
          this.deps.git.pushBranch(worktree, record.branchName);
          await this.ensureActionSection(record.prNumber);
        } else if (this.config.dryRun) {
          this.deps.logger.info(
            "Dry run enabled; review follow-up for issue #%d was not committed",
            targetIssue.number,
          );
        } else {
          this.deps.logger.info(
            "Review follow-up for issue #%d produced no file changes",
            targetIssue.number,
          );
        }
      } catch (error) {
        await this.reportFailure(
          record.prNumber,
          `Failed to apply PR feedback: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      record.lastReviewCommentIds.push(...unseen.map((comment) => comment.id));
      record.lastProcessedCommentKeys = [
        ...processedKeys,
        ...unseen.map((comment) => this.commentKey(comment)),
      ];
      this.touchRecord(record);
      this.deps.state.save(active);
      this.deps.logger.debug(
        "Saved state after processing PR feedback for issue #%d",
        targetIssue.number,
      );
    }
    return processedAnyComments;
  }

  async syncFailingChecks(active: Map<number, TaskRecord>): Promise<boolean> {
    if (active.size === 0) {
      this.deps.logger.debug("No active tasks to inspect for failing checks");
      return false;
    }

    const issues = await this.deps.github.listOpenIssues();
    const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
    this.deps.logger.debug(
      "Checking failing CI status for %d active tasks",
      active.size,
    );

    let processedAnyFailures = false;
    for (const [issueNumber, record] of active.entries()) {
      if (record.prNumber === undefined) {
        this.deps.logger.debug(
          "Skipping failing-check sync for issue #%d because no PR is recorded yet",
          issueNumber,
        );
        continue;
      }

      const pullRequest = await this.deps.github.getPullRequest(record.prNumber);
      if (pullRequest.merged) {
        this.deps.logger.debug(
          "Skipping failing-check sync for merged PR #%d",
          record.prNumber,
        );
        delete record.lastProcessedFailureSignature;
        continue;
      }

      if (!pullRequest.headSha) {
        this.deps.logger.debug(
          "Skipping failing-check sync for PR #%d because head SHA is missing",
          record.prNumber,
        );
        continue;
      }

      const failures = await this.deps.github.listFailingChecks(pullRequest.headSha);
      if (failures.length === 0) {
        if (record.lastProcessedFailureSignature !== undefined) {
          this.deps.logger.debug(
            "Clearing stored failing-check signature for PR #%d",
            record.prNumber,
          );
          delete record.lastProcessedFailureSignature;
          this.touchRecord(record);
        }
        continue;
      }

      const failureSignature = failures.join("\n");
      if (failureSignature === record.lastProcessedFailureSignature) {
        this.deps.logger.debug(
          "No new failing checks for PR #%d",
          record.prNumber,
        );
        continue;
      }

      const issue = issueByNumber.get(issueNumber);
      const targetIssue = issue ?? await this.deps.github.getIssue(issueNumber);
      const worktree = this.deps.git.createWorktree(
        record.branchName,
        this.config.githubBaseBranch,
      );
      this.deps.git.refreshBranch(record.branchName);
      if (this.deps.git.resetWorktreeToRemoteBranch(worktree, record.branchName)) {
        this.deps.logger.debug(
          "Reset branch %s to origin/%s before addressing failing checks",
          record.branchName,
          record.branchName,
        );
      }
      const failingCheckComments = failures.map((failure, index) => ({
        id: Number(`9${record.prNumber}${index}`),
        body: `CI failure: ${failure}`,
        source: "check" as const,
      }));

      this.deps.logger.info(
        "Applying %d failing checks for issue #%d in %s",
        failures.length,
        targetIssue.number,
        worktree,
      );
      processedAnyFailures = true;

      try {
        this.deps.solver.run({
          repoPath: worktree,
          branchName: record.branchName,
          issue: targetIssue,
          reviewComments: failingCheckComments,
        });
        if (this.deps.git.hasChanges(worktree) && !this.config.dryRun) {
          this.deps.logger.info(
            "Committing and pushing CI follow-up for issue #%d",
            targetIssue.number,
          );
          this.deps.git.commitAll(
            worktree,
            this.commitMessageForIssue(targetIssue, "address failing checks"),
          );
          this.deps.git.pushBranch(worktree, record.branchName);
          await this.ensureActionSection(record.prNumber);
        } else if (this.config.dryRun) {
          this.deps.logger.info(
            "Dry run enabled; CI follow-up for issue #%d was not committed",
            targetIssue.number,
          );
        } else {
          this.deps.logger.info(
            "CI follow-up for issue #%d produced no file changes",
            targetIssue.number,
          );
        }
      } catch (error) {
        await this.reportFailure(
          record.prNumber,
          `Failed to address failing checks: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }

      record.lastProcessedFailureSignature = failureSignature;
      this.touchRecord(record);
      this.deps.state.save(active);
      this.deps.logger.debug(
        "Saved state after processing failing checks for issue #%d",
        targetIssue.number,
      );
    }

    return processedAnyFailures;
  }

  async resumeIssue(issue: Issue, record: TaskRecord): Promise<void> {
    this.deps.logger.info("Resuming issue #%d: %s", issue.number, issue.title);
    this.deps.logger.debug("Using existing branch %s", record.branchName);
    this.deps.git.refreshBase(this.config.githubBaseBranch);
    this.deps.git.refreshBranch(record.branchName);
    this.deps.logger.debug(
      "Fetched latest base branch %s",
      this.config.githubBaseBranch,
    );
    const worktree = this.deps.git.createWorktree(
      record.branchName,
      this.config.githubBaseBranch,
    );
    if (this.deps.git.resetWorktreeToRemoteBranch(worktree, record.branchName)) {
      this.deps.logger.debug(
        "Reset branch %s to origin/%s before resuming work",
        record.branchName,
        record.branchName,
      );
    }
    this.deps.logger.info("Using worktree at %s", worktree);
    this.deps.logger.info("Running solver command for issue #%d", issue.number);
    this.deps.solver.run({ repoPath: worktree, branchName: record.branchName, issue });
    this.deps.logger.info("Solver finished for issue #%d", issue.number);

    if (!this.deps.git.hasChanges(worktree) && record.prNumber === undefined && this.config.dryRun) {
      this.touchRecord(record);
    }

    await this.finalizeIssue(issue, record, worktree);
  }

  async handleIssue(
    issue: Issue,
    active: Map<number, TaskRecord>,
  ): Promise<void> {
    const branchName = this.branchNameForIssue(issue);
    this.deps.logger.info("Selected issue #%d: %s", issue.number, issue.title);
    this.deps.logger.debug("Using branch %s", branchName);
    this.deps.git.refreshBase(this.config.githubBaseBranch);
    this.deps.logger.debug(
      "Fetched latest base branch %s",
      this.config.githubBaseBranch,
    );
    const worktree = this.deps.git.createWorktree(
      branchName,
      this.config.githubBaseBranch,
    );
    this.deps.logger.info("Created worktree at %s", worktree);
    this.deps.logger.info("Running solver command for issue #%d", issue.number);
    this.deps.solver.run({ repoPath: worktree, branchName, issue });
    this.deps.logger.info("Solver finished for issue #%d", issue.number);

    const record: TaskRecord = {
      issueNumber: issue.number,
      branchName,
      lastReviewCommentIds: [],
      lastProcessedCommentKeys: [],
      status: "in_progress",
      lastTouchedAt: new Date().toISOString(),
    };
    active.set(issue.number, record);

    if (!this.deps.git.hasChanges(worktree)) {
      if (record.prNumber === undefined) {
        record.status = "no_changes";
      }
      this.deps.logger.info(
        "Issue #%d produced no uncommitted file changes",
        issue.number,
      );
      return;
    }

    await this.finalizeIssue(issue, record, worktree);
  }

  async runOnce(): Promise<boolean> {
    this.deps.logger.info("Starting run-once cycle");
    this.deps.git.verify();
    const active = this.deps.state.load();
    this.deps.logger.debug("Loaded %d active task records", active.size);
    const cleanedMergedPrs = await this.cleanupMergedPrs(active);
    if (cleanedMergedPrs) {
      this.deps.state.save(active);
      this.deps.logger.debug(
        "Saved state after cleaning up merged PRs; %d active tasks remain",
        active.size,
      );
    }
    const processedReviewComments = await this.syncReviewComments(active);
    if (processedReviewComments) {
      this.deps.state.save(active);
      this.deps.logger.debug(
        "Saved state for %d active tasks after processing PR feedback",
        active.size,
      );
      return true;
    }
    const processedFailingChecks = await this.syncFailingChecks(active);
    if (processedFailingChecks) {
      this.deps.state.save(active);
      this.deps.logger.debug(
        "Saved state for %d active tasks after processing failing checks",
        active.size,
      );
      return true;
    }

    const issues = await this.deps.github.listOpenIssues();
    this.deps.logger.info("Fetched %d open issues from GitHub", issues.length);
    const resumable = this.findResumableTask(issues, active);
    if (resumable) {
      await this.resumeIssue(resumable.issue, resumable.record);
      this.deps.state.save(active);
      this.deps.logger.debug("Saved state for %d active tasks", active.size);
      return true;
    }
    const selection = selectIssue({
      issues,
      activeTasks: active,
      ...(this.config.githubAssignee === undefined ||
      this.config.githubAssignee === ""
        ? {}
        : { assignee: this.config.githubAssignee }),
      easyLabel: this.config.githubEasyLabel,
    });
    this.logSelection(selection);
    const issue = selection.selectedIssue;
    if (!issue) {
      this.deps.state.save(active);
      this.deps.logger.info("No matching issue found");
      return false;
    }
    await this.handleIssue(issue, active);
    this.deps.state.save(active);
    this.deps.logger.debug("Saved state for %d active tasks", active.size);
    return true;
  }

  async loopForever(): Promise<void> {
    this.deps.logger.info(
      "Starting polling loop with %d second interval",
      this.config.pollSeconds,
    );
    for (;;) {
      try {
        await this.runOnce();
      } catch (error) {
        this.deps.logger.error("Worker loop failed", error);
      }
      await sleep(this.config.pollSeconds * 1000);
    }
  }
}
