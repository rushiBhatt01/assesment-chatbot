import { query, closePool } from '../database/db';

async function verify() {
  // Check Apollo Pharmacy alias matching
  const r1 = await query(
    `SELECT merchant, SUM(amount) as total, COUNT(*) as cnt
     FROM transactions
     WHERE similarity(merchant, $1) > 0.35
       AND category != 'transfer'
       AND date BETWEEN '2024-01-01' AND '2024-01-31T23:59:59Z'
     GROUP BY merchant`,
    ['Apollo Pharmacy']
  );
  console.log('=== Apollo Pharmacy alias matches (Jan 2024) ===');
  console.log(JSON.stringify(r1.rows, null, 2));

  // Check Zepto with refund breakdown
  const r2 = await query(
    `SELECT merchant,
       SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as expenses,
       SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) as refunds,
       SUM(amount) as net,
       COUNT(*) as cnt
     FROM transactions
     WHERE similarity(merchant, $1) > 0.35
       AND category != 'transfer'
       AND date BETWEEN '2024-01-01' AND '2024-01-31T23:59:59Z'
     GROUP BY merchant`,
    ['Zepto']
  );
  console.log('\n=== Zepto refund breakdown (Jan 2024) ===');
  console.log(JSON.stringify(r2.rows, null, 2));

  await closePool();
}

verify();
