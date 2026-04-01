# Create PR

Create a pull request from the current branch.

## Usage

```bash
.sandstorm/scripts/create-pr.sh --title <title> --body <body> --base <branch> --head <branch>
```

**This script needs to be configured.** Edit `.sandstorm/scripts/create-pr.sh` and replace the placeholder with your git hosting platform's CLI or API call.

## Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--title` | Yes | PR title |
| `--body` | No | PR description body |
| `--base` | No | Base branch (default: main) |
| `--head` | No | Head branch (default: current branch) |
