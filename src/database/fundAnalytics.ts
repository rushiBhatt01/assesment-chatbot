import { query } from './db';

/**
 * Calculate the period return for a fund between two dates.
 * Uses JSONB path extraction to find closest start/end NAVs.
 * Supports ranking all funds by return over the same period.
 */
export async function calculatePeriodReturn(input: {
  fundName?: string;
  startDate: string;
  endDate: string;
  rankAll?: boolean;
}) {
  const { fundName, startDate, endDate, rankAll = false } = input;

  if (rankAll) {
    // Rank all funds by their period return
    const result = await query(
      `
      SELECT 
        f.id, f.name, f.category,
        (SELECT (record->>'nav')::NUMERIC 
         FROM jsonb_array_elements(f.nav_history) record 
         WHERE (record->>'date')::DATE >= $1::DATE 
         ORDER BY (record->>'date')::DATE ASC LIMIT 1) AS nav_start,
        (SELECT (record->>'nav')::NUMERIC 
         FROM jsonb_array_elements(f.nav_history) record 
         WHERE (record->>'date')::DATE <= $2::DATE 
         ORDER BY (record->>'date')::DATE DESC LIMIT 1) AS nav_end
      FROM funds f
      `,
      [startDate, endDate]
    );

    return result.rows
      .filter((r: any) => r.nav_start && r.nav_end && Number(r.nav_start) > 0)
      .map((r: any) => ({
        fund_id: r.id,
        fund_name: r.name,
        category: r.category,
        nav_start: Number(r.nav_start),
        nav_end: Number(r.nav_end),
        period_return_pct: Number(((r.nav_end - r.nav_start) / r.nav_start * 100).toFixed(2)),
      }))
      .sort((a: any, b: any) => b.period_return_pct - a.period_return_pct);
  }

  // Single fund period return with trigram fuzzy matching
  const result = await query(
    `
    SELECT 
      f.id, f.name, f.category,
      similarity(f.name, $3) AS match_score,
      (SELECT (record->>'nav')::NUMERIC 
       FROM jsonb_array_elements(f.nav_history) record 
       WHERE (record->>'date')::DATE >= $1::DATE 
       ORDER BY (record->>'date')::DATE ASC LIMIT 1) AS nav_start,
      (SELECT (record->>'nav')::NUMERIC 
       FROM jsonb_array_elements(f.nav_history) record 
       WHERE (record->>'date')::DATE <= $2::DATE 
       ORDER BY (record->>'date')::DATE DESC LIMIT 1) AS nav_end
    FROM funds f
    WHERE similarity(f.name, $3) > 0.15
    ORDER BY similarity(f.name, $3) DESC
    LIMIT 1
    `,
    [startDate, endDate, fundName]
  );

  if (result.rows.length === 0) return [];

  const r = result.rows[0];
  if (!r.nav_start || !r.nav_end || Number(r.nav_start) === 0) return [];

  return [{
    fund_id: r.id,
    fund_name: r.name,
    category: r.category,
    nav_start: Number(r.nav_start),
    nav_end: Number(r.nav_end),
    period_return_pct: Number(((r.nav_end - r.nav_start) / r.nav_start * 100).toFixed(2)),
  }];
}

/**
 * Calculate realized return on user's holdings.
 * Joins holdings with funds to get latest NAV and compute P&L.
 */
export async function calculateHoldingReturn(input: {
  fundName?: string;
  includeSummary?: boolean;
}) {
  const { fundName, includeSummary } = input;

  let queryText = `
    WITH LatestNav AS (
      SELECT 
        id,
        (SELECT (record->>'nav')::NUMERIC 
         FROM jsonb_array_elements(nav_history) record 
         ORDER BY (record->>'date')::DATE DESC LIMIT 1) AS current_nav
      FROM funds
    )
    SELECT 
      h.fund_id,
      h.fund_name,
      h.units::NUMERIC,
      h.purchase_nav::NUMERIC,
      h.purchase_date,
      ln.current_nav,
      ROUND((h.units * ln.current_nav)::NUMERIC, 2) AS current_value_inr,
      ROUND((h.units * h.purchase_nav)::NUMERIC, 2) AS purchase_cost_inr,
      ROUND(((h.units * ln.current_nav) - (h.units * h.purchase_nav))::NUMERIC, 2) AS realized_return_inr
    FROM holdings h
    JOIN LatestNav ln ON h.fund_id = ln.id
  `;

  const params: any[] = [];

  if (fundName) {
    queryText += ` WHERE similarity(h.fund_name, $1) > 0.15 ORDER BY similarity(h.fund_name, $1) DESC`;
    params.push(fundName);
  } else {
    queryText += ` ORDER BY (h.units * ln.current_nav) DESC`;
  }

  const result = await query(queryText, params);

  const rows = result.rows.map((r: any) => ({
    fund_id: r.fund_id,
    fund_name: r.fund_name,
    units: Number(r.units),
    purchase_nav: Number(r.purchase_nav),
    current_nav: Number(r.current_nav),
    current_value_inr: Number(r.current_value_inr),
    purchase_cost_inr: Number(r.purchase_cost_inr),
    realized_return_inr: Number(r.realized_return_inr),
  }));

  if (includeSummary && !fundName && rows.length > 0) {
    const totalCurrentValue = rows.reduce((sum: number, r: any) => sum + r.current_value_inr, 0);
    const totalPurchaseCost = rows.reduce((sum: number, r: any) => sum + r.purchase_cost_inr, 0);
    const totalRealizedReturn = rows.reduce((sum: number, r: any) => sum + r.realized_return_inr, 0);
    rows.push({
      fund_id: 'TOTAL',
      fund_name: 'TOTAL_PORTFOLIO',
      units: 0,
      purchase_nav: 0,
      current_nav: 0,
      current_value_inr: Number(totalCurrentValue.toFixed(2)),
      purchase_cost_inr: Number(totalPurchaseCost.toFixed(2)),
      realized_return_inr: Number(totalRealizedReturn.toFixed(2)),
    });
  }

  return rows;
}
