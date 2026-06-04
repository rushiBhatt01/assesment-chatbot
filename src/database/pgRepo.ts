import { query } from './db';

export interface LedgerQueryInput {
  merchant?: string;
  category?: string;
  start: string;
  end: string;
  operationMode: 'RAW_LIST' | 'SUM' | 'MONTH_OVER_MONTH_TREND' | 'TOP_MERCHANTS_RANKING';
  includeRefunds?: boolean;
}

export class PgRepo {
  async initializeSchema() {
    console.log('Initializing database schema...');
    
    // Create extensions
    await query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    await query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');

    // Create enum type async_job_status if not exists
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'async_job_status') THEN
          CREATE TYPE async_job_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
        END IF;
      END
      $$;
    `);

    // Create tables
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(255) PRIMARY KEY,
        date TIMESTAMP WITH TIME ZONE NOT NULL,
        merchant VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL,
        currency VARCHAR(10) NOT NULL,
        memo TEXT NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS funds (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        nav_history JSONB NOT NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS holdings (
        fund_id VARCHAR(255) NOT NULL,
        fund_name VARCHAR(255) NOT NULL,
        units NUMERIC(18, 4) NOT NULL,
        purchase_date TIMESTAMP WITH TIME ZONE NOT NULL,
        purchase_nav NUMERIC(12, 4) NOT NULL,
        CONSTRAINT fk_holdings_funds FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS async_execution_jobs (
        job_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        status async_job_status NOT NULL DEFAULT 'PENDING',
        payload_input JSONB NOT NULL,
        payload_output JSONB NULL,
        final_answer TEXT NULL,
        error_log TEXT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query('ALTER TABLE async_execution_jobs ADD COLUMN IF NOT EXISTS final_answer TEXT NULL;');

    // Create indexes
    await query('CREATE INDEX IF NOT EXISTS idx_transactions_merchant_trgm ON transactions USING GIST (merchant gist_trgm_ops);');
    await query('CREATE INDEX IF NOT EXISTS idx_transactions_perf_composite ON transactions (category, date, merchant) INCLUDE (amount);');
    await query('CREATE INDEX IF NOT EXISTS idx_funds_nav_history_gin ON funds USING GIN (nav_history);');
    await query('CREATE INDEX IF NOT EXISTS idx_async_jobs_status_created ON async_execution_jobs (status, created_at);');

    console.log('Database schema initialization completed.');
  }

  async advancedLedgerQuery(input: LedgerQueryInput) {
    const { merchant, category, start, end, operationMode, includeRefunds = false } = input;
    const params: any[] = [];
    let paramIndex = 1;

    // Base filters
    // We always exclude transfers from spending metrics
    let whereClauses = [`t.category != 'transfer'`, `t.date BETWEEN $${paramIndex++} AND $${paramIndex++}`];
    params.push(start, end);

    // Refund filtering: when includeRefunds is false, exclude negative amounts (refunds)
    if (!includeRefunds) {
      whereClauses.push('t.amount > 0');
    }

    if (category) {
      whereClauses.push(`t.category = $${paramIndex++}`);
      params.push(category);
    }

    let merchantCTE = '';
    let merchantJoin = '';
    let selectSimilarity = '';

    if (merchant) {
      merchantCTE = `
        WITH MatchingMerchantGroup AS (
          SELECT DISTINCT merchant, similarity(merchant, $${paramIndex++}) AS string_likeness_score
          FROM transactions
          WHERE similarity(merchant, $${paramIndex - 1}) > 0.35
        )
      `;
      params.push(merchant);
      merchantJoin = ` JOIN MatchingMerchantGroup mmg ON t.merchant = mmg.merchant `;
      selectSimilarity = `, MAX(mmg.string_likeness_score) as likeness `;
    }

    let queryText = '';

    switch (operationMode) {
      case 'SUM':
        queryText = `
          ${merchantCTE}
          SELECT 
            COALESCE(SUM(t.amount), 0.00) AS net_expenditure_total,
            COUNT(*) AS absolute_transaction_volume
          FROM transactions t
          ${merchantJoin}
          WHERE ${whereClauses.join(' AND ')}
        `;
        break;

      case 'RAW_LIST':
        queryText = `
          ${merchantCTE}
          SELECT 
            t.id, t.date, t.merchant, t.category, t.amount, t.currency, t.memo
            ${merchant ? ', mmg.string_likeness_score' : ''}
          FROM transactions t
          ${merchantJoin}
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY ${merchant ? 'mmg.string_likeness_score DESC, ' : ''} t.date DESC
          LIMIT 50
        `;
        break;

      case 'TOP_MERCHANTS_RANKING':
        queryText = `
          ${merchantCTE}
          SELECT 
            t.merchant AS merchant_name,
            COALESCE(SUM(t.amount), 0.00) AS total_spend,
            COUNT(*) AS transaction_count
            ${selectSimilarity}
          FROM transactions t
          ${merchantJoin}
          WHERE ${whereClauses.join(' AND ')}
          GROUP BY t.merchant
          ORDER BY ${merchant ? 'MAX(mmg.string_likeness_score) DESC, ' : ''} total_spend DESC
          LIMIT 10
        `;
        break;

      case 'MONTH_OVER_MONTH_TREND':
        queryText = `
          ${merchantCTE}
          SELECT 
            TO_CHAR(t.date, 'YYYY-MM') AS month,
            COALESCE(SUM(t.amount), 0.00) AS total_spend,
            COUNT(*) AS transaction_count
          FROM transactions t
          ${merchantJoin}
          WHERE ${whereClauses.join(' AND ')}
          GROUP BY TO_CHAR(t.date, 'YYYY-MM')
          ORDER BY month ASC
        `;
        break;

      default:
        throw new Error(`Unsupported operationMode: ${operationMode}`);
    }

    const result = await query(queryText, params);
    return result.rows;
  }
}

export const pgDataRepository = new PgRepo();
