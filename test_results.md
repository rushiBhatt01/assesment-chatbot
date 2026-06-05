# Evaluation Test Case Report

**Date:** 2026-06-05  
**Data Snapshot:** sample_b  
**Agent Model:** Gemini 2.5 Flash  
**Total Scenarios:** 13 | **Passed:** 13 | **Failed:** 0  

---

## Test Case Summary Table

| TC# | Category | Question | Expected Result | Actual Result / Behavior | Latency | Status |
|-----|----------|----------|-----------------|--------------------------|---------|--------|
| 1 | Single Lookup + Refunds | How much did I spend on food in March 2025 after refunds? | ₹4,075.17 | ₹4,075.17 | ~4500ms | ✅ PASS |
| 2 | Merchant Aliases (Fuzzy) | How much did I spend on Swiggy, including Swiggy Instamart and SWIGGY orders? | ₹49,311.02 | ₹49,311.02 | ~3200ms | ✅ PASS |
| 3 | Date Scope + Exclusions | Ignore transfers. What was my total actual spending in Q1 2025? | ₹716,919.47 | ₹716,919.47 | ~3500ms | ✅ PASS |
| 4 | Category MoM Comparison | Which category had the biggest increase from February 2025 to March 2025? | "entertainment" | "entertainment" (using CATEGORY_BREAKDOWN comparison) | ~9400ms | ✅ PASS |
| 5 | No-Data Edge Case | Do I have any data for rent in April 2025? | 0 transactions / "no data" | Stated that no transactions/data were found for rent in April 2025 | ~3500ms | ✅ PASS |
| 6 | Top Merchants Ranks | What were my top 5 merchants by net spend between January 2025 and March 2025? | Top 5 merchants list | Returned top merchants list correctly matched | ~5200ms | ✅ PASS |
| 7 | Subscription Detection | Which transactions look like recurring subscriptions? | Subscription merchants list | Detected recurring subscription cadence correctly | ~3000ms | ✅ PASS |
| 8 | Fund Period Return | What was Saffron Bluechip Equity Fund's return from 2024-01-01 to 2025-01-01? | 31.17% | 31.17% | ~3688ms | ✅ PASS |
| 9 | Period Return Ranking | Rank all funds by one-year return between 2024-03-01 and 2025-03-01, and show the spread between best and worst. | Ranking details & 15.65% spread | Ranked funds and returned the correct 15.65% spread | ~4559ms | ✅ PASS |
| 10 | Holding Realized Return | What is my realised return on my Sentinel Nifty Index Fund holding, given when I bought it? | ₹6,113.62 | ₹6,113.62 | ~4413ms | ✅ PASS |
| 11 | Portfolio Aggregate | What is my portfolio worth today, and how much have I made on it in absolute INR? | Worth: ₹119,983.81 | Worth: ₹119,983.81, Gains: ₹22,627.09 (using TOTAL_PORTFOLIO summary row) | ~5462ms | ✅ PASS |
| 12 | Best Holding Fund | Of the funds I own, which gave me the best realised return? | "Sentinel Nifty Index Fund" | "Sentinel Nifty Index Fund" (realized return: ₹6,113.62) | ~4342ms | ✅ PASS |
| 13 | Async Ingress | How much did I spend in January 2024? (Async poller) | ₹1,032,693.30 | ₹1,032,693.30 (submitted job, suspended, background agent turn successfully computed and fetched) | ~9705ms | ✅ PASS |

---

## Key Achievements & Implementation Details

1. **100% Pass Rate (13/13)**: All integration test cases successfully pass with exact grounding values from the Neon Serverless Postgres database.
2. **Robust LLM Error Retries**: Implemented a 3-attempt retry loop for agent generation on `/ask` and background worker agent turns to handle transient Google Gemini API rate limits/503 "high demand" errors gracefully.
3. **Pristine Async Poller Execution**: Correctly parsed natural language parameters (dates/merchant patterns) in the background via the agent before committing a `PENDING` job, instead of hardcoding arguments at ingress. Bypassed `AsyncLocalStorage` loss by generating `jobId` at ingress and passing it inside the storage context, and halting the initial agent execution immediately using `ASYNC_JOB_STARTED` suspension.
4. **Calculations Grounding (Zero Hallucination)**: Prevented LLM math hallucinations on portfolio aggregates by adding a `TOTAL_PORTFOLIO` summary row returned directly from the database tool (`computeInvestmentAnalyticsTool` with `includeSummary: true`), allowing the agent to read and quote totals directly.
5. **No duckdb Concurrent Write Locks**: Switched from DuckDB to LibSQL (SQLite) storage for Mastra observability config, resolving file access lock collisions and server startup crashes.
