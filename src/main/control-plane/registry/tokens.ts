import Database from 'better-sqlite3';
import type { TaskTokenStep, TokenValidationResult, TokenUsage, TaskPhaseWeightRow } from '../registry';

export class TokensModule {
  constructor(private db: Database.Database) {}

  updateTaskTokens(
    taskId: number,
    inputTokens: number,
    outputTokens: number,
    phaseBreakdown?: {
      executionInput: number;
      executionOutput: number;
      reviewInput: number;
      reviewOutput: number;
    },
    cacheTokens?: {
      cacheRead: number;
      cacheCreation: number;
    }
  ): void {
    const updateFn = this.db.transaction(() => {
      const old = this.db.prepare(
        'SELECT stack_id, input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens, cache_read_tokens, cache_creation_tokens FROM tasks WHERE id = ?'
      ).get(taskId) as {
        stack_id: string;
        input_tokens: number;
        output_tokens: number;
        execution_input_tokens: number;
        execution_output_tokens: number;
        review_input_tokens: number;
        review_output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
      } | undefined;
      if (!old) return;

      const inputDelta = inputTokens - old.input_tokens;
      const outputDelta = outputTokens - old.output_tokens;
      const cacheReadDelta = (cacheTokens?.cacheRead ?? old.cache_read_tokens) - old.cache_read_tokens;
      const cacheCreationDelta = (cacheTokens?.cacheCreation ?? old.cache_creation_tokens) - old.cache_creation_tokens;

      if (phaseBreakdown) {
        const execInDelta = phaseBreakdown.executionInput - old.execution_input_tokens;
        const execOutDelta = phaseBreakdown.executionOutput - old.execution_output_tokens;
        const revInDelta = phaseBreakdown.reviewInput - old.review_input_tokens;
        const revOutDelta = phaseBreakdown.reviewOutput - old.review_output_tokens;

        this.db.prepare(
          'UPDATE tasks SET input_tokens = ?, output_tokens = ?, execution_input_tokens = ?, execution_output_tokens = ?, review_input_tokens = ?, review_output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ?'
        ).run(
          inputTokens, outputTokens,
          phaseBreakdown.executionInput, phaseBreakdown.executionOutput,
          phaseBreakdown.reviewInput, phaseBreakdown.reviewOutput,
          cacheTokens?.cacheRead ?? old.cache_read_tokens,
          cacheTokens?.cacheCreation ?? old.cache_creation_tokens,
          taskId
        );

        if (inputDelta !== 0 || outputDelta !== 0 || execInDelta !== 0 || execOutDelta !== 0 || revInDelta !== 0 || revOutDelta !== 0 || cacheReadDelta !== 0 || cacheCreationDelta !== 0) {
          this.db.prepare(
            `UPDATE stacks SET
              total_input_tokens = total_input_tokens + ?,
              total_output_tokens = total_output_tokens + ?,
              total_execution_input_tokens = total_execution_input_tokens + ?,
              total_execution_output_tokens = total_execution_output_tokens + ?,
              total_review_input_tokens = total_review_input_tokens + ?,
              total_review_output_tokens = total_review_output_tokens + ?,
              total_cache_read_tokens = total_cache_read_tokens + ?,
              total_cache_creation_tokens = total_cache_creation_tokens + ?
            WHERE id = ?`
          ).run(inputDelta, outputDelta, execInDelta, execOutDelta, revInDelta, revOutDelta, cacheReadDelta, cacheCreationDelta, old.stack_id);
        }
      } else {
        this.db.prepare(
          'UPDATE tasks SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ?'
        ).run(inputTokens, outputTokens, cacheTokens?.cacheRead ?? old.cache_read_tokens, cacheTokens?.cacheCreation ?? old.cache_creation_tokens, taskId);

        if (inputDelta !== 0 || outputDelta !== 0 || cacheReadDelta !== 0 || cacheCreationDelta !== 0) {
          this.db.prepare(
            'UPDATE stacks SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ?, total_cache_read_tokens = total_cache_read_tokens + ?, total_cache_creation_tokens = total_cache_creation_tokens + ? WHERE id = ?'
          ).run(inputDelta, outputDelta, cacheReadDelta, cacheCreationDelta, old.stack_id);
        }
      }
    });
    updateFn();
  }

  setTaskSessionId(taskId: number, sessionId: string): void {
    this.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(sessionId, taskId);
  }

  setTaskIterations(taskId: number, reviewIterations: number, verifyRetries: number): void {
    this.db.prepare(
      'UPDATE tasks SET review_iterations = ?, verify_retries = ? WHERE id = ?'
    ).run(reviewIterations, verifyRetries, taskId);
  }

  updateTaskMetadata(taskId: number, metadata: {
    review_verdicts?: string;
    verify_outputs?: string;
    execute_outputs?: string;
    execution_summary?: string;
    execution_started_at?: string;
    execution_finished_at?: string;
    review_started_at?: string;
    review_finished_at?: string;
    verify_started_at?: string;
    verify_finished_at?: string;
  }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return;
    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  setTaskTokenSteps(taskId: number, steps: { iteration: number; phase: string; input_tokens: number; output_tokens: number }[]): void {
    const insertOrUpdate = this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_token_steps WHERE task_id = ?').run(taskId);
      const insert = this.db.prepare(
        'INSERT INTO task_token_steps (task_id, iteration, phase, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
      );
      for (const step of steps) {
        insert.run(taskId, step.iteration, step.phase, step.input_tokens, step.output_tokens);
      }
    });
    insertOrUpdate();
  }

  getTaskTokenSteps(taskId: number): TaskTokenStep[] {
    return this.db.prepare(
      "SELECT * FROM task_token_steps WHERE task_id = ? ORDER BY iteration ASC, CASE phase WHEN 'execution' THEN 0 WHEN 'review' THEN 1 WHEN 'verify' THEN 2 ELSE 99 END ASC"
    ).all(taskId) as TaskTokenStep[];
  }

  getStepWeightsByTicket(): { ticket: string; phase: string; totalTokens: number }[] {
    return this.db.prepare(`
      SELECT s.ticket, tts.phase, SUM(tts.input_tokens + tts.output_tokens) AS totalTokens
      FROM task_token_steps tts
      JOIN tasks t ON t.id = tts.task_id
      JOIN stacks s ON s.id = t.stack_id
      WHERE s.ticket IS NOT NULL
      GROUP BY s.ticket, tts.phase
    `).all() as { ticket: string; phase: string; totalTokens: number }[];
  }

  getTaskPhaseTokensByTicket(): TaskPhaseWeightRow[] {
    return this.db.prepare(`
      SELECT s.ticket, 'execution' AS phase,
             SUM(t.execution_input_tokens + t.execution_output_tokens) AS totalTokens
      FROM tasks t
      JOIN stacks s ON s.id = t.stack_id
      WHERE s.ticket IS NOT NULL
      GROUP BY s.ticket
      HAVING SUM(t.execution_input_tokens + t.execution_output_tokens) > 0
      UNION ALL
      SELECT s.ticket, 'review' AS phase,
             SUM(t.review_input_tokens + t.review_output_tokens) AS totalTokens
      FROM tasks t
      JOIN stacks s ON s.id = t.stack_id
      WHERE s.ticket IS NOT NULL
      GROUP BY s.ticket
      HAVING SUM(t.review_input_tokens + t.review_output_tokens) > 0
    `).all() as TaskPhaseWeightRow[];
  }

  validateTaskTokens(taskId: number): TokenValidationResult {
    const task = this.db.prepare(
      'SELECT input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens FROM tasks WHERE id = ?'
    ).get(taskId) as {
      input_tokens: number; output_tokens: number;
      execution_input_tokens: number; execution_output_tokens: number;
      review_input_tokens: number; review_output_tokens: number;
    } | undefined;

    if (!task) {
      return { valid: true, stepTotal: { input: 0, output: 0 }, phaseTotal: { executionInput: 0, executionOutput: 0, reviewInput: 0, reviewOutput: 0 }, taskTotal: { input: 0, output: 0 } };
    }

    const steps = this.getTaskTokenSteps(taskId);

    let stepExecIn = 0, stepExecOut = 0, stepRevIn = 0, stepRevOut = 0;
    let stepTotalIn = 0, stepTotalOut = 0;

    for (const step of steps) {
      stepTotalIn += step.input_tokens;
      stepTotalOut += step.output_tokens;
      if (step.phase === 'execution') {
        stepExecIn += step.input_tokens;
        stepExecOut += step.output_tokens;
      } else if (step.phase === 'review') {
        stepRevIn += step.input_tokens;
        stepRevOut += step.output_tokens;
      }
    }

    const phaseTotalIn = task.execution_input_tokens + task.review_input_tokens;
    const phaseTotalOut = task.execution_output_tokens + task.review_output_tokens;

    const stepsMatchPhases =
      stepExecIn === task.execution_input_tokens &&
      stepExecOut === task.execution_output_tokens &&
      stepRevIn === task.review_input_tokens &&
      stepRevOut === task.review_output_tokens;

    const phasesMatchTotal =
      phaseTotalIn <= task.input_tokens &&
      phaseTotalOut <= task.output_tokens;

    return {
      valid: steps.length === 0 || (stepsMatchPhases && phasesMatchTotal),
      stepTotal: { input: stepTotalIn, output: stepTotalOut },
      phaseTotal: {
        executionInput: task.execution_input_tokens,
        executionOutput: task.execution_output_tokens,
        reviewInput: task.review_input_tokens,
        reviewOutput: task.review_output_tokens,
      },
      taskTotal: { input: task.input_tokens, output: task.output_tokens },
    };
  }

  interruptTask(taskId: number): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'interrupted', finished_at = datetime('now') WHERE id = ? AND status = 'running'"
    ).run(taskId);
  }

  setTaskResumedAt(taskId: number, ts: string): void {
    this.db.prepare('UPDATE tasks SET resumed_at = ? WHERE id = ?').run(ts, taskId);
  }

  getStackTokenUsage(stackId: string): TokenUsage {
    const row = this.db.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM stacks WHERE id = ?'
    ).get(stackId) as { total_input_tokens: number; total_output_tokens: number } | undefined;
    return {
      input_tokens: row?.total_input_tokens ?? 0,
      output_tokens: row?.total_output_tokens ?? 0,
    };
  }
}
