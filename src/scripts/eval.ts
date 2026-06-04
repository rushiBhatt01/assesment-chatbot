import { spawn } from 'child_process';
import path from 'path';

const PORT = 3000;
const API_URL = `http://localhost:${PORT}`;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runEvals() {
  console.log('------------------------------------------------------------');
  console.log('STARTING EVALUATION HARNESS (Story 3.2 — Async Worker)');
  console.log('------------------------------------------------------------');

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
  await sleep(10000);

  let passedCount = 0;
  let failedCount = 0;

  // ---- Test #1: Submit async request and verify immediate job_id return ----
  console.log('\n[Test #1] Async submission — immediate job_id return');
  const question = 'How much did I spend in January 2024?';
  console.log(`Question: "${question}"`);

  let jobId: string | null = null;
  try {
    const start = Date.now();
    const response = await fetch(`${API_URL}/ask/async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    const latency = Date.now() - start;

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as { job_id: string; status: string };
    console.log(`Response: job_id="${data.job_id}", status="${data.status}"`);
    console.log(`Latency:  ${latency}ms (should be fast, < 1000ms)`);

    if (!data.job_id || data.status !== 'running') {
      throw new Error(`Expected job_id and status="running", got: ${JSON.stringify(data)}`);
    }

    jobId = data.job_id;
    passedCount++;
  } catch (err: any) {
    console.error(`Error:    ${err.message}`);
    failedCount++;
  }

  // ---- Test #2: Poll job until COMPLETED ----
  console.log('\n[Test #2] Job polling — wait for COMPLETED status');
  if (jobId) {
    console.log(`Polling job_id="${jobId}"...`);
    let attempts = 0;
    const maxAttempts = 15;
    let finalStatus = 'UNKNOWN';

    try {
      while (attempts < maxAttempts) {
        await sleep(3000);
        attempts++;

        const pollResponse = await fetch(`${API_URL}/jobs/${jobId}`);
        if (!pollResponse.ok) {
          throw new Error(`Poll HTTP Error ${pollResponse.status}`);
        }

        const pollData = (await pollResponse.json()) as {
          job_id: string;
          status: string;
          result?: { answer: string };
          error?: string;
        };

        console.log(`  Poll #${attempts}: status="${pollData.status}"`);
        finalStatus = pollData.status;

        if (pollData.status === 'COMPLETED') {
          console.log(`  Result:  ${JSON.stringify(pollData.result)}`);
          if (pollData.result?.answer && pollData.result.answer.trim().length > 0) {
            passedCount++;
          } else {
            console.error('  Error:   Completed job has empty answer payload.');
            failedCount++;
          }
          break;
        } else if (pollData.status === 'FAILED') {
          console.log(`  Error:   ${pollData.error}`);
          failedCount++;
          break;
        }
      }

      if (finalStatus !== 'COMPLETED' && finalStatus !== 'FAILED') {
        console.error(`  Timed out after ${maxAttempts} polls`);
        failedCount++;
      }
    } catch (err: any) {
      console.error(`Error:    ${err.message}`);
      failedCount++;
    }
  } else {
    console.log('  Skipped — no job_id from Test #1');
    failedCount++;
  }

  console.log('\n------------------------------------------------------------');
  console.log('EVALUATION COMPLETE');
  console.log(`Total: 2 | Passed: ${passedCount} | Failed: ${failedCount}`);
  console.log('------------------------------------------------------------');

  // Terminate the processes
  console.log('Shutting down server and background worker...');
  serverProcess.kill('SIGINT');
  workerProcess.kill('SIGINT');
  
  process.exit(failedCount > 0 ? 1 : 0);
}

runEvals();
