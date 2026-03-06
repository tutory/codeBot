export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: readonly string[];
  assignees: readonly string[];
};

export type PullRequest = {
  number: number;
  url: string;
  headRef: string;
};

export type ReviewComment = {
  id: number;
  body: string;
  source: "issue" | "pull" | "check";
  authorLogin?: string;
  path?: string;
  line?: number;
};

export type TaskRecord = {
  issueNumber: number;
  branchName: string;
  prNumber?: number;
  lastReviewCommentIds: number[];
  lastProcessedCommentKeys?: string[];
  lastProcessedFailureSignature?: string;
  status: "in_progress" | "no_changes";
  lastTouchedAt?: string;
};

export const toIssueSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const branchTypeForIssue = (
  labels: readonly string[],
  bugLabel: string
): "FIX" | "ENH" => {
  const normalizedBugLabel = bugLabel.toLowerCase();
  return labels.some((label) => label.toLowerCase() === normalizedBugLabel) ? "FIX" : "ENH";
};
