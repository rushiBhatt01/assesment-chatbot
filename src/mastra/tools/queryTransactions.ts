import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { pgDataRepository } from '../../database/pgRepo';
import { checkAndTriggerAsync } from '../../utils/asyncContext';

export const queryTransactionsTool = createTool({
  id: 'query-transactions',
  description: 'Performs unified transaction analysis over PostgreSQL tables. Handles queries for net categories, programmatic merchant fuzzy matching, cash reversal netting, and self-transfer exclusions.',
  inputSchema: z.object({
    merchantPattern: z.string().optional().describe('Fuzzy merchant name to match. Uses trigram similarity matching.'),
    categoryFilter: z.string().optional().describe('Target category filter. E.g. health, food, groceries. Transfers are automatically excluded.'),
    startDate: z.string().optional().describe('Start date boundary (ISO 8601 format, YYYY-MM-DD). Defaults to 2024-01-01 if omitted.'),
    endDate: z.string().optional().describe('End date boundary (ISO 8601 format, YYYY-MM-DD). Defaults to today if omitted.'),
    metricsOperation: z.enum(['RAW_LIST', 'SUM', 'MONTH_OVER_MONTH_TREND', 'TOP_MERCHANTS_RANKING', 'CATEGORY_BREAKDOWN'])
      .default('SUM')
      .describe('The operation to execute: SUM for total spend, RAW_LIST for transaction history list, MONTH_OVER_MONTH_TREND for spending over time, TOP_MERCHANTS_RANKING for highest spend merchants, CATEGORY_BREAKDOWN for per-category spending totals.'),
    includeRefunds: z.boolean()
      .default(false)
      .describe('When true, includes refund transactions (negative amounts) in totals, netting them against expenses. When false (default), only positive expense amounts are summed.'),
  }),
  outputSchema: z.object({
    payload: z.array(z.any()).optional(),
    job_id: z.string().optional(),
    status: z.string().optional(),
  }),
  execute: async ({ merchantPattern, categoryFilter, startDate, endDate, metricsOperation, includeRefunds }) => {
    const asyncTrigger = await checkAndTriggerAsync('query-transactions', {
      merchantPattern,
      categoryFilter,
      startDate,
      endDate,
      metricsOperation,
      includeRefunds,
    });
    if (asyncTrigger) {
      return asyncTrigger;
    }

    // Standardize input date formats to ISO strings, with sensible defaults
    const startIso = startDate ? new Date(startDate).toISOString() : new Date('2024-01-01').toISOString();
    const endIso = endDate ? new Date(endDate).toISOString() : new Date().toISOString();

    const response = await pgDataRepository.advancedLedgerQuery({
      merchant: merchantPattern,
      category: categoryFilter,
      start: startIso,
      end: endIso,
      operationMode: metricsOperation,
      includeRefunds: includeRefunds,
    });

    return { payload: response };
  },
});
