# Agent Operating Notes

- Treat the directory you start in (repo root or worktree root) as your boundary. Stay inside it—no `cd` above it and no touching sibling repositories.
- When asked to merge, keep this worktree on its branch. Note the branch name with `git rev-parse --abbrev-ref HEAD`. Use `git worktree list --porcelain` to find the worktree whose `branch` entry is `refs/heads/main`, then run `git -C <main-worktree-path> merge <current-branch>` so the merge happens in the primary repo without leaving this directory. Keep everything local unless the user explicitly authorizes remote operations.
- Before wrapping up, verify that every action respected these boundaries.
