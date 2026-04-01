# Create PR

Create a pull request. Jira projects still use git hosting for PRs — this uses `gh` CLI by default.

## Usage

```bash
.sandstorm/scripts/create-pr.sh --title <title> --body <body> --base <branch> --head <branch>
```

If your project uses GitLab or Bitbucket instead of GitHub, replace this script with the appropriate CLI.

## Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--title` | Yes | PR title |
| `--body` | No | PR description body |
| `--base` | No | Base branch (default: main) |
| `--head` | No | Head branch (default: current branch) |
