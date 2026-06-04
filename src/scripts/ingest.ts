import fs from 'fs/promises';
import path from 'path';
import { query, closePool } from '../database/db';
import { pgDataRepository } from '../database/pgRepo';

async function runIngest() {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) {
    console.error('Error: DATA_DIR environment variable must be specified.');
    process.exit(1);
  }

  const resolvedPath = path.resolve(dataDir);
  console.log(`Starting ingestion from snapshot directory: ${resolvedPath}`);

  try {
    // 1. Initialize schema to ensure tables and types are set up
    await pgDataRepository.initializeSchema();

    // 2. Clear existing database tables
    console.log('Clearing database tables for idempotent run...');
    await query('TRUNCATE TABLE holdings, funds, transactions CASCADE;');
    console.log('Database tables cleared successfully.');

    // 3. Load files
    const transactionsPath = path.join(resolvedPath, 'transactions.json');
    const fundsPath = path.join(resolvedPath, 'funds.json');
    const holdingsPath = path.join(resolvedPath, 'holdings.json');

    const rawTransactions = await fs.readFile(transactionsPath, 'utf8');
    const rawFunds = await fs.readFile(fundsPath, 'utf8');
    const rawHoldings = await fs.readFile(holdingsPath, 'utf8');

    const transactions = JSON.parse(rawTransactions);
    const funds = JSON.parse(rawFunds);
    const holdings = JSON.parse(rawHoldings);

    console.log(`Loaded JSON datasets: ${transactions.length} transactions, ${funds.length} funds, ${holdings.length} holdings.`);

    // 4. Ingest Transactions
    console.log('Inserting transactions in batches...');
    let insertedTransactions = 0;
    const validTransactions = transactions.filter((tx: any) => 
      tx.id && tx.date && tx.merchant && tx.category && tx.amount !== undefined && tx.currency
    );
    
    const txChunkSize = 200;
    for (let i = 0; i < validTransactions.length; i += txChunkSize) {
      const chunk = validTransactions.slice(i, i + txChunkSize);
      const valuePlaceholders: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      
      for (const tx of chunk) {
        valuePlaceholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        values.push(tx.id, tx.date, tx.merchant, tx.category, tx.amount, tx.currency, tx.memo || null);
      }
      
      await query(
        `INSERT INTO transactions (id, date, merchant, category, amount, currency, memo)
         VALUES ${valuePlaceholders.join(', ')}
         ON CONFLICT (id) DO NOTHING`,
        values
      );
      insertedTransactions += chunk.length;
    }
    console.log(`Successfully ingested ${insertedTransactions} transactions.`);

    // 5. Ingest Funds
    console.log('Inserting funds in batches...');
    let insertedFunds = 0;
    const validFunds = funds.filter((fund: any) => 
      fund.id && fund.name && fund.category && fund.nav
    );
    
    const fundChunkSize = 100;
    for (let i = 0; i < validFunds.length; i += fundChunkSize) {
      const chunk = validFunds.slice(i, i + fundChunkSize);
      const valuePlaceholders: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      
      for (const fund of chunk) {
        const mappedNavHistory = fund.nav.map((item: any) => ({
          date: item.date,
          nav: item.value !== undefined ? item.value : item.nav,
        }));
        
        valuePlaceholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        values.push(fund.id, fund.name, fund.category, JSON.stringify(mappedNavHistory));
      }
      
      await query(
        `INSERT INTO funds (id, name, category, nav_history)
         VALUES ${valuePlaceholders.join(', ')}
         ON CONFLICT (id) DO NOTHING`,
        values
      );
      insertedFunds += chunk.length;
    }
    console.log(`Successfully ingested ${insertedFunds} funds.`);

    // 6. Ingest Holdings
    console.log('Inserting holdings in batches...');
    let insertedHoldings = 0;
    const validHoldings: any[] = [];
    
    for (const holding of holdings) {
      if (!holding.fund_id || !holding.fund_name || holding.units === undefined || !holding.purchase_date || holding.purchase_nav === undefined) {
        console.warn(`Skipping malformed holding row: ${JSON.stringify(holding)}`);
        continue;
      }
      
      // Verify that the fund exists before inserting holding
      const checkFund = await query('SELECT 1 FROM funds WHERE id = $1', [holding.fund_id]);
      if (checkFund.rowCount === 0) {
        console.warn(`Skipping holding for non-existent fund: ${holding.fund_id}`);
        continue;
      }
      
      validHoldings.push(holding);
    }
    
    const holdingChunkSize = 100;
    for (let i = 0; i < validHoldings.length; i += holdingChunkSize) {
      const chunk = validHoldings.slice(i, i + holdingChunkSize);
      const valuePlaceholders: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      
      for (const holding of chunk) {
        valuePlaceholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        values.push(holding.fund_id, holding.fund_name, holding.units, holding.purchase_date, holding.purchase_nav);
      }
      
      await query(
        `INSERT INTO holdings (fund_id, fund_name, units, purchase_date, purchase_nav)
         VALUES ${valuePlaceholders.join(', ')}`,
        values
      );
      insertedHoldings += chunk.length;
    }
    console.log(`Successfully ingested ${insertedHoldings} holdings.`);
    console.log('Ingestion pipeline successfully completed.');
  } catch (err: any) {
    console.error('Ingestion failed with critical error:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

runIngest();
