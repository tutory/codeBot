# Codebot Style Guide

This file is an example for repository-specific coding rules the bot should follow.

Copy it to `CODEBOT_STYLE.md` and adapt it locally. `CODEBOT_STYLE.md` is ignored by git.

## Default guidance

- Preserve existing project conventions before introducing new patterns.
- Keep changes as small and local as possible.
- Prefer fixing the root cause over adding narrow patches.
- Do not refactor unrelated code while working on an issue.
- Add or update tests when behavior changes or bug fixes need coverage.
- Avoid changing public behavior unless the issue explicitly requires it.
- Keep naming and file structure consistent with nearby code.
- Leave comments only when they clarify non-obvious intent.

## Project-specific rules

Add your own guidance here, for example:

- functional style, no classes or prototype, no `this`
- use concise `if` statements without `{}` when they stay on one line and match the surrounding style
- use camelCase for variables, functions, and CSS custom properties
- make sure linting and formatting rules are adhered to
- prefer small pure helper functions over large stateful units
- follow the existing import ordering and do not reformat unrelated imports
- when fixing a bug, add or update the closest existing test instead of creating broad new test scaffolding
- preserve public API shapes and translated user-facing strings unless the issue explicitly requires a change
- prefer existing utilities and shared components over introducing new abstractions
- keep commits and code changes narrowly scoped to the issue or PR feedback
