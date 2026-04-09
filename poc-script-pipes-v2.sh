#!/bin/bash
#
# POC v2: script + named pipes approach
# Fixed to handle ANSI codes in grep matching

set -e

FIFO_DIR=$(mktemp -d)
INPUT_PIPE="$FIFO_DIR/input"
OUTPUT_FILE="$FIFO_DIR/output.txt"

cleanup() {
    rm -rf "$FIFO_DIR"
    [ -n "$SCRIPT_PID" ] && kill "$SCRIPT_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== script + named pipes POC v2 ==="

mkfifo "$INPUT_PIPE"

echo "[1] Starting mock Claude via script..."

# Start script in background
script -q -c "node /app/poc-mock-claude.cjs < '$INPUT_PIPE'" "$OUTPUT_FILE" &
SCRIPT_PID=$!

# Open pipe for writing
exec 3>"$INPUT_PIPE"

echo "[2] Waiting for ready..."
READY=false
for i in $(seq 1 60); do
    sleep 0.5
    if [ -f "$OUTPUT_FILE" ]; then
        # Strip ANSI then check
        CLEAN=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g' "$OUTPUT_FILE" 2>/dev/null)
        if echo "$CLEAN" | grep -q "for shortcuts"; then
            READY=true
            echo "[3] Ready! (after ${i} iterations)"
            break
        fi
    fi
done

if [ "$READY" = false ]; then
    echo "[!] Not ready. Debug output:"
    [ -f "$OUTPUT_FILE" ] && xxd "$OUTPUT_FILE" | head -20
    exit 1
fi

sleep 0.5
echo "[4] Injecting /usage..."
echo "/usage" >&3

echo "[5] Waiting for usage output..."
FOUND=false
for i in $(seq 1 30); do
    sleep 0.5
    CLEAN=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g' "$OUTPUT_FILE" 2>/dev/null)
    if echo "$CLEAN" | grep -q "Current session"; then
        FOUND=true
        echo "[6] Usage captured!"
        sleep 1
        break
    fi
done

echo ""
echo "--- CLEANED OUTPUT ---"
sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g' "$OUTPUT_FILE" 2>/dev/null
echo "--- END ---"

# Parse
PERCENT=$(sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' "$OUTPUT_FILE" 2>/dev/null | grep -o '[0-9]*% used' | head -1)
echo ""
if [ -n "$PERCENT" ]; then
    echo "SUCCESS: Parsed: $PERCENT"
else
    echo "RESULT: Could not parse percentage"
fi

echo "/exit" >&3
exec 3>&-
sleep 1
echo "[Done]"
