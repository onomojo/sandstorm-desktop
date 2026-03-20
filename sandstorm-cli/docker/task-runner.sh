#!/bin/bash
#
# Sandstorm task runner — watches for task triggers and executes them.
# Runs as PID 1 so all output goes to docker logs.
#

echo "Waiting for tasks..."

while true; do
  if [ -f /tmp/claude-task-trigger ]; then
    rm -f /tmp/claude-task-trigger
    PROMPT=$(cat /tmp/claude-task-prompt.txt 2>/dev/null)
    LABEL=$(echo "$PROMPT" | head -1 | cut -c1-60)

    echo ""
    echo "=========================================="
    echo "  Task: $LABEL"
    echo "=========================================="
    echo "running" > /tmp/claude-task.status
    echo $$ > /tmp/claude-task.pid

    # Stream claude output in real-time using --output-format stream-json.
    # With --include-partial-messages, we get raw API streaming events
    # (content_block_delta) that arrive token-by-token. We extract the
    # text deltas with jq for human-readable real-time output in docker logs.
    #
    # Prompt is piped via stdin (-p -) to avoid shell quoting issues with
    # special characters (backticks, $, quotes, etc.) in prompts.
    cat /tmp/claude-task-prompt.txt \
      | claude --dangerously-skip-permissions --verbose --output-format stream-json \
          --include-partial-messages --print -p - 2>&1 \
      | jq -rj --unbuffered '
          if .type == "stream_event" then
            if .event.type == "content_block_delta" and .event.delta.type == "text_delta" then
              .event.delta.text
            elif .event.type == "content_block_delta" and .event.delta.type == "input_json_delta" then
              empty
            elif .event.type == "content_block_start" and .event.content_block.type == "tool_use" then
              "\n[" + .event.content_block.name + "] "
            else
              empty
            end
          elif .type == "assistant" then
            (.message.content[]? |
              if .type == "tool_use" then
                "\n[" + .name + ": " + (.input | if .command then .command elif .file_path then .file_path elif .pattern then .pattern elif .prompt then (.prompt | split("\n")[0][:80]) else (tostring[:100]) end) + "]\n"
              elif .type == "text" then
                .text
              else
                empty
              end
            ) // empty
          elif .type == "result" then
            "\n" + (.result // "") + "\n"
          elif .type == "error" then
            "\nERROR: " + (.error.message // "unknown error") + "\n"
          else
            empty
          end
        ' 2>/dev/null \
      | stdbuf -o0 tee /tmp/claude-task.log
    EXIT_CODE=${PIPESTATUS[0]}

    rm -f /tmp/claude-task-prompt.txt
    echo $EXIT_CODE > /tmp/claude-task.exit
    if [ $EXIT_CODE -eq 0 ]; then
      echo "completed" > /tmp/claude-task.status
    else
      echo "failed" > /tmp/claude-task.status
    fi
    rm -f /tmp/claude-task.pid

    echo ""
    echo "=========================================="
    echo "  Task finished (exit: $EXIT_CODE)"
    echo "=========================================="
    echo ""
    echo "Waiting for tasks..."
  fi
  sleep 1
done
