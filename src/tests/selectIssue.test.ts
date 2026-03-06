import test from "node:test";
import assert from "node:assert/strict";

import { branchTypeForIssue } from "../domain/models.js";
import { selectIssue } from "../domain/selectIssue.js";

test("selectIssue prefers assigned issues before easy issues", () => {
  const result = selectIssue({
    issues: [
      {
        number: 2,
        title: "Easy task",
        body: "",
        url: "https://example/2",
        labels: ["easy"],
        assignees: []
      },
      {
        number: 1,
        title: "Assigned task",
        body: "",
        url: "https://example/1",
        labels: [],
        assignees: ["bot"]
      }
    ],
    activeTasks: new Map([[3, {
      issueNumber: 3,
      branchName: "codex/3-active",
      lastReviewCommentIds: [],
      status: "in_progress"
    }]]),
    assignee: "bot",
    easyLabel: "easy"
  });

  assert.equal(result.selectedIssue?.number, 1);
});

test("selectIssue matches labels case-insensitively", () => {
  const result = selectIssue({
    issues: [
      {
        number: 7,
        title: "Bot task",
        body: "",
        url: "https://example/7",
        labels: ["TutoryCodeBot"],
        assignees: []
      }
    ],
    activeTasks: new Map(),
    easyLabel: "tutoryCodeBot"
  });

  assert.equal(result.selectedIssue?.number, 7);
});

test("branchTypeForIssue returns FIX only when the bug label is present", () => {
  assert.equal(branchTypeForIssue(["easy", "enhancement"], "bug"), "ENH");
  assert.equal(branchTypeForIssue(["bug"], "bug"), "FIX");
});
