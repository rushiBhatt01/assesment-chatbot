import { query, closePool } from '../database/db';

async function testQueries() {
  // Test 1: Period return for Saffron Bluechip (Jan 2024 - Mar 2025)
  const periodReturn = await query(`
    SELECT 
      f.id, f.name,
      (SELECT (record->>'nav')::NUMERIC 
       FROM jsonb_array_elements(f.nav_history) record 
       WHERE (record->>'date')::DATE >= $1::DATE 
       ORDER BY (record->>'date')::DATE ASC LIMIT 1) AS nav_start,
      (SELECT (record->>'nav')::NUMERIC 
       FROM jsonb_array_elements(f.nav_history) record 
       WHERE (record->>'date')::DATE <= $2::DATE 
       ORDER BY (record->>'date')::DATE DESC LIMIT 1) AS nav_end
    FROM funds f
    WHERE similarity(f.name, $3) > 0.2
    ORDER BY similarity(f.name, $3) DESC
    LIMIT 1
  `, ['2024-01-01', '2025-03-01', 'Saffron Bluechip Equity Fund']);
  
  const r = periodReturn.rows[0];
  const pctReturn = ((r.nav_end - r.nav_start) / r.nav_start * 100).toFixed(2);
  console.log('=== Period Return Test ===');
  console.log(`Fund: ${r.name}`);
  console.log(`NAV start: ${r.nav_start}, NAV end: ${r.nav_end}`);
  console.log(`Return: ${pctReturn}%`);

  // Test 2: Holding realized return for Kestrel Emerging Growth
  const holdingReturn = await query(`
    WITH LatestNav AS (
      SELECT 
        id,
        (SELECT (record->>'nav')::NUMERIC 
         FROM jsonb_array_elements(nav_history) record 
         ORDER BY (record->>'date')::DATE DESC LIMIT 1) AS current_nav
      FROM funds
    )
    SELECT 
      h.fund_name,
      h.units,
      h.purchase_nav,
      ln.current_nav,
      ROUND((h.units * ln.current_nav)::NUMERIC, 2) AS current_value,
      ROUND((h.units * h.purchase_nav)::NUMERIC, 2) AS purchase_cost,
      ROUND(((h.units * ln.current_nav) - (h.units * h.purchase_nav))::NUMERIC, 2) AS realized_return_inr
    FROM holdings h
    JOIN LatestNav ln ON h.fund_id = ln.id
    WHERE similarity(h.fund_name, $1) > 0.2
    ORDER BY similarity(h.fund_name, $1) DESC
    LIMIT 1
  `, ['Kestrel Emerging Growth Fund']);

  console.log('\n=== Holding Return Test ===');
  console.log(JSON.stringify(holdingReturn.rows[0], null, 2));

  await closePool();
}

testQueries();
