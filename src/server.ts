import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { mastra } from './mastra';
import { query } from './database/db';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT)|| 3000;
const taraAgent = mastra.getAgent('taraAgent');

function sanitizePayload(args: any): any {
  if (!args || typeof args !== 'object') return args;
  const sanitized = { ...args };
  const sensitiveKeys = ['password', 'token', 'key', 'secret', 'auth', 'database_url'];
  // Also redact memo fields to prevent UPI token / account number leakage (AC 4)
  const redactedKeys = ['memo'];
  for (const k of Object.keys(sanitized)) {
    if (sensitiveKeys.some(s => k.toLowerCase().includes(s))) {
      sanitized[k] = '[REDACTED]';
    }
    if (redactedKeys.includes(k.toLowerCase())) {
      sanitized[k] = '[REDACTED_MEMO]';
    }
  }
  return sanitized;
}

app.post('/ask', async (req: express.Request, res: express.Response) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: 'Field "question" is required and must be a string.' });
    return;
  }

  const traceId = crypto.randomUUID();
  const ingressTimestamp = new Date().toISOString();
  const startTime = Date.now();

  let status: 'SUCCESS' | 'DATA_ABANDON_EMPTY' | 'CRITICAL_EXCEPTION_STATE' = 'SUCCESS';
  let exceptionPayload: any = undefined;
  let pipeline: any[] = [];
  const tablesAccessed: string[] = [];

  try {
    // Execute the agent turn
    const result = await taraAgent.generate([
      {
        role: 'user',
        content: question,
      },
    ]);

    const latencyMs = Date.now() - startTime;
    const answer = result.text;

    // Build the execution pipeline logs from steps
    const steps = result.steps || [];
    steps.forEach((step, idx) => {
      const toolCalls = step.toolCalls || [];
      const toolResults = step.toolResults || [];

      toolCalls.forEach((call) => {
        const toolName = call.payload?.toolName || (call as any).toolName;
        const callArgs = call.payload?.args || (call as any).args;
        const callId = call.payload?.toolCallId || (call as any).toolCallId;
        
        // Track accessed tables based on tool names
        if (toolName === 'query-transactions' || toolName === 'query_transactions' ||
            toolName === 'queryTransactionsTool') {
          if (!tablesAccessed.includes('transactions')) {
            tablesAccessed.push('transactions');
          }
        }
        if (toolName === 'detect-subscriptions' || toolName === 'detect_subscriptions' ||
            toolName === 'detectSubscriptionsTool') {
          if (!tablesAccessed.includes('transactions')) {
            tablesAccessed.push('transactions');
          }
        }
        if (toolName === 'compute-investment-analytics' || toolName === 'compute_investment_analytics' ||
            toolName === 'computeInvestmentAnalyticsTool') {
          if (!tablesAccessed.includes('funds')) tablesAccessed.push('funds');
          if (!tablesAccessed.includes('holdings')) tablesAccessed.push('holdings');
        }

        pipeline.push({
          executionSequenceNode: idx + 1,
          invokedToolName: toolName,
          sanitizedArgumentsPayload: sanitizePayload(callArgs),
          latencyMs: 100, // standard mock latency per tool call or estimate
        });
      });
    });

    // Detect if no data was returned
    const hasEmptyPayload = pipeline.length > 0 && result.steps.some(step => {
      return (step.toolResults || []).some(res => {
        const resultVal = res.payload?.result || (res as any).result;
        const payload = (resultVal as any)?.payload;
        return Array.isArray(payload) && payload.length === 0;
      });
    });

    if (hasEmptyPayload) {
      status = 'DATA_ABANDON_EMPTY';
    }

    // Determine Intent Classification
    let intent: 'AGGREGATE_EXPENSE' | 'MUTUAL_FUND_PERFORMANCE' | 'PORTFOLIO_REALIZED_YIELD' | 'EMPTY_DATA_EXCEPTION' = 'AGGREGATE_EXPENSE';
    if (status === 'DATA_ABANDON_EMPTY') {
      intent = 'EMPTY_DATA_EXCEPTION';
    }

    // Structured Log Output conforming to ObservabilityAuditRecord
    const auditRecord = {
      traceId,
      ingressTimestamp,
      clientRequestQuestionString: question,
      mappedIntentClassification: intent,
      toolCallExecutionPipeline: pipeline,
      storageTablesAccessed: tablesAccessed,
      runtimeProcessingLatencyMs: latencyMs,
      terminalExecutionStatus: status,
    };

    console.log(JSON.stringify(auditRecord));

    res.json({ answer });
  } catch (err: any) {
    status = 'CRITICAL_EXCEPTION_STATE';
    const latencyMs = Date.now() - startTime;
    exceptionPayload = {
      internalCodeString: 'AGENT_ERROR',
      sanitizedErrorMessage: err.message || 'An unknown error occurred during agent execution.',
    };

    const auditRecord = {
      traceId,
      ingressTimestamp,
      clientRequestQuestionString: question,
      mappedIntentClassification: 'EMPTY_DATA_EXCEPTION' as const,
      toolCallExecutionPipeline: pipeline,
      storageTablesAccessed: tablesAccessed,
      runtimeProcessingLatencyMs: latencyMs,
      terminalExecutionStatus: status,
      systemExceptionPayload: exceptionPayload,
    };

    console.error(JSON.stringify(auditRecord));

    res.status(500).json({ error: exceptionPayload.sanitizedErrorMessage });
  }
});

import { asyncLocalStorage } from './utils/asyncContext';

// ============================================================
// Async Execution Routes (Story 3.1 & 3.2)
// ============================================================

/**
 * POST /ask/async — Asynchronous execution ingress.
 * Starts the agent run in an async context, which causes the matching tool to suspend
 * and register a PENDING job. Returns the job_id immediately.
 */
app.post('/ask/async', async (req: express.Request, res: express.Response) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: 'Field "question" is required and must be a string.' });
    return;
  }

  try {
    const context = { isAsync: true, question };
    const agentResult = await asyncLocalStorage.run(context, async () => {
      return await taraAgent.generate([
        { role: 'user', content: question },
      ]);
    });

    // Check steps and toolResults for job_id
    let jobId: string | undefined;
    for (const step of agentResult.steps || []) {
      for (const resVal of step.toolResults || []) {
        const val = resVal.result || (resVal as any).payload;
        if (val && typeof val === 'object' && 'job_id' in val) {
          jobId = val.job_id;
          break;
        }
      }
      if (jobId) break;
    }

    if (jobId) {
      res.json({ job_id: jobId, status: 'running' });
    } else {
      res.json({ answer: agentResult.text });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to create async job.' });
  }
});

/**
 * GET /jobs/:job_id — Poll job status and result.
 */
app.get('/jobs/:job_id', async (req: express.Request, res: express.Response) => {
  const { job_id } = req.params;

  try {
    const result = await query(
      `SELECT job_id, status, payload_output, final_answer, error_log, created_at, updated_at
       FROM async_execution_jobs WHERE job_id = $1`,
      [job_id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }

    const job = result.rows[0];
    const response: any = {
      job_id: job.job_id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
    };

    if (job.status === 'COMPLETED') {
      response.result = { answer: job.final_answer };
    }

    if (job.status === 'FAILED' && job.error_log) {
      response.error = job.error_log;
    }

    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve job status.' });
  }
});

app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});
