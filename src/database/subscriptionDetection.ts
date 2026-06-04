import { query } from './db';

export interface SubscriptionDetectionInput {
  minOccurrences?: number;
  amountTolerancePct?: number;
  intervalMinDays?: number;
  intervalMaxDays?: number;
}

export interface DetectedSubscription {
  merchant: string;
  occurrence_count: number;
  typical_amount: number;
  annual_estimate: number;
  monthly_confidence_pct: number;
  first_date: string;
  last_date: string;
}

/**
 * Detects recurring subscription-like transactions using SQL window functions.
 * 
 * Algorithm:
 * 1. Filter to expenses only (positive amounts, exclude transfers)
 * 2. Use LAG() to compute intervals between consecutive transactions per merchant
 * 3. Group by merchant and compute: occurrence count, avg amount, amount variance, monthly ratio
 * 4. Filter to merchants meeting all criteria: min occurrences, amount tolerance, monthly interval ratio
 */
export async function detectSubscriptions(
  input: SubscriptionDetectionInput = {}
): Promise<DetectedSubscription[]> {
  const {
    minOccurrences = 2,
    amountTolerancePct = 10,
    intervalMinDays = 25,
    intervalMaxDays = 35,
  } = input;

  const amountVarianceThreshold = amountTolerancePct / 100;

  const result = await query(
    `
    WITH MerchantTransactions AS (
      SELECT 
        merchant,
        date,
        amount,
        LAG(date) OVER (PARTITION BY merchant ORDER BY date) AS prev_date
      FROM transactions
      WHERE category != 'transfer' AND amount > 0
    ),
    WithIntervals AS (
      SELECT
        merchant,
        date,
        amount,
        prev_date,
        EXTRACT(DAY FROM date - prev_date) AS days_since_last
      FROM MerchantTransactions
    ),
    IntervalStats AS (
      SELECT 
        merchant,
        COUNT(*) AS occurrence_count,
        ROUND(AVG(amount)::NUMERIC, 2) AS avg_amount,
        CASE 
          WHEN MIN(amount) > 0 THEN ROUND(((MAX(amount) / MIN(amount)) - 1)::NUMERIC, 4)
          ELSE 999
        END AS amount_variance,
        COUNT(CASE WHEN days_since_last BETWEEN $1 AND $2 THEN 1 END)::FLOAT 
          / NULLIF(COUNT(days_since_last), 0) AS monthly_ratio,
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        ROUND(AVG(amount)::NUMERIC * 12, 2) AS annual_estimate
      FROM WithIntervals
      GROUP BY merchant
      HAVING COUNT(*) >= $3
    )
    SELECT 
      merchant,
      occurrence_count,
      avg_amount AS typical_amount,
      annual_estimate,
      ROUND((monthly_ratio * 100)::NUMERIC, 1) AS monthly_confidence_pct,
      first_date,
      last_date
    FROM IntervalStats
    WHERE amount_variance < $4
      AND monthly_ratio >= 0.6
    ORDER BY annual_estimate DESC;
    `,
    [intervalMinDays, intervalMaxDays, minOccurrences, amountVarianceThreshold]
  );

  return result.rows.map((row: any) => ({
    merchant: row.merchant,
    occurrence_count: Number(row.occurrence_count),
    typical_amount: Number(row.typical_amount),
    annual_estimate: Number(row.annual_estimate),
    monthly_confidence_pct: Number(row.monthly_confidence_pct),
    first_date: row.first_date instanceof Date ? row.first_date.toISOString().slice(0, 10) : String(row.first_date),
    last_date: row.last_date instanceof Date ? row.last_date.toISOString().slice(0, 10) : String(row.last_date),
  }));
}
