import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { query } from '../../database/db';

export const retrieveAsyncJobResultTool = createTool({
  id: 'retrieve-async-job-result',
  description: 'Retrieves the computed data payload of an asynchronous job by its job_id.',
  inputSchema: z.object({
    jobId: z.string().uuid().describe('The UUID of the async job to retrieve results for.'),
  }),
  outputSchema: z.object({
    payload_input: z.any().optional(),
    payload_output: z.any().optional(),
    status: z.string(),
    error_log: z.string().nullable().optional(),
  }),
  execute: async ({ jobId }) => {
    const result = await query(
      `SELECT status, payload_input, payload_output, error_log FROM async_execution_jobs WHERE job_id = $1`,
      [jobId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Job ${jobId} not found.`);
    }
    const row = result.rows[0];
    return {
      status: row.status,
      payload_input: row.payload_input,
      payload_output: row.payload_output,
      error_log: row.error_log,
    };
  },
});
