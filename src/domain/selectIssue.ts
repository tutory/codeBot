import type { Issue, TaskRecord } from "./models.js";

export type SelectIssueInput = {
  issues: readonly Issue[];
  activeTasks: ReadonlyMap<number, TaskRecord>;
  assignee?: string;
  easyLabel: string;
};

export type SelectIssueResult = {
  selectedIssue?: Issue;
  availableIssues: Issue[];
  assignedCandidates: Issue[];
  labeledCandidates: Issue[];
};

export const selectIssue = ({
  issues,
  activeTasks,
  assignee,
  easyLabel,
}: SelectIssueInput): SelectIssueResult => {
  const normalizedAssignee = assignee?.trim();
  const normalizedEasyLabel = easyLabel.toLowerCase();
  const available = issues.filter((issue) => !activeTasks.has(issue.number));
  const assigned = available.filter(
    (issue) =>
      normalizedAssignee !== undefined &&
      normalizedAssignee.length > 0 &&
      issue.assignees.includes(normalizedAssignee),
  );
  const easy = available.filter(
    (issue) =>
      !assigned.includes(issue) &&
      issue.labels.some((label) => label.toLowerCase() === normalizedEasyLabel),
  );
  const selectedIssue = [...(assigned.length > 0 ? assigned : easy)].sort(
    (left, right) => left.number - right.number,
  )[0];
  return {
    ...(selectedIssue === undefined ? {} : { selectedIssue }),
    availableIssues: available,
    assignedCandidates: assigned,
    labeledCandidates: easy,
  };
};
