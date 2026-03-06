import type { Issue, PullRequest, ReviewComment } from "../domain/models.js";

type GitHubIssuePayload = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  pull_request?: unknown;
};

type PullPayload = {
  number: number;
  html_url: string;
  head: { ref: string; sha?: string };
  body?: string | null;
  state?: string;
  merged?: boolean;
  user?: { login: string };
};

type IssueCommentPayload = {
  id: number;
  body: string;
  user?: { login: string };
};

type PullCommentPayload = {
  id: number;
  body: string;
  path?: string;
  line?: number | null;
  user?: { login: string };
};

type CheckRunsPayload = {
  check_runs?: Array<{
    name: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string | null;
  }>;
};

type StatusPayload = {
  statuses?: Array<{
    context: string;
    state: string;
    target_url?: string | null;
  }>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableFetchError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const cause = error.cause;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(
      cause.code
    );
  }
  return false;
};

const isHttpStatusError = (error: unknown, status: number): boolean =>
  error instanceof Error &&
  error.message.includes(`failed: ${status}`);

export class GitHubClient {
  readonly #baseUrl: string;
  readonly #headers: Headers;
  #viewerLogin?: string;

  constructor(
    private readonly token: string,
    owner: string,
    repo: string
  ) {
    this.#baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
    this.#headers = new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "user-agent": "tutory-codebot",
      "x-github-api-version": "2022-11-28"
    });
  }

  private async request<T>(
    method: string,
    pathOrUrl: string,
    payload?: unknown
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const init: RequestInit = {
        method,
        headers: this.#headers
      };
      if (payload !== undefined) {
        init.body = JSON.stringify(payload);
      }

      try {
        const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.#baseUrl}${pathOrUrl}`;
        const response = await fetch(url, init);
        if (!response.ok) {
          throw new Error(`GitHub API ${method} ${pathOrUrl} failed: ${response.status}`);
        }
        if (response.status === 204) {
          return undefined as T;
        }
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (error) {
        if (attempt === maxAttempts || !isRetryableFetchError(error)) {
          throw error;
        }
        await sleep(500 * attempt);
      }
    }

    throw new Error(`GitHub API ${method} ${pathOrUrl} failed unexpectedly`);
  }

  async listOpenIssues(): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (let page = 1; ; page += 1) {
      const items = await this.request<GitHubIssuePayload[]>(
        "GET",
        `/issues?state=open&per_page=100&page=${page}`
      );
      issues.push(
        ...items
          .filter((item) => item.pull_request === undefined)
          .map((item) => ({
            number: item.number,
            title: item.title,
            body: item.body ?? "",
            url: item.html_url,
            labels: (item.labels ?? []).map((label) => label.name),
            assignees: (item.assignees ?? []).map((assignee) => assignee.login)
          }))
      );
      if (items.length < 100) {
        break;
      }
    }
    return issues;
  }

  async getIssue(issueNumber: number): Promise<Issue> {
    const item = await this.request<GitHubIssuePayload>("GET", `/issues/${issueNumber}`);
    return {
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      url: item.html_url,
      labels: (item.labels ?? []).map((label) => label.name),
      assignees: (item.assignees ?? []).map((assignee) => assignee.login)
    };
  }

  async createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  }): Promise<PullRequest> {
    const payload = await this.request<PullPayload>("POST", "/pulls", input);
    return {
      number: payload.number,
      url: payload.html_url,
      headRef: payload.head.ref
    };
  }

  async getPullRequest(
    prNumber: number,
  ): Promise<PullRequest & { body: string; state: string; merged: boolean; headSha: string }> {
    const payload = await this.request<PullPayload>("GET", `/pulls/${prNumber}`);
    return {
      number: payload.number,
      url: payload.html_url,
      headRef: payload.head.ref,
      body: payload.body ?? "",
      state: payload.state ?? "open",
      merged: payload.merged ?? false,
      headSha: payload.head.sha ?? ""
    };
  }

  async updatePullRequestBody(prNumber: number, body: string): Promise<void> {
    await this.request<unknown>("PATCH", `/pulls/${prNumber}`, { body });
  }

  async listIssueComments(issueNumber: number): Promise<ReviewComment[]> {
    const items = await this.request<IssueCommentPayload[]>(
      "GET",
      `/issues/${issueNumber}/comments?per_page=100`
    );
    return items.map((item) => ({
      id: item.id,
      body: item.body,
      source: "issue",
      ...(item.user?.login ? { authorLogin: item.user.login } : {})
    }));
  }

  async listPullRequestComments(prNumber: number): Promise<ReviewComment[]> {
    const items = await this.request<PullCommentPayload[]>(
      "GET",
      `/pulls/${prNumber}/comments?per_page=100`
    );
    return items.map((item) => ({
      id: item.id,
      body: item.body,
      source: "pull",
      ...(item.user?.login ? { authorLogin: item.user.login } : {}),
      ...(item.path ? { path: item.path } : {}),
      ...(item.line === undefined || item.line === null ? {} : { line: item.line })
    }));
  }

  async getViewerLogin(): Promise<string> {
    if (this.#viewerLogin) {
      return this.#viewerLogin;
    }
    const payload = await this.request<{ login: string }>("GET", "https://api.github.com/user");
    this.#viewerLogin = payload.login;
    return this.#viewerLogin;
  }

  async addIssueCommentReaction(commentId: number, content: "eyes"): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/issues/comments/${commentId}/reactions`,
      { content }
    );
  }

  async addPullRequestCommentReaction(commentId: number, content: "eyes"): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/pulls/comments/${commentId}/reactions`,
      { content }
    );
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.request<unknown>("POST", `/issues/${issueNumber}/comments`, { body });
  }

  async deleteIssueComment(commentId: number): Promise<void> {
    await this.request<unknown>("DELETE", `/issues/comments/${commentId}`);
  }

  async listFailingChecks(ref: string): Promise<string[]> {
    const failures = new Set<string>();

    try {
      const checkRunsPayload = await this.request<CheckRunsPayload>(
        "GET",
        `/commits/${ref}/check-runs?per_page=100`
      );
      for (const checkRun of checkRunsPayload.check_runs ?? []) {
        const conclusion = checkRun.conclusion ?? "";
        if (["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(conclusion)) {
          failures.add(
            checkRun.html_url ? `${checkRun.name}: ${checkRun.html_url}` : checkRun.name
          );
        }
      }
    } catch (error) {
      if (!isHttpStatusError(error, 403)) {
        throw error;
      }
    }

    const statusPayload = await this.request<StatusPayload>(
      "GET",
      `/commits/${ref}/status`
    );
    for (const status of statusPayload.statuses ?? []) {
      if (["failure", "error"].includes(status.state)) {
        failures.add(
          status.target_url ? `${status.context}: ${status.target_url}` : status.context
        );
      }
    }

    return [...failures].sort();
  }

}
