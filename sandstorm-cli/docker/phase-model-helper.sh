#!/bin/bash
#
# Phase-model routing helper for the sandstorm task runner.
#
# Provides model_args_for_phase() — call before each run_claude invocation
# to resolve the correct --model arg for that phase.
#
# Reads globals: PHASE_MODELS_JSON, MODEL_ARGS, TASK_MODEL, log_loop
# Writes global: RESOLVED_MODEL_ARGS
#
# Usage:
#   source /usr/bin/phase-model-helper.sh
#   model_args_for_phase execution
#   run_claude ... "${RESOLVED_MODEL_ARGS[@]}"

# Select --model args for a given phase from the per-phase model map.
# Sets global RESOLVED_MODEL_ARGS to the appropriate --model arg array.
# Falls back to MODEL_ARGS (single-task model) when:
#   - PHASE_MODELS_JSON is empty/absent
#   - The phase key is missing from the JSON
#   - The model value is an OpenCode provider/model (contains '/')
# Logs the resolved model to the loop log.
model_args_for_phase() {
  local phase="$1"
  local m=""

  if [ -n "${PHASE_MODELS_JSON:-}" ]; then
    m=$(printf '%s' "$PHASE_MODELS_JSON" | jq -r --arg p "$phase" '.[$p] // empty' 2>/dev/null || true)
  fi

  if [ -z "$m" ]; then
    # Phase key missing from map or JSON absent — fall back to task model
    RESOLVED_MODEL_ARGS=("${MODEL_ARGS[@]}")
    if [ -n "${TASK_MODEL:-}" ]; then
      log_loop "phase=$phase model=${TASK_MODEL} (task fallback)"
    fi
    return
  fi

  if [[ "$m" == *"/"* ]]; then
    # OpenCode provider/model (contains '/') — not runnable in this image
    log_loop "WARNING: phase=$phase model='$m' requires OpenCode backend (not available); using task model"
    RESOLVED_MODEL_ARGS=("${MODEL_ARGS[@]}")
    if [ -n "${TASK_MODEL:-}" ]; then
      log_loop "phase=$phase model=${TASK_MODEL} (task fallback)"
    fi
    return
  fi

  if [ "$m" = "auto" ]; then
    RESOLVED_MODEL_ARGS=()
    log_loop "phase=$phase model=auto"
  else
    RESOLVED_MODEL_ARGS=(--model "$m")
    log_loop "phase=$phase model=$m"
  fi
}
