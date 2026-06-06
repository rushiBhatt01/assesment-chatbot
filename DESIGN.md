# DESIGN.md — Tara Finance Research Agent Architecture & Design

---

## 1. System Architecture

Project Tara is designed to be a high-precision personal finance research assistant. To achieve 100% mathematical grounding and prevent LLM hallucinations, the system decouples natural language interpretation from financial calculations. 

The cognitive agent is responsible for extracting intent, date boundaries, and filtering parameters, while deterministic calculations are executed entirely inside PostgreSQL or standard TypeScript code.

### Decoupled System Flow

```text
                       +----------------------+
                       |     User Client      |
                       +----------+-----------+
                                  |
               (HTTP Requests)    |
         +------------------------+------------------------+
         | (Sync Endpoint)        | (Async Endpoint)       | (Poll Endpoint)
         v                        v                        v
+------------------+     +------------------+     +------------------+
|    POST /ask     |     |  POST /ask/async |     | GET /jobs/:jobId |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        ^
         |                        |                        |
         | (1. Synchronous        | (1. Async Context      | (3. Poll status
         |  Turn Generation)      |  Job Generation)       |  & results)
         v                        v                        |
+-------------------------------------------------+        |
|            Mastra Orchestrator Agent            |        |
|          - taraAgent (gemini-2.5-flash)         |        |
|          - maxSteps: 10 Loop Guardrail          |        |
+------------------------+------------------------+        |
                         |                                 |
                         | (2. Triggers Tool)              |
                         v                                 |
+-------------------------------------------------+        |
|              Mastra Tool Registry               |        |
|  - query-transactions                           |        |
|  - detect-subscriptions                         |        |
|  - compute-investment-analytics                 |        |
|  - retrieve-async-job-result                    |        |
+------------+------------------------+-----------+        |
             |                        |                    |
             | (3a. Sync execution)   | (3b. Async Job     |
             |                        |  Registration)     |
             v                        v                    |
+------------+-----+     +------------+-----+              |
| DB: transactions |     | DB: async_jobs   | <------------+
| DB: funds        |     | (Status: PENDING)|
| DB: holdings     |     +------------+-----+
+------------------+                  |
                                      |
                                      | (4. Polls PENDING jobs
                                      |  & processes calculations)
                                      v
                        +-------------+------------+
                        |  Background Job Worker   |
                        |      (jobWorker.ts)      |
                        +-------------+------------+
                                      |
                                      | (5. Runs synthetic turn
                                      |  & updates final_answer)
                                      v
                        +-------------+------------+
                        | DB: async_jobs           |
                        | (Status: COMPLETED)      |
                        +--------------------------+
```

---

## 2. Postgres Schema

The Postgres database (hosted via Neon Serverless Postgres) acts as the single source of truth for transactions, mutual funds, holdings, and async job tracking.

### Tables

#### `transactions`
Contains the ledger of all transactions. Negative amounts represent refunds or reversals.
| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(255) PRIMARY KEY` | Original unique transaction ID from JSON. |
| `date` | `TIMESTAMP WITH TIME ZONE NOT NULL` | Transaction date and time. |
| `merchant` | `VARCHAR(255) NOT NULL` | Raw merchant name. |
| `category` | `VARCHAR(100) NOT NULL` | Category (e.g. food, travel, transfer, uncategorized). |
| `amount` | `NUMERIC(15,2) NOT NULL` | Negative = refund/reversal, Positive = expense. |
| `currency` | `VARCHAR(10) NOT NULL` | Currency of transaction (e.g., INR). |
| `memo` | `TEXT NULL` | Raw transaction memo (untrusted string vector). |

#### `funds`
Contains mutual fund details and their complete NAV history.
| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(255) PRIMARY KEY` | Fund unique ID. |
| `name` | `VARCHAR(255) NOT NULL` | Full display name of the mutual fund. |
| `category` | `VARCHAR(100) NOT NULL` | Fund class (e.g., equity, debt, gold). |
| `nav_history` | `JSONB NOT NULL` | Array containing monthly historical NAV values: `[{"date": "YYYY-MM-DD", "nav": 100.50}]` |

#### `holdings`
Stores positions held by the user in various mutual funds.
| Column | Type | Notes |
|---|---|---|
| `fund_id` | `VARCHAR(255) NOT NULL` | Foreign key referencing `funds(id)` with ON DELETE CASCADE. |
| `fund_name` | `VARCHAR(255) NOT NULL` | Name of the fund. |
| `units` | `NUMERIC(18,4) NOT NULL` | Number of mutual fund units owned by the user. |
| `purchase_date` | `TIMESTAMP WITH TIME ZONE NOT NULL` | Date the position was purchased. |
| `purchase_nav` | `NUMERIC(12,4) NOT NULL` | Price (NAV) at which units were purchased. |

#### `async_execution_jobs`
Tracks asynchronous agent tasks and their status.
| Column | Type | Notes |
|---|---|---|
| `job_id` | `UUID PRIMARY KEY DEFAULT uuid_generate_v4()` | Auto-generated UUID identifying the async task. |
| `status` | `async_job_status NOT NULL` | Current job status Enum (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`). |
| `payload_input` | `JSONB NOT NULL` | Original query parameters passed to the tool. |
| `payload_output` | `JSONB NULL` | Computed database metrics output. |
| `final_answer` | `TEXT NULL` | Text response generated by the agent turn in background. |
| `error_log` | `TEXT NULL` | Description of failures if execution fails. |
| `created_at` | `TIMESTAMP WITH TIME ZONE` | Creation timestamp. |
| `updated_at` | `TIMESTAMP WITH TIME ZONE` | Last updated timestamp. |

### Enums & Extensions
- **`async_job_status`**: Custom enum type containing `'PENDING'`, `'RUNNING'`, `'COMPLETED'`, and `'FAILED'`.
- **`pg_trgm`**: Trigram similarity extension used for fuzzy matching merchant and fund names.
- **`uuid-ossp`**: Used to generate standard UUID v4 handles for jobs.

### Indexes
```sql
CREATE INDEX idx_transactions_merchant_trgm ON transactions USING GIST (merchant gist_trgm_ops);
CREATE INDEX idx_transactions_perf_composite ON transactions (category, date, merchant) INCLUDE (amount);
CREATE INDEX idx_funds_nav_history_gin ON funds USING GIN (nav_history);
CREATE INDEX idx_async_jobs_status_created ON async_execution_jobs (status, created_at);
```

### Schema Design Decisions ("Why")
* **JSONB for `nav_history`:** Storing monthly historical NAV points as a JSONB array inside the `funds` table avoids massive 1-to-many historical table joins and simplifies monthly NAV retrievals into self-contained query rows.
* **ON DELETE CASCADE:** Set on `holdings` -> `funds` to guarantee that deleting a mutual fund automatically cleans up user holdings and prevents orphan data.
* **GIST Index with `gist_trgm_ops`:** Created on `transactions(merchant)` to support fast, trigram-based fuzzy string matching (`pg_trgm`) at index speed, handling NEFT/UPI variants.
* **Covering Composite Index:** The composite index on `transactions (category, date, merchant) INCLUDE (amount)` allows the database engine to run Index Only Scans for spend queries, retrieving the amount directly from the index nodes without reading raw table blocks.

---

## 3. Tool Design

To maintain precision and prevent tool choice conflicts, the system defines four core tools matching specific capabilities.

### philosophy
Prefer fewer, expressive, parameterized tools rather than many narrow tools. This conserves the agent's context window, improves route accuracy, and prevents infinite routing loops.

### Tools

#### 1. `query-transactions`
- **Purpose**: Unified transaction aggregation, filter, and lookup.
- **Input Schema**:
  ```typescript
  {
    merchantPattern?: string;   // Fuzzy merchant pattern
    categoryFilter?: string;    // Target category (e.g. food, health)
    startDate: string;          // ISO Start Date
    endDate: string;            // ISO End Date
    metricsOperation: 'RAW_LIST' | 'SUM' | 'MONTH_OVER_MONTH_TREND' | 'TOP_MERCHANTS_RANKING';
    includeRefunds?: boolean;   // Net positive expenses against negative refunds if true
  }
  ```
- **Output**: Array of transactions, sum values, monthly breakdowns, or merchant ranks.

#### 2. `detect-subscriptions`
- **Purpose**: Identifies recurring monthly payments based on transaction cadence and variance.
- **Input Schema**:
  ```typescript
  {
    minOccurrences?: number;       // Default: 2
    amountTolerancePct?: number;   // Default: 10%
    intervalMinDays?: number;      // Default: 25
    intervalMaxDays?: number;      // Default: 35
  }
  ```
- **Output**: List of identified subscription merchants, occurrence counts, typical monthly amounts, and monthly ratios.

#### 3. `compute-investment-analytics`
- **Purpose**: Calculates mutual fund returns, portfolio value, and absolute gains.
- **Input Schema**:
  ```typescript
  {
    operation: 'PERIOD_RETURN' | 'FUND_RANKING' | 'HOLDING_RETURN';
    fundName?: string;  // Fuzzy fund name (optional)
    startDate?: string; // Required for PERIOD_RETURN and FUND_RANKING
    endDate?: string;   // Required for PERIOD_RETURN and FUND_RANKING
  }
  ```
- **Output**: Nav start/end values, returns (%), purchase cost, current valuations, and gains.

#### 4. `retrieve-async-job-result`
- **Purpose**: Fetches the output payload of an asynchronous job by its UUID.
- **Input Schema**:
  ```typescript
  {
    jobId: string; // Job UUID
  }
  ```
- **Output**: Job status, input payload, output data, and error log.

---

## 4. Grounding & Mathematical Formulas

The model is programmatically prevented from calculating totals or returns to ensure grounding. All metrics are computed in PostgreSQL or TS utilities before returning.

### Formulas

#### 1. Net Spend
```
net_spend = SUM(amount) WHERE amount > 0  (if includeRefunds is false)
net_spend = SUM(amount) across all rows    (if includeRefunds is true)
```
*Note: Transfers (`category = 'transfer'`) are permanently excluded from spend calculations.*

#### 2. Merchant Alias Matching (Trigram Similarity)
Instead of hardcoding merchant aliases, the database performs fuzzy matching:
```sql
SELECT DISTINCT merchant, similarity(merchant, :query)
FROM transactions
WHERE similarity(merchant, :query) > 0.35
```

#### 3. Recurring Subscription Detection
Clustering monthly transactions using windowing functions:
- Let $T$ be the list of transactions for a merchant sorted by date.
- Let $prev\_date$ be the date of the previous transaction.
- Interval $Days = date - prev\_date$.
- A merchant is flagged as recurring if:
  - $\text{Occurrence Count} \ge minOccurrences$
  - $\text{Interval } Days \text{ between 25 and 35 days for } \ge 60\% \text{ of occurrences (monthly\_ratio)} $
  - $\text{Amount Variance } ((\max(amount) / \min(amount)) - 1) < amountTolerancePct / 100$.

#### 4. Fund Period Return
```
period_return_pct = ((nav_end - nav_start) / nav_start) * 100
```
- `nav_start`: NAV on or immediately after `startDate`.
- `nav_end`: NAV on or immediately before `endDate`.

#### 5. Holding Realized Return
```
purchase_cost_inr   = units * purchase_nav
current_value_inr   = units * current_nav  (Latest NAV from fund history)
realized_return_inr = current_value_inr - purchase_cost_inr
realized_return_pct = (realized_return_inr / purchase_cost_inr) * 100
```

---

## 5. Relative Date Assumption

To ensure that answers are stable and reproducible over static datasets, date variables (like "last month" or "this month") are determined relative to the **latest transaction date in the database**, rather than the system's wall-clock time.

---

## 6. Observability & Telemetry

Each request generates a single-line JSON log conforming to the `ObservabilityAuditRecord` outline:

```json
{
  "traceId": "uuid-v4",
  "ingressTimestamp": "ISO-8601",
  "clientRequestQuestionString": "User's prompt text",
  "mappedIntentClassification": "AGGREGATE_EXPENSE | MUTUAL_FUND_PERFORMANCE | PORTFOLIO_REALIZED_YIELD | EMPTY_DATA_EXCEPTION",
  "toolCallExecutionPipeline": [
    {
      "executionSequenceNode": 1,
      "invokedToolName": "query-transactions",
      "sanitizedArgumentsPayload": { "startDate": "...", "endDate": "...", "metricsOperation": "SUM" },
      "latencyMs": 100
    }
  ],
  "storageTablesAccessed": ["transactions"],
  "runtimeProcessingLatencyMs": 1420,
  "terminalExecutionStatus": "SUCCESS | DATA_ABANDON_EMPTY | CRITICAL_EXCEPTION_STATE",
  "systemExceptionPayload": {
    "internalCodeString": "AGENT_ERROR",
    "sanitizedErrorMessage": "Description..."
  }
}
```

### Sensitive Data Redaction
To prevent leaking sensitive information:
- The `SensitiveDataFilter` observability processor redacts system environment variables, passwords, database connections, and API tokens.
- Custom function `sanitizePayload` redacts parameters matching sensitive keys: `password`, `token`, `key`, `secret`, `auth`, `database_url`.
- Transaction `memo` parameters are replaced with `[REDACTED_MEMO]` to prevent exposure of UPI transaction IDs, account numbers, or tracking hashes.

### Infinite Loop Protection
The agent turns are configured with a `maxSteps: 10` guardrail. If an execution pipeline loops or attempts to call tools more than 10 times on a single turn, the system terminates execution and returns a clean failure message.

### How to Inspect a Failed Run
1. Retrieve the `traceId` from the response's metadata payload or from the `ObservabilityAuditRecord` logged under standard execution.
2. Locate the matching record in the server log (or Mastra storage database `/file:./mastra.db`).
3. Check the `terminalExecutionStatus`, which will indicate `CRITICAL_EXCEPTION_STATE` or `DATA_ABANDON_EMPTY` instead of `SUCCESS`.
4. Inspect the `systemExceptionPayload` field containing the raw error stack trace and error message, and examine the `toolCallExecutionPipeline` steps to pinpoint exactly which database tool or argument triggered the issue.

---

## 7. Asynchronous Architecture & Worker

For queries that take longer or run in an async context, the Express app utilizes an asynchronous poller pattern.

### Process Flow
1. **POST `/ask/async`**: Generates a unique `job_id` and starts the agent run in the background (within an `AsyncLocalStorage` context containing the pre-generated `job_id`), returning the `job_id` immediately to the client.
2. The tools check if they are running in an async context. If yes, they create a job in the `async_execution_jobs` table in `PENDING` status containing the arguments, and suspend execution immediately by throwing a custom `ASYNC_JOB_STARTED:${jobId}` error (which the agent catches and yields to immediately).
3. **Background Job Worker**: Running as a standalone process (`jobWorker.ts`), it polls for `PENDING` jobs.
4. When it picks up a job:
   - Sets status to `RUNNING`.
   - Executes the database query synchronously using parameters in `payload_input`.
   - Saves results into `payload_output`.
   - Submits a synthetic turn (`<async_tool_completion>`) to the agent so that it can explain the results.
   - Saves the final text response into `final_answer` and sets status to `COMPLETED`.
5. **GET `/jobs/:job_id`**: The client polls this endpoint to receive the current job status and the final text answer once completed.

---

## 8. Structured Response API Shapes

For enhanced developer diagnostics and client observability, the HTTP endpoints return a structured JSON response enclosing operational metadata alongside the standard response payload.

### POST `/ask` (Success Response)
```json
{
  "answer": "Your net spending on food was 4075.17 in March 2025.",
  "status": "SUCCESS",
  "meta": {
    "traceId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "latencyMs": 1450,
    "intent": "AGGREGATE_EXPENSE",
    "tablesAccessed": ["transactions"],
    "executionPipeline": [
      {
        "executionSequenceNode": 1,
        "invokedToolName": "query-transactions",
        "sanitizedArgumentsPayload": { "startDate": "2025-03-01", "endDate": "2025-03-31", "metricsOperation": "SUM" },
        "latencyMs": 100
      }
    ]
  }
}
```

### POST `/ask/async` (Success Response)
```json
{
  "job_id": "45d7667c-55d4-4290-973d-9df506a00728",
  "status": "running",
  "meta": {
    "ingressTimestamp": "2026-06-05T16:11:34.997Z"
  }
}
```

---

## 9. Production Deployment & Tradeoffs

### Live Environment
* **Platform:** Railway (built using Nixpacks)
* **Base URL:** `https://assesment-chatbot-production.up.railway.app`
* **Database:** Hosted PostgreSQL.

### Architecture Considerations
1. **Parallel Worker Orchestration:** To utilize a single Railway container, both the Express API and the out-of-band Background Job Worker are booted concurrently in the background (using `tsx src/server.ts & tsx src/workers/jobWorker.ts` as the startup script). For higher scale, these would ideally be split into separate API and worker services.

---

## 10. Grounding & Hallucination Prevention

To guarantee 100% mathematical grounding and prevent LLM hallucinations:
1. **Math Decoupling:** The LLM is programmatically barred from executing calculations. Sums, MoM growth trends, and percentage returns are executed purely via SQL queries in [pgRepo.ts](file:///c:/Users/Rushi/OneDrive/Desktop/FILES/DEVPROJECT/New%20folder/tara/src/database/pgRepo.ts) or TypeScript math helpers.
2. **Instruction Enforcement:** The system instructions in [tara-agent.ts](file:///c:/Users/Rushi/OneDrive/Desktop/FILES/DEVPROJECT/New%20folder/tara/src/mastra/agents/tara-agent.ts) mandate quoting figures verbatim from the tool results, responding with a standard "No data was found..." if empty, and ignoring free-text memos.
3. **Structured Portfolio Aggregates:** The investment analytics tool returns a pre-aggregated `TOTAL_PORTFOLIO` summary row, eliminating the need for the LLM to sum individual holding rows.

---

## 11. Evaluation Framework

* **Test Harness:** The integration tests in [eval.ts](file:///c:/Users/Rushi/OneDrive/Desktop/FILES/DEVPROJECT/New%20folder/tara/src/scripts/eval.ts) boot up child processes for both the Express API and the job worker, submit async/sync requests to the localhost API, poll for status completion, verify actual prose answers against programmatically fetched expected database totals, and terminate cleanly.
* **Test Case Coverage:** Includes 13 test scenarios covering:
  - Single lookups & date scopes (TC #1, #3, #6)
  - Refund netting & transfers exclusion (TC #1, #3)
  - Merchant alias matching (TC #2)
  - Category growth/MoM comparison (TC #4)
  - No-data conditions (TC #5)
  - Recurring subscription detection (TC #7)
  - Fund period return calculations (TC #8, #9)
  - Holding realized yields & aggregate portfolio worth (TC #10, #11, #12)

---

## 12. Asynchronous Agent State Handling

* **In-Progress State:** When a slow tool executes, it registers a UUID `job_id` under `async_execution_jobs` table in `PENDING` status, throws `ASYNC_JOB_STARTED`, and immediately yields control back to the Express controller, returning `status: "running"` to the client.
* **Completed State:** The job worker fetches the pending job, executes the query, triggers a synthetic agent turn feeding the query results into the agent model to write the natural language response, saves the formatted text under `final_answer` column, and marks status as `COMPLETED`. The client polling the status endpoint receives the completed response.

---

## 13. Potential Failure Modes & Future Improvements

### Potential Failure Modes
1. **Concurrency and Connection Caps:** Operating the database and API concurrently on a single container under peak concurrent requests might exhaust node memory or connection pools.
2. **Highly Composite Prompts:** Sentence prompts asking for multiple independent nested comparisons (e.g. "compare Swiggy to Zepto and fund X to Y") can sometimes lead to incomplete tool extraction sequences.

