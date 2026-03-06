#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const issueNumber = required("CODEBOT_ISSUE_NUMBER");
const issueTitle = required("CODEBOT_ISSUE_TITLE");
const issueBody = process.env.CODEBOT_ISSUE_BODY ?? "";
const issueUrl = required("CODEBOT_ISSUE_URL");
const repoPath = required("CODEBOT_REPO_PATH");
const workspacePath = required("CODEBOT_WORKSPACE_PATH");
const branchName = required("CODEBOT_BRANCH_NAME");
const action = process.env.CODEBOT_ACTION?.trim() || "solve";
const reviewComments = JSON.parse(process.env.CODEBOT_REVIEW_COMMENTS_JSON ?? "[]");
const styleGuidePath = path.join(workspacePath, "CODEBOT_STYLE.md");
const styleGuideExamplePath = path.join(workspacePath, "CODEBOT_STYLE.example.md");
const resolvedStyleGuidePath = fs.existsSync(styleGuidePath)
  ? styleGuidePath
  : fs.existsSync(styleGuideExamplePath)
    ? styleGuideExamplePath
    : null;
const styleGuide = resolvedStyleGuidePath
  ? fs.readFileSync(resolvedStyleGuidePath, "utf8").trim()
  : "";

const runDirectory = path.join(workspacePath, ".codebot", "runs");
fs.mkdirSync(runDirectory, { recursive: true });

const runFile = path.join(runDirectory, `${issueNumber}.json`);
const runContext = {
  issueNumber,
  issueTitle,
  issueBody,
  issueUrl,
  repoPath,
  branchName,
  reviewComments,
  createdAt: new Date().toISOString()
};

fs.writeFileSync(runFile, `${JSON.stringify(runContext, null, 2)}\n`);

const resolveCodexCommand = () => {
  const localCodex = path.join(workspacePath, "node_modules", ".bin", "codex");
  if (fs.existsSync(localCodex)) {
    return localCodex;
  }
  return "codex";
};

const promptSections = action === "reorganize"
  ? [
      "You are reorganizing the existing commit history of a GitHub pull request branch.",
      "",
      "Goals:",
      "- Preserve the current branch behavior and resulting file contents.",
      "- Rewrite the branch into a small number of logical commits.",
      "- Use clear commit messages that follow the repository convention.",
      "",
      "Allowed actions:",
      "- You may use git reset, git add -p or staged groups, commit, and rebase.",
      "- You may inspect the diff against the base branch and regroup it into coherent commits.",
      "",
      "Constraints:",
      "- Do not change the net diff of the branch unless strictly necessary to keep the branch valid.",
      "- Do not modify unrelated code.",
      "- Do not push. The outer bot will handle force-pushing after you finish the rewrite.",
      "",
      `Issue #${issueNumber}: ${issueTitle}`,
      `Issue URL: ${issueUrl}`,
      `Branch: ${branchName}`,
      "",
      "Trigger comment(s):",
      JSON.stringify(reviewComments, null, 2)
    ]
  : [
      "You are solving a GitHub issue in the checked out repository.",
      "",
      "Constraints:",
      "- Modify files in the repository to address the issue.",
      "- Do not create commits or branches.",
      "- Leave the repository in a clean working state except for intended file changes.",
      "- If the issue is already solved or cannot be solved safely, make no changes.",
      "",
      `Issue #${issueNumber}: ${issueTitle}`,
      `Issue URL: ${issueUrl}`,
      "",
      "Issue body:",
      issueBody || "(empty)"
    ];

if (reviewComments.length > 0) {
  promptSections.push(
    "",
    "Review comments to address:",
    JSON.stringify(reviewComments, null, 2)
  );
}

if (styleGuide) {
  promptSections.push(
    "",
    "Repository coding style and constraints:",
    styleGuide
  );
}

const prompt = promptSections.join("\n");

console.log(`[solver] Prepared issue #${issueNumber}: ${issueTitle}`);
console.log(`[solver] Target repo: ${repoPath}`);
console.log(`[solver] Branch: ${branchName}`);
console.log(`[solver] Action: ${action}`);
console.log(`[solver] Review comments: ${reviewComments.length}`);
console.log(`[solver] Style guide: ${resolvedStyleGuidePath ?? "not found"}`);
console.log(`[solver] Wrote run context to ${runFile}`);

const codexCommand = resolveCodexCommand();
console.log(`[solver] Using Codex command: ${codexCommand}`);

const result = spawnSync(
  codexCommand,
  action === "reorganize"
    ? [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        repoPath,
        prompt
      ]
    : [
        "exec",
        "--full-auto",
        "--cd",
        repoPath,
        prompt
      ],
  {
    cwd: workspacePath,
    stdio: "inherit",
    env: process.env
  }
);

if (result.status !== 0) {
  throw new Error(`codex exec failed with exit code ${result.status ?? "unknown"}`);
}
