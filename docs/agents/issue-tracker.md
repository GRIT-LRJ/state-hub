# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI for all operations.

## Conventions

- Create issues with `gh issue create`.
- Read issues and comments with `gh issue view`.
- List and filter issues with `gh issue list`.
- Comment with `gh issue comment`.
- Apply or remove labels with `gh issue edit`.
- Close issues with `gh issue close`.
- Infer the repository from the configured Git remote.
- Pull requests are not treated as triage requests.

## Publishing

When a skill says "publish to the issue tracker", create a GitHub issue in `GRIT-LRJ/state-hub`.

When a skill says "fetch the relevant ticket", read the GitHub issue, including its labels and comments.

## Wayfinding operations

A wayfinding map is one GitHub issue labelled `wayfinder:map`; its work items are child issues labelled by type.

- Link children using GitHub sub-issues when available.
- Represent blocking relationships with native issue dependencies.
- Fall back to task lists and `Blocked by:` lines when native features are unavailable.
- Claim work by assigning the issue to the active GitHub user.
- Resolve work by recording the result, closing the child issue, and updating the map.
