#!/bin/bash
#
# POC: script + named pipes approach for Claude Code /usage collection
#
# Uses the `script` command (built into macOS and Linux) with named pipes
# to inject commands and capture output from Claude Code.
#
# Usage: bash poc-script-pipes.sh

set -e

FIFO_DIR=$(mktemp -d)
INPUT_PIPE="$FIFO_DIR/input"
OUTPUT_FILE="$FIFO_DIR/output.txt"
READY_TIMEOUT=30
USAGE_TIMEOUT=15

cleanup() {
    rm -rf "$FIFO_DIR"
    # Kill any leftover processes
    if [ -n "$SCRIPT_PID" ]; then
        kill "$SCRIPT_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "=== script + named pipes POC ==="
echo ""

# Create named pipe for input
mkfifo "$INPUT_PIPE"

echo "[1] Starting Claude via script command with named pipe input..."

# Use `script` to capture terminal output while feeding input from named pipe
# macOS: script -q output_file command
# Linux: script -q -c "command" output_file
if [[ "$(uname)" == "Darwin" ]]; then
    script -q "$OUTPUT_FILE" bash -c "node poc-mock-claude.cjs < '$INPUT_PIPE'" &
else
    script -q -c "node poc-mock-claude.cjs < '$INPUT_PIPE'" "$OUTPUT_FILE" &
fi
SCRIPT_PID=$!

# We need to open the pipe for writing and keep it open
exec 3>"$INPUT_PIPE"

echo "[2] Waiting for Claude to be ready..."
READY=false
for i in $(seq 1 $((READY_TIMEOUT * 4))); do
    sleep 0.25
    if [ -f "$OUTPUT_FILE" ] && grep -q "for shortcuts" "$OUTPUT_FILE" 2>/dev/null; then
        READY=true
        echo "[3] Claude prompt detected!"
        break
    fi
done

if [ "$READY" = false ]; then
    echo "[!] Claude did not become ready within ${READY_TIMEOUT}s"
    if [ -f "$OUTPUT_FILE" ]; then
        echo "[DEBUG] Output so far:"
        cat "$OUTPUT_FILE"
    fi
    exit 1
fi

sleep 0.5

echo "[4] Injecting /usage command..."
echo "/usage" >&3

echo "[5] Waiting for usage output..."
USAGE_FOUND=false
for i in $(seq 1 $((USAGE_TIMEOUT * 4))); do
    sleep 0.25
    if grep -q "Current session" "$OUTPUT_FILE" 2>/dev/null; then
        USAGE_FOUND=true
        echo "[6] Usage output captured!"
        sleep 1  # Let it fully render
        break
    fi
done

if [ "$USAGE_FOUND" = false ]; then
    echo "[!] Usage output not found within ${USAGE_TIMEOUT}s"
fi

echo ""
echo "--- CAPTURED OUTPUT ---"
if [ -f "$OUTPUT_FILE" ]; then
    # Strip ANSI codes
    sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$OUTPUT_FILE"
else
    echo "(no output file)"
fi
echo "--- END ---"

# Try to parse percent from output
if [ -f "$OUTPUT_FILE" ]; then
    PERCENT=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$OUTPUT_FILE" | grep -o '[0-9]*% used' | head -1)
    if [ -n "$PERCENT" ]; then
        echo ""
        echo "SUCCESS: Parsed usage: $PERCENT"
    else
        echo ""
        echo "PARTIAL: Could not parse usage percentage"
    fi
fi

# Clean exit
echo "/exit" >&3
exec 3>&-
sleep 1

echo ""
echo "[Done]"
