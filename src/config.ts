import fs from "node:fs";
import path from "node:path";

const loadDotenv = (filePath = path.resolve(".env")): void => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const readBoolean = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

export type Config = {
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBaseBranch: string;
  githubEasyLabel: string;
  githubBugLabel: string;
  branchNameTemplate: string;
  commitMessageTemplate: string;
  githubAssignee?: string;
  ignoreSelfComments: boolean;
  createDraftPrs: boolean;
  githubCommentPrefix: string;
  repoPath: string;
  dryRun: boolean;
  pollSeconds: number;
  model: string;
  solverCommand: string;
  stateFile: string;
};

export const loadConfig = (): Config => {
  loadDotenv();
  const assignee = process.env.GITHUB_ASSIGNEE?.trim();
  return {
    githubToken: requireEnv("GITHUB_TOKEN"),
    githubOwner: requireEnv("GITHUB_OWNER"),
    githubRepo: requireEnv("GITHUB_REPO"),
    githubBaseBranch: process.env.GITHUB_BASE_BRANCH?.trim() || "develop",
    githubEasyLabel: process.env.GITHUB_EASY_LABEL?.trim() || "easy",
    githubBugLabel: process.env.GITHUB_BUG_LABEL?.trim() || "bug",
    branchNameTemplate:
      process.env.CODEBOT_BRANCH_NAME_TEMPLATE?.trim() ||
      "{branchType}-{issueNumber}-{slug}",
    commitMessageTemplate:
      process.env.CODEBOT_COMMIT_MESSAGE_TEMPLATE?.trim() ||
      "#{issueNumber}: {reason}",
    ...(assignee && { githubAssignee: assignee }),
    ignoreSelfComments: readBoolean("CODEBOT_IGNORE_SELF_COMMENTS", false),
    createDraftPrs: readBoolean("CODEBOT_CREATE_DRAFT_PRS", false),
    githubCommentPrefix: process.env.CODEBOT_GITHUB_COMMENT_PREFIX?.trim() || "🤖",
    repoPath: path.resolve(requireEnv("CODEBOT_REPO_PATH")),
    dryRun: readBoolean("CODEBOT_DRY_RUN", true),
    pollSeconds: Number.parseInt(process.env.CODEBOT_POLL_SECONDS || "300", 10),
    model: process.env.CODEBOT_MODEL?.trim() || "gpt-5.4",
    solverCommand: requireEnv("CODEBOT_SOLVER_COMMAND"),
    stateFile: path.resolve(process.env.CODEBOT_STATE_FILE || ".codebot/state.json")
  };
};
