import { query } from '../database/db';
import { pgDataRepository } from '../database/pgRepo';
import { detectSubscriptions } from '../database/subscriptionDetection';
import { calculatePeriodReturn, calculateHoldingReturn } from '../database/fundAnalytics';
import { taraAgent } from '../mastra/agents/tara-agent';

let running = true;
const intervalMs = 1500;

async function processPendingJobs() {
  // Find one PENDING job
  const selectResult = await query(
    `SELECT job_id, payload_input FROM async_execution_jobs
     WHERE status = 'PENDING'
     ORDER BY created_at ASC
     LIMIT 1`
  );

  if (selectResult.rows.length === 0) {
    return;
  }

  const job = selectResult.rows[0];
  const jobId = job.job_id;
  const input = job.payload_input;

  console.log(`Processing async job ${jobId}...`);

  try {
    // 1. Mark status as RUNNING
    await query(
      `UPDATE async_execution_jobs
       SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP
       WHERE job_id = $1`,
      [jobId]
    );

    // 2. Perform the computation based on tool name
    const { tool, args } = input;
    let output: any;

    if (tool === 'query-transactions') {
      const startIso = new Date(args.startDate).toISOString();
      const endIso = new Date(args.endDate).toISOString();

      const result = await pgDataRepository.advancedLedgerQuery({
        merchant: args.merchantPattern,
        category: args.categoryFilter,
        start: startIso,
        end: endIso,
        operationMode: args.metricsOperation,
        includeRefunds: args.includeRefunds,
      });
      output = { payload: result };

    } else if (tool === 'detect-subscriptions') {
      const result = await detectSubscriptions({
        minOccurrences: args.minOccurrences,
        amountTolerancePct: args.amountTolerancePct,
        intervalMinDays: args.intervalMinDays,
        intervalMaxDays: args.intervalMaxDays,
      });
      output = { subscriptions: result, count: result.length };

    } else if (tool === 'compute-investment-analytics') {
      let result: any;
      if (args.operation === 'PERIOD_RETURN') {
        result = await calculatePeriodReturn({
          fundName: args.fundName,
          startDate: args.startDate,
          endDate: args.endDate,
        });
      } else if (args.operation === 'FUND_RANKING') {
        result = await calculatePeriodReturn({
          startDate: args.startDate,
          endDate: args.endDate,
          rankAll: true,
        });
      } else if (args.operation === 'HOLDING_RETURN') {
        result = await calculateHoldingReturn({
          fundName: args.fundName,
          includeSummary: true,
        });
      } else {
        throw new Error(`Unknown investment analytics operation: ${args.operation}`);
      }
      output = { results: result };

    } else {
      throw new Error(`Unsupported tool type for async execution: ${tool}`);
    }

    // 3. Save payload_output
    await query(
      `UPDATE async_execution_jobs
       SET payload_output = $1, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = $2`,
      [JSON.stringify(output), jobId]
    );

    // 4. Invoke a fresh Mastra agent turn in the background using the synthetic message
    const syntheticMessage = `<async_tool_completion>
  job_id: "${jobId}"
  status: "COMPLETED"
</async_tool_completion>`;

    console.log(`Executing background agent turn for job ${jobId}...`);
    let agentResult: any;
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      try {
        attempts++;
        agentResult = await taraAgent.generate([
          { role: 'user', content: syntheticMessage }
        ]);
        if (!agentResult.text || agentResult.text.trim().length === 0) {
          console.log(`Empty background agent response detected on attempt ${attempts}.`);
          if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
        }
        break;
      } catch (err: any) {
        console.error(`Background agent generation failed on attempt ${attempts}:`, err.message);
        if (attempts >= maxAttempts) {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    const finalAnswer = agentResult.text || '';
    console.log(`Job ${jobId} finished. Final answer: "${finalAnswer.slice(0, 60)}..."`);

    // 5. Update to COMPLETED with final_answer
    await query(
      `UPDATE async_execution_jobs
       SET status = 'COMPLETED', final_answer = $1, updated_at = CURRENT_TIMESTAMP
       WHERE job_id = $2`,
      [finalAnswer, jobId]
    );

  } catch (err: any) {
    console.error(`Error processing job ${jobId}:`, err.message);
    // Mark status as FAILED with error log
    try {
      await query(
        `UPDATE async_execution_jobs
         SET status = 'FAILED', error_log = $1, updated_at = CURRENT_TIMESTAMP
         WHERE job_id = $2`,
        [err.message || 'Unknown processing error', jobId]
      );
    } catch (dbErr: any) {
      console.error(`Failed to update FAILED status for job ${jobId}:`, dbErr.message);
    }
  }
}

async function startWorker() {
  console.log('Background job worker started.');
  while (running) {
    try {
      await processPendingJobs();
    } catch (err: any) {
      console.error('Error in worker loop:', err.message);
    }
    if (running) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  console.log('Background job worker stopped.');
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down worker...');
  running = false;
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down worker...');
  running = false;
});

startWorker();
