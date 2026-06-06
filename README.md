# Project Tara: Personal Finance-Research Agent

Project Tara is an AI-powered financial assistant built with the **Mastra SDK** (TypeScript) and **PostgreSQL**. Decoupling cognitive planning from relational mathematics, Tara extracts parameters from natural language and delegates calculations directly to database queries to ensure 100% mathematical determinism and prevent hallucinations.

---

## 1. Prerequisites

Ensure you have the following installed on your system:
- **Node.js**: Version `>= 22.13.0`
- **PostgreSQL**: Version `14+` (or access to a serverless Neon database)

---

## 2. Setup Guide

### 2.1 Install Dependencies
Run the package installer from the project root:
```bash
npm install
```

### 2.2 Configure Environment Variables
Create or update your `.env` file in the root directory:
```bash
GOOGLE_API_KEY=your_gemini_api_key_here
DATABASE_URL=your_postgresql_connection_string_here
PORT=3000
```

---

## 3. Database Ingestion (Seed Data)

The ingest script populates the Postgres database with transaction ledgers, investment indexes, and portfolio holdings.

To ingest a data snapshot, execute:
```bash
# On Linux/macOS
DATA_DIR=./data/sample_a npm run ingest

# On Windows (PowerShell)
$env:DATA_DIR="./data/sample_a"; npm run ingest
```
*(You can swap `./data/sample_a` with `./data/sample_b` or any valid snapshot containing `transactions.json`, `funds.json`, and `holdings.json`)*.

---

## 4. Running the Application Locally

For synchronous queries, only the API server is required. For asynchronous execution, both the API server and the background worker must be running.

### 4.1 Start the API Server
Starts the Express API server on port 3000:
```bash
npm run server
```

### 4.2 Start the Asynchronous Background Worker
Starts the background job worker that polls the queue, executes SQL calculations, and resumes agent turns:
```bash
npm run worker
```

---

## 5. Manual Evaluation Guide

### 5.1 Synchronous Ingress (`POST /ask`)
Direct query execution returning grounded prose response immediately.

#### Example 1: Groceries Spending
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "How much did I spend on food in March 2025?"}'
```

#### Example 2: Fuzzy Merchant Match
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is my total spend on Swiggy?"}'
```

#### Example 3: Mutual Fund Period Return
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is Apex Gold Savings Fund return from 2024-01-01 to 2025-01-01?"}'
```

---

### 5.2 Asynchronous Ingress (`POST /ask/async` & Polling)
Sends complex or slow queries to run in the background, returning a job tracking handle immediately.

#### Step 1: Submit the Asynchronous Request
```bash
curl -X POST http://localhost:3000/ask/async \
  -H "Content-Type: application/json" \
  -d '{"question": "How much did I spend in January 2024?"}'
```
**Expected Response:**
```json
{
  "job_id": "532fa47b-c8a4-4785-b6c3-ab5feccce0fc",
  "status": "running"
}
```

#### Step 2: Poll for completion
```bash
curl http://localhost:3000/jobs/532fa47b-c8a4-4785-b6c3-ab5feccce0fc
```
**Expected Complete Response:**
```json
{
  "job_id": "532fa47b-c8a4-4785-b6c3-ab5feccce0fc",
  "status": "COMPLETED",
  "created_at": "2026-06-04T08:25:38.000Z",
  "updated_at": "2026-06-04T08:25:40.000Z",
  "result": {
    "answer": "Based on your transactions, you spent exactly ₹253608.96 in January 2024."
  }
}
```

---

## 6. Running the Automated Evaluation Harness

To run the full integration test suite, execute the eval script:
```bash
npm run eval
```
The test harness will:
1. Boot up the Express API server.
2. Boot up the out-of-band Background Job Worker.
3. Submit an asynchronous query to `/ask/async` and verify immediate `job_id` generation.
4. Poll the `/jobs/:job_id` endpoint until `status` is `COMPLETED`.
5. Verify that the returned answer contains the correctly calculated database values.
6. Cleanly terminate all child processes upon completion.

---

## 7. Production Deployment

The application is deployed live on **Railway** connected to a managed PostgreSQL database instance.

* **Base Production URL:** `https://assesment-chatbot-production.up.railway.app`
* **API Endpoint (Sync):**
  ```bash
  curl -X POST https://assesment-chatbot-production.up.railway.app/ask \
    -H "Content-Type: application/json" \
    -d '{"question": "How much did I spend on food in March 2025?"}'
  ```
* **API Endpoint (Async):**
  ```bash
  curl -X POST https://assesment-chatbot-production.up.railway.app/ask/async \
    -H "Content-Type: application/json" \
    -d '{"question": "What is my total portfolio worth?"}'
  ```