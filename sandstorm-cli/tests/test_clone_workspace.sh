#!/bin/bash
#
# Tests for clone_workspace() in sandstorm-cli/lib/stack.sh
#
# Runs entirely with local bare git repos — no network required.
#
# Usage:
#   bash sandstorm-cli/tests/test_clone_workspace.sh
#
# Exit code: 0 if all tests pass, 1 if any fail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "$SCRIPT_DIR/../lib" && pwd)"

# Source the clone helpers (self-contained, no side effects)
source "$LIB_DIR/clone.sh"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
TMPDIR_ROOT=$(mktemp -d)

cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_dir_exists() {
  local dir="$1" label="$2"
  if [ -d "$dir" ]; then pass "$label"; else fail "$label (directory missing: $dir)"; fi
}

assert_branch() {
  local workspace="$1" expected="$2" label="$3"
  local actual
  actual=$(git -C "$workspace" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "ERROR")
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label (expected branch '$expected', got '$actual')"
  fi
}

assert_shallow() {
  local workspace="$1" label="$2"
  # git rev-parse --is-shallow-repository returns "true" for shallow clones (git 2.15+)
  local result
  result=$(git -C "$workspace" rev-parse --is-shallow-repository 2>/dev/null || echo "false")
  if [ "$result" = "true" ]; then
    pass "$label"
  else
    fail "$label (not a shallow clone — git rev-parse --is-shallow-repository returned '$result')"
  fi
}

assert_single_branch() {
  local workspace="$1" label="$2"
  local remote_branches
  remote_branches=$(git -C "$workspace" branch -r 2>/dev/null | wc -l | tr -d ' ')
  if [ "$remote_branches" -le 1 ]; then
    pass "$label"
  else
    fail "$label (expected <=1 remote branch, got $remote_branches)"
  fi
}

# ---------------------------------------------------------------------------
# Setup: create a local bare remote with two branches
# ---------------------------------------------------------------------------

make_remote() {
  local remote_dir="$TMPDIR_ROOT/remote.git"
  mkdir -p "$remote_dir"
  git init --bare "$remote_dir" -q

  # Create a working copy to populate the remote
  local work="$TMPDIR_ROOT/work"
  git -c init.defaultBranch=main clone "file://$remote_dir" "$work" -q 2>/dev/null || true
  git -C "$work" config user.email "test@test.com"
  git -C "$work" config user.name "Test"

  # Commit on main (use HEAD:main so this works regardless of local branch name)
  echo "hello" > "$work/README.md"
  git -C "$work" add README.md
  git -C "$work" commit -m "init" -q
  git -C "$work" push origin HEAD:main -q 2>/dev/null || true
  # Set bare repo HEAD to point at main
  git -C "$remote_dir" symbolic-ref HEAD refs/heads/main 2>/dev/null || true

  # Commit a second time on main (so depth-1 clone is visibly truncated)
  echo "hello again" >> "$work/README.md"
  git -C "$work" add README.md
  git -C "$work" commit -m "second commit on main" -q
  git -C "$work" push origin HEAD:main -q 2>/dev/null || true

  # Create a feature branch on the remote with its own commit
  git -C "$work" checkout -b existing-feature -q
  echo "feature" > "$work/feature.txt"
  git -C "$work" add feature.txt
  git -C "$work" commit -m "add feature" -q
  git -C "$work" push origin existing-feature -q 2>/dev/null || true

  # Return file:// URI so git uses the proper transport (respects --depth)
  echo "file://$remote_dir"
}

REMOTE=$(make_remote)

# ---------------------------------------------------------------------------
# Test 1: Clone an existing remote branch (shallow, single-branch)
# ---------------------------------------------------------------------------

echo ""
echo "Test 1: Clone existing remote branch"
WORKSPACE1="$TMPDIR_ROOT/ws1"
clone_workspace "$REMOTE" "existing-feature" "$WORKSPACE1"

assert_dir_exists "$WORKSPACE1/.git" "workspace .git directory exists"
assert_branch "$WORKSPACE1" "existing-feature" "checked out on existing-feature"
assert_shallow "$WORKSPACE1" "is a shallow clone"
assert_single_branch "$WORKSPACE1" "only one remote tracking branch"

# Verify the feature file is present (correct branch was checked out)
if [ -f "$WORKSPACE1/feature.txt" ]; then
  pass "feature.txt present (correct branch content)"
else
  fail "feature.txt missing (wrong branch content)"
fi

# ---------------------------------------------------------------------------
# Test 2: Clone a new branch (not on remote) — should create locally
# ---------------------------------------------------------------------------

echo ""
echo "Test 2: New branch not on remote"
WORKSPACE2="$TMPDIR_ROOT/ws2"
clone_workspace "$REMOTE" "new-feature-branch" "$WORKSPACE2"

assert_dir_exists "$WORKSPACE2/.git" "workspace .git directory exists"
assert_branch "$WORKSPACE2" "new-feature-branch" "checked out on new-feature-branch"
assert_shallow "$WORKSPACE2" "is a shallow clone"

# The new branch should be based on the default branch (main) — no feature.txt
if [ ! -f "$WORKSPACE2/feature.txt" ]; then
  pass "feature.txt absent (based on default branch)"
else
  fail "feature.txt present (should be based on default branch, not existing-feature)"
fi

# Verify the workspace can commit and would be pushable
git -C "$WORKSPACE2" config user.email "test@test.com"
git -C "$WORKSPACE2" config user.name "Test"
echo "new content" > "$WORKSPACE2/new.txt"
git -C "$WORKSPACE2" add new.txt
if git -C "$WORKSPACE2" commit -m "test commit" -q 2>/dev/null; then
  pass "can commit on new local branch"
else
  fail "cannot commit on new local branch"
fi

# ---------------------------------------------------------------------------
# Test 3: Clone default branch (main) explicitly
# ---------------------------------------------------------------------------

echo ""
echo "Test 3: Clone default branch (main) explicitly"
WORKSPACE3="$TMPDIR_ROOT/ws3"
clone_workspace "$REMOTE" "main" "$WORKSPACE3"

assert_dir_exists "$WORKSPACE3/.git" "workspace .git directory exists"
assert_branch "$WORKSPACE3" "main" "checked out on main"
assert_shallow "$WORKSPACE3" "is a shallow clone"

# ---------------------------------------------------------------------------
# Test 4: Verify --depth 1 means only one commit in history
# ---------------------------------------------------------------------------

echo ""
echo "Test 4: Shallow clone has depth 1 (single commit in log)"
WORKSPACE4="$TMPDIR_ROOT/ws4"
clone_workspace "$REMOTE" "existing-feature" "$WORKSPACE4"

commit_count=$(git -C "$WORKSPACE4" log --oneline 2>/dev/null | wc -l | tr -d ' ')
if [ "$commit_count" -eq 1 ]; then
  pass "git log shows exactly 1 commit (depth 1)"
else
  fail "git log shows $commit_count commits (expected 1 for --depth 1)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
