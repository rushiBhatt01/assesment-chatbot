import { AsyncLocalStorage } from 'async_hooks';
import { query } from '../database/db';
import crypto from 'crypto';

export interface AsyncRequestContext {
  isAsync: boolean;
  question: string;
}

export const asyncLocalStorage = new AsyncLocalStorage<AsyncRequestContext>();

/**
 * Checks if the current execution is within an asynchronous request context.
 * If yes, it creates a job in PENDING status and returns the tracking handle.
 * Otherwise, it returns null, indicating the tool should run synchronously.
 */
export async function checkAndTriggerAsync(toolName: string, args: any): Promise<{ job_id: string; status: 'running' } | null> {
  const context = asyncLocalStorage.getStore();
  if (context && context.isAsync) {
    const jobId = crypto.randomUUID();
    await query(
      `INSERT INTO async_execution_jobs (job_id, status, payload_input)
       VALUES ($1, 'PENDING', $2)`,
      [jobId, JSON.stringify({ question: context.question, tool: toolName, args })]
    );
    return { job_id: jobId, status: 'running' };
  }
  return null;
}
