#!/bin/bash
#
# clone.sh — workspace clone helpers for Sandstorm stack creation.
#
# Sourced by lib/stack.sh and the test suite.

# clone_workspace: shallow-clone a git remote into a workspace directory.
#
# Usage: clone_workspace <remote_url> <branch> <workspace>
#
# Branch handling:
#   - If <branch> exists on the remote: clone it directly with
#     --depth 1 --single-branch --branch <branch>
#   - If <branch> does NOT exist on the remote (new feature branch): clone the
#     remote's default branch with --depth 1 --single-branch, then create
#     <branch> locally with git checkout -b
clone_workspace() {
  local remote_url="$1"
  local branch="$2"
  local workspace="$3"

  if git ls-remote --heads "$remote_url" "$branch" 2>/dev/null | grep -q .; then
    # Branch exists on remote — clone it directly
    git clone --depth 1 --single-branch --branch "$branch" \
      "$remote_url" "$workspace" > /dev/null 2>&1
  else
    # Branch is new — clone the default branch, then create the branch locally
    git clone --depth 1 --single-branch "$remote_url" "$workspace" > /dev/null 2>&1
    git -C "$workspace" checkout -b "$branch"
  fi
}
