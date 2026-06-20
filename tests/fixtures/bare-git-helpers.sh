#!/bin/bash
#
# bare-git-helpers.sh — fixture helpers for tests that need a real git repo.
#
# Source this file after setup_harness (from bash-harness.sh) has been called
# so $tmpdir is available.
#
# Functions:
#
#   make_bare_repo [dest]   — initialise a bare repository at $dest
#                             (default: $tmpdir/bare.git); prints the path
#   make_work_repo [bare]   — clone from $bare (default: $tmpdir/bare.git)
#                             into $tmpdir/work; configures user identity;
#                             creates an initial commit; prints the work-tree path
#
# Usage pattern (in a bash test script):
#
#   source "$(dirname "${BASH_SOURCE[0]}")/../fixtures/bash-harness.sh"
#   source "$(dirname "${BASH_SOURCE[0]}")/../fixtures/bare-git-helpers.sh"
#   setup_harness
#   BARE="$(make_bare_repo)"
#   WORK="$(make_work_repo "$BARE")"
#   # push to $BARE from $WORK as a real remote

make_bare_repo() {
  local dest="${1:-${tmpdir}/bare.git}"
  git init --bare -q "$dest"
  echo "$dest"
}

make_work_repo() {
  local bare="${1:-${tmpdir}/bare.git}"
  local work="${tmpdir}/work"
  git clone -q "$bare" "$work"
  git -C "$work" config user.email "sandstorm-test@example.com"
  git -C "$work" config user.name "Sandstorm Test"
  # Create an initial commit so the repo has a HEAD ref for push tests
  echo "initial" > "${work}/README"
  git -C "$work" add README
  git -C "$work" commit -q -m "initial commit"
  git -C "$work" push -q origin HEAD 2>/dev/null || true
  echo "$work"
}
