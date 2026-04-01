# Create PR

Create a pull request from the current branch.

## Usage

Run the project's create-pr script:

```bash
.sandstorm/scripts/create-pr.sh --title <title> --body <body> --base <branch> --head <branch>
```

## Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--title` | Yes | PR title |
| `--body` | No | PR description body |
| `--base` | No | Base branch (default: main) |
| `--head` | No | Head branch (default: current branch) |

## Examples

```bash
.sandstorm/scripts/create-pr.sh --title "Fix auth bug" --body "Fixes #42" --base main
```
