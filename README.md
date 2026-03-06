# Tutory Code Bot

This repository contains a first working slice of an autonomous issue bot in TypeScript.

Current scope:

- Poll GitHub for issues assigned to the bot or tagged with an "easy" label.
- Create an isolated git worktree for a selected issue.
- Run a pluggable solver command inside that worktree.
- Commit changes as `#<issueNumber>: why it was changed`.
- Open a pull request through the GitHub API.
- Poll tracked PR comments and rerun the solver with PR feedback context.
- Check tracked PR CI results and rerun the solver when checks fail.
- Maintain a `Bot actions` section in the PR body for `rebase` and `rebase + reorganize`.
- Remove the linked worktree after a tracked PR is merged.

Not implemented yet:

- Actual LLM issue solving logic beyond invoking `CODEBOT_SOLVER_COMMAND`.
- Slack reporting and approval flows.
- Zube board integration.
- Rich merge policies beyond the current PR-body actions and comment commands.

## Why this shape

The bot is split into three parts:

1. `src/domain/`: issue selection and workflow state primitives.
2. `src/adapters/`: GitHub, git, solver, and local state IO.
3. `src/app/worker.ts`: the autonomous orchestration loop.

That keeps the workflow engine independent from the model or coding tool you eventually use.

## Quick start

1. Edit [.env](/Users/sh/Work/tutory/tutoryCodeBot/.env).
2. Point `CODEBOT_REPO_PATH` at a local clone of the target project.
3. Provide a solver command. The command receives issue and PR context through environment variables.
4. Install dependencies and run:

```bash
npm install
npm run build
node dist/cli.js run-once
```

Verbose mode:

```bash
node dist/cli.js run-once --verbose
```

Or continuous polling:

```bash
node dist/cli.js loop
```

## GitHub token permissions

For a fine-grained GitHub token, grant at least these repository permissions:

- `Metadata: Read`
- `Contents: Read and write`
- `Issues: Read`
- `Pull requests: Read and write`
- `Checks: Read`
- `Commit statuses: Read`

Why these are needed:

- `Issues: Read` for issue pickup and issue detail fetches
- `Pull requests: Read and write` for PR creation, PR body updates, and PR comment inspection
- `Contents: Read and write` so the pushed branch can be updated through normal git authentication
- `Checks: Read` and `Commit statuses: Read` for reacting to failing PR checks
- `Metadata: Read` as the baseline repository scope

## Solver contract

The bot does not hardcode one model runtime. Instead it executes `CODEBOT_SOLVER_COMMAND` in the worktree with these environment variables:

- `CODEBOT_MODEL`
- `CODEBOT_ISSUE_NUMBER`
- `CODEBOT_ISSUE_TITLE`
- `CODEBOT_ISSUE_BODY`
- `CODEBOT_ISSUE_URL`
- `CODEBOT_WORKSPACE_PATH`
- `CODEBOT_REPO_PATH`
- `CODEBOT_BRANCH_NAME`
- `CODEBOT_REVIEW_COMMENTS_JSON` during PR feedback or failing-check follow-up
- `CODEBOT_ACTION` for specialized flows such as `reorganize`

If the solver exits `0`, the bot inspects git for changes and continues. Any non-zero exit code marks the attempt as failed.

The default local solver script is [`scripts/solve-issue.js`](/Users/sh/Work/tutory/tutoryCodeBot/scripts/solve-issue.js). It uses the local `@openai/codex` CLI if installed in `node_modules`, otherwise it falls back to `codex` from `PATH`.

By default the bot uses `CODEBOT_MODEL=gpt-5.4`. Change that in [.env](/Users/sh/Work/tutory/tutoryCodeBot/.env) if you want a different Codex model.

Runtime artifacts are stored under `.codebot/` by default:

- `.codebot/state.json` for tracked task state
- `.codebot/runs/` for saved solver run snapshots

If you are testing with a personal token on your own account, set `CODEBOT_IGNORE_SELF_COMMENTS=false` so your own PR comments are treated as input. When you switch to a dedicated bot account, set it back to `true`.

Set `CODEBOT_CREATE_DRAFT_PRS=true` if new PRs should be opened as drafts. The default is `false`.

Set `CODEBOT_GITHUB_COMMENT_PREFIX` to control how bot-authored GitHub comments are prefixed. The default is `🤖`.

Branch and commit naming can be configured with simple templates:

- `CODEBOT_BRANCH_NAME_TEMPLATE`
- `CODEBOT_COMMIT_MESSAGE_TEMPLATE`

Supported placeholders:

- `{branchType}`: `FIX` or `ENH`
- `{issueNumber}`
- `{slug}`
- `{title}`
- `{reason}` for commit messages

Defaults:

- branch: `{branchType}-{issueNumber}-{slug}`
- commit: `#{issueNumber}: {reason}`

You can keep repository-specific coding rules in a local [CODEBOT_STYLE.md](/Users/sh/Work/tutory/tutoryCodeBot/CODEBOT_STYLE.md). That file is ignored by git.

Use [CODEBOT_STYLE.example.md](/Users/sh/Work/tutory/tutoryCodeBot/CODEBOT_STYLE.example.md) as the checked-in template. The solver prefers `CODEBOT_STYLE.md` and falls back to the example file if no local style file exists.

## PR follow-up

For tracked PRs, the bot currently reacts to:

- PR diff comments
- PR thread comments
- failing GitHub checks on the PR head commit

The bot ignores comments that start with `CODEBOT_GITHUB_COMMENT_PREFIX`, which prevents it from reacting to its own visible status comments.

When the bot creates or revisits a tracked PR, it ensures the PR body contains a `Bot actions` section. Checking one of these boxes in the PR body triggers the action on the next run:

- `rebase`
- `rebase + reorganize`

As a fallback, the same commands are also supported as plain PR comments.

`reorganize` is still supported as a plain PR comment command.

If a PR feedback or action run fails, the bot posts a prefixed failure comment on the PR thread.

## Suggested rollout

Phase 1

- Run in `CODEBOT_DRY_RUN=true`.
- Only select issues with the easy label.
- Post draft PRs.
- Keep a human review gate before merge.

Phase 2

- Add Slack notifications for started, blocked, and completed tasks.
- Let the bot ask before taking unlabeled issues.

Phase 3

- Sync GitHub issue/PR state with Zube.
- Use Zube lanes to constrain what the bot may pick up.

## Recommended policies

- Dedicate a GitHub user to the bot.
- Restrict branch naming with `FIX-<ticketNumber>-<slug>` or `ENH-<ticketNumber>-<slug>`.
- Use `FIX` only for issues carrying the configured bug label, otherwise `ENH`.
- Use commit messages in the form `#<issueNumber>: why it was changed`.
- Require checks to pass before merge.
- Limit auto-triage to labels the team trusts.
- Persist bot state externally if you want multiple bot workers.
