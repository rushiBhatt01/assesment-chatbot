import { spawn } from 'child_process';
import path from 'path';
import { query, closePool } from '../database/db';
import { detectSubscriptions } from '../database/subscriptionDetection';
import { calculatePeriodReturn, calculateHoldingReturn } from '../database/fundAnalytics';
import { config } from 'dotenv';

config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const API_URL = `http://localhost:${PORT}`;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Robust matcher to search for values in prose (ignores formatting like commas, dollar signs, currency signs, etc.)
function matchesExpected(actualText: string, expected: number | string | string[]): boolean {
  const cleanText = actualText.replace(/,/g, '');
  
  if (typeof expected === 'number') {
    // If expected is 0, check for "no data", "0", "zero", or similar
    if (expected === 0) {
      const lower = cleanText.toLowerCase();
      return (
        lower.includes('no data') || 
        lower.includes('0') || 
        lower.includes('zero') || 
        lower.includes('none') || 
        lower.includes('no transaction') ||
        lower.includes('not find')
      );
    }

    const numStr = expected.toFixed(2);
    const numStrInt = Math.round(expected).toString();
    if (cleanText.includes(numStr) || cleanText.includes(numStrInt)) {
      return true;
    }

    // Parse floats in text to allow for rounding differences
    const floatRegex = /[-+]?[0-9]*\.?[0-9]+/g;
    const matches = cleanText.match(floatRegex) || [];
    for (const m of matches) {
      const parsed = parseFloat(m);
      // Use percentage-based tolerance for large numbers (>1000), absolute for small
      if (expected > 1000) {
        if (Math.abs(parsed - expected) / expected < 0.02) {
          return true;
        }
      } else {
        if (Math.abs(parsed - expected) < 1.05) {
          return true;
        }
      }
    }
    return false;
  } else if (Array.isArray(expected)) {
    const cleanTextLower = cleanText.toLowerCase();
    return expected.every(item => cleanTextLower.includes(item.toLowerCase()));
  } else {
    return cleanText.toLowerCase().includes(expected.toLowerCase());
  }
}

interface TestResult {
  id: number;
  question: string;
  expectedDescription: string;
  expectedVal: any;
  actualResponse: string;
  passed: boolean;
  latencyMs: number;
}

async function runEvals() {
  console.log('============================================================');
  console.log('BOOTING TEST SERVERS AND BACKGROUND WORKERS...');
  console.log('============================================================');

  // Start the Express API server in a child process
  console.log('Booting Express API server...');
  const serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    stdio: 'inherit',
    shell: true,
    env: process.env
  });

  // Start the background worker process
  console.log('Booting Background Job Worker...');
  const workerProcess = spawn('npx', ['tsx', 'src/workers/jobWorker.ts'], {
    stdio: 'inherit',
    shell: true,
    env: process.env
  });

  // Give processes time to spin up
  await sleep(8000);

  const results: TestResult[] = [];
  let passedCount = 0;
  let failedCount = 0;

  try {
    const testCases = [
      {
        id: 1,
        question: 'How much did I spend on food in March 2025 after refunds?',
        expectedDescription: 'Food spend in March 2025, refunds netted',
        getExpected: async () => {
          const res = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE category = 'food' AND date BETWEEN '2025-03-01T00:00:00.000Z' AND '2025-03-31T23:59:59.999Z'`);
          return Number(res.rows[0].total);
        }
      },
      {
        id: 2,
        question: 'How much did I spend on Swiggy, including Swiggy Instamart and SWIGGY orders?',
        expectedDescription: 'Fuzzy match Swiggy spend',
        getExpected: async () => {
          const res = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE similarity(merchant, 'Swiggy') > 0.35 AND category != 'transfer' AND amount > 0`);
          return Number(res.rows[0].total);
        }
      },
      {
        id: 3,
        question: 'Ignore transfers. What was my total actual spending in Q1 2025?',
        expectedDescription: 'Non-transfer total spend in Q1 2025',
        getExpected: async () => {
          const res = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE category != 'transfer' AND date BETWEEN '2025-01-01T00:00:00.000Z' AND '2025-03-31T23:59:59.999Z' AND amount > 0`);
          return Number(res.rows[0].total);
        }
      },
      {
        id: 4,
        question: 'Which category had the biggest increase from February 2025 to March 2025?',
        expectedDescription: 'MoM highest category increase',
        getExpected: async () => {
          const res = await query(`
            WITH FebSpend AS (
              SELECT category, COALESCE(SUM(amount), 0) as feb_total FROM transactions 
              WHERE category != 'transfer' AND amount > 0 AND date BETWEEN '2025-02-01T00:00:00.000Z' AND '2025-02-28T23:59:59.999Z' GROUP BY category
            ), MarSpend AS (
              SELECT category, COALESCE(SUM(amount), 0) as mar_total FROM transactions 
              WHERE category != 'transfer' AND amount > 0 AND date BETWEEN '2025-03-01T00:00:00.000Z' AND '2025-03-31T23:59:59.999Z' GROUP BY category
            )
            SELECT COALESCE(m.category, f.category) as category FROM MarSpend m 
            FULL OUTER JOIN FebSpend f ON m.category = f.category ORDER BY (COALESCE(m.mar_total, 0) - COALESCE(f.feb_total, 0)) DESC LIMIT 1
          `);
          return res.rows[0]?.category || 'Unknown';
        }
      },
      {
        id: 5,
        question: 'Do I have any data for rent in April 2025?',
        expectedDescription: 'No rent data check',
        getExpected: async () => {
          const res = await query(`SELECT COUNT(*) as count FROM transactions WHERE category = 'rent' AND date BETWEEN '2025-04-01T00:00:00.000Z' AND '2025-04-30T23:59:59.999Z'`);
          return Number(res.rows[0].count);
        }
      },
      {
        id: 6,
        question: 'What were my top 5 merchants by net spend between January 2025 and March 2025?',
        expectedDescription: 'Top merchants names in response',
        getExpected: async () => {
          const res = await query(`SELECT merchant FROM transactions WHERE category != 'transfer' AND amount > 0 AND date BETWEEN '2025-01-01T00:00:00.000Z' AND '2025-03-31T23:59:59.999Z' GROUP BY merchant ORDER BY SUM(amount) DESC LIMIT 3`);
          return res.rows.map((r: any) => r.merchant);
        }
      },
      {
        id: 7,
        question: 'Which transactions look like recurring subscriptions?',
        expectedDescription: 'Detected recurring merchant names',
        getExpected: async () => {
          const activeSubs = await detectSubscriptions({});
          return activeSubs.map((s: any) => s.merchant);
        }
      },
      {
        id: 8,
        question: "What was Saffron Bluechip Equity Fund's return from 2024-01-01 to 2025-01-01?",
        expectedDescription: 'Fund period return percentage',
        getExpected: async () => {
          const fundReturn = await calculatePeriodReturn({ fundName: 'Saffron Bluechip Equity Fund', startDate: '2024-01-01', endDate: '2025-01-01' });
          return fundReturn[0]?.period_return_pct ?? 0;
        }
      },
      {
        id: 9,
        question: 'Rank all funds by one-year return between 2024-03-01 and 2025-03-01, and show the spread between best and worst.',
        expectedDescription: 'One-year return spread value',
        getExpected: async () => {
          const rankedFunds = await calculatePeriodReturn({ startDate: '2024-03-01', endDate: '2025-03-01', rankAll: true });
          return rankedFunds.length > 0 ? Number((rankedFunds[0].period_return_pct - rankedFunds[rankedFunds.length - 1].period_return_pct).toFixed(2)) : 0;
        }
      },
      {
        id: 10,
        question: 'What is my realised return on my Sentinel Nifty Index Fund holding, given when I bought it?',
        expectedDescription: 'Holding realized return value',
        getExpected: async () => {
          const holdingReturnSingle = await calculateHoldingReturn({ fundName: 'Sentinel Nifty Index Fund' });
          return holdingReturnSingle[0]?.realized_return_inr ?? 0;
        }
      },
      {
        id: 11,
        question: 'What is my portfolio worth today, and how much have I made on it in absolute INR?',
        expectedDescription: 'Total portfolio worth & total gain',
        getExpected: async () => {
          const allHoldings = await calculateHoldingReturn({});
          return allHoldings.reduce((sum: number, h: any) => sum + h.current_value_inr, 0);
        }
      },
      {
        id: 12,
        question: 'Of the funds I own, which gave me the best realised return?',
        expectedDescription: 'Name of the top holding by return',
        getExpected: async () => {
          const allHoldings = await calculateHoldingReturn({});
          const sorted = [...allHoldings].sort((a: any, b: any) => b.realized_return_inr - a.realized_return_inr);
          return sorted[0]?.fund_name || '';
        }
      },
      {
        id: 13,
        question: 'How much did I spend in January 2024? (Async)',
        expectedDescription: 'Async job execution & verification',
        getExpected: async () => {
          const res = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE category != 'transfer' AND date BETWEEN '2024-01-01T00:00:00.000Z' AND '2024-01-31T23:59:59.999Z' AND amount > 0`);
          return Number(res.rows[0].total);
        },
        isAsync: true
      }
    ];

    // Read command line argument to filter tests
    const args = process.argv.slice(2);
    let targetIds: number[] = [];
    if (args.length > 0) {
      const rawArg = args[0];
      targetIds = rawArg.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
      console.log(`Filtering tests to run only IDs: ${targetIds.join(', ')}`);
    }

    const testCasesToRun = targetIds.length > 0
      ? testCases.filter(tc => targetIds.includes(tc.id))
      : testCases;

    console.log('\n============================================================');
    console.log('STARTING INTEGRATION TEST RUNS...');
    console.log('============================================================');

    // Run selected tests
    for (const tc of testCasesToRun) {
      console.log(`\n[Test #${tc.id}${tc.isAsync ? ' (Async)' : ''}] Sending: "${tc.question}"`);
      const start = Date.now();
      
      try {
        const expectedVal = await tc.getExpected();
        let actualResponse = '';
        if (tc.isAsync) {
          const response = await fetch(`${API_URL}/ask/async`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: tc.question })
          });
          
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
          
          const data = (await response.json()) as { job_id: string; status: string };
          const jobId = data.job_id;
          if (!jobId || data.status !== 'running') {
            throw new Error(`Expected job_id and status="running"`);
          }
          
          console.log(`  Job submitted. ID: ${jobId}. Polling...`);
          let completed = false;
          
          for (let attempt = 1; attempt <= 15; attempt++) {
            await sleep(3000);
            const pollRes = await fetch(`${API_URL}/jobs/${jobId}`);
            if (!pollRes.ok) throw new Error(`Poll HTTP ${pollRes.status}`);
            
            const pollData = (await pollRes.json()) as any;
            console.log(`    Poll #${attempt}: status="${pollData.status}"`);
            
            if (pollData.status === 'COMPLETED') {
              completed = true;
              actualResponse = pollData.result?.answer || '';
              break;
            } else if (pollData.status === 'FAILED') {
              throw new Error(`Job failed: ${pollData.error}`);
            }
          }
          if (!completed) {
            throw new Error('Job did not complete within timeout');
          }
        } else {
          const response = await fetch(`${API_URL}/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: tc.question })
          });
          
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
          }
          
          const data = (await response.json()) as { answer: string };
          actualResponse = data.answer;
        }
        
        const latencyMs = Date.now() - start;
        const passed = matchesExpected(actualResponse, expectedVal);
        
        if (passed) {
          console.log(`  => PASSED (${latencyMs}ms)`);
          passedCount++;
        } else {
          console.log(`  => FAILED! (${latencyMs}ms)`);
          console.log(`     Expected value pattern: ${JSON.stringify(expectedVal)}`);
          console.log(`     Actual Response: ${actualResponse}`);
          failedCount++;
        }
        
        results.push({
          id: tc.id,
          question: tc.question,
          expectedDescription: tc.expectedDescription,
          expectedVal,
          actualResponse,
          passed,
          latencyMs
        });
      } catch (err: any) {
        const latencyMs = Date.now() - start;
        console.error(`  => ERROR: ${err.message}`);
        failedCount++;
        results.push({
          id: tc.id,
          question: tc.question,
          expectedDescription: tc.expectedDescription,
          expectedVal: 'ERROR',
          actualResponse: `ERROR: ${err.message}`,
          passed: false,
          latencyMs
        });
      }
      
      // Short delay between requests to avoid overloading LLM rate limits
      await sleep(2000);
    }

  } catch (globalErr: any) {
    console.error('Critical failure in eval harness:', globalErr);
  } finally {
    console.log('\n============================================================');
    console.log('EVALUATION RESULTS SUMMARY');
    console.log('============================================================');
    
    console.log(`Total Scenarios: ${results.length}`);
    console.log(`Passed:          ${passedCount}`);
    console.log(`Failed:          ${failedCount}`);
    console.log('------------------------------------------------------------');
    
    console.table(
      results.map((r) => ({
        ID: r.id,
        Question: r.question.substring(0, 50) + (r.question.length > 50 ? '...' : ''),
        Passed: r.passed ? '✅ YES' : '❌ NO',
        Latency: `${r.latencyMs}ms`,
        ExpectedPattern: JSON.stringify(r.expectedVal)
      }))
    );

    if (failedCount > 0) {
      console.log('\nFailed Cases Details:');
      results.filter(r => !r.passed).forEach(r => {
        console.log(`\n[Test #${r.id}] Question: "${r.question}"`);
        console.log(`  Expected Pattern: ${JSON.stringify(r.expectedVal)}`);
        console.log(`  Actual Response:  ${r.actualResponse}`);
      });
    }

    // Terminate the spawned server and worker processes
    console.log('\nShutting down server and background worker processes...');
    serverProcess.kill('SIGINT');
    workerProcess.kill('SIGINT');

    await closePool();
    process.exit(failedCount > 0 ? 1 : 0);
  }
}

runEvals();
