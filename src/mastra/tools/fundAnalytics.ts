import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { calculatePeriodReturn, calculateHoldingReturn } from '../../database/fundAnalytics';
import { checkAndTriggerAsync } from '../../utils/asyncContext';

export const computeInvestmentAnalyticsTool = createTool({
  id: 'compute-investment-analytics',
  description: 'Performs investment analytics on mutual funds. Supports three operations: PERIOD_RETURN calculates a fund\'s performance over a date range, HOLDING_RETURN shows realized P&L on user holdings, and FUND_RANKING ranks all funds by period return.',
  inputSchema: z.object({
    operation: z.enum(['PERIOD_RETURN', 'HOLDING_RETURN', 'FUND_RANKING'])
      .describe('PERIOD_RETURN: fund performance over a date range. HOLDING_RETURN: realized return on user holdings. FUND_RANKING: rank all funds by period return.'),
    fundName: z.string().optional().describe('Fund name to match (uses fuzzy matching). Required for PERIOD_RETURN, optional for HOLDING_RETURN (omit to get all holdings).'),
    startDate: z.string().optional().describe('Start date for period return calculation (YYYY-MM-DD). Required for PERIOD_RETURN and FUND_RANKING.'),
    endDate: z.string().optional().describe('End date for period return calculation (YYYY-MM-DD). Required for PERIOD_RETURN and FUND_RANKING.'),
  }),
  outputSchema: z.object({
    results: z.array(z.any()).optional(),
    job_id: z.string().optional(),
    status: z.string().optional(),
  }),
  execute: async ({ operation, fundName, startDate, endDate }) => {
    const asyncTrigger = await checkAndTriggerAsync('compute-investment-analytics', {
      operation,
      fundName,
      startDate,
      endDate,
    });
    if (asyncTrigger) {
      return asyncTrigger;
    }

    switch (operation) {
      case 'PERIOD_RETURN': {
        if (!fundName || !startDate || !endDate) {
          return { results: [{ error: 'fundName, startDate, and endDate are required for PERIOD_RETURN' }] };
        }
        const data = await calculatePeriodReturn({ fundName, startDate, endDate });
        return { results: data };
      }
      case 'FUND_RANKING': {
        if (!startDate || !endDate) {
          return { results: [{ error: 'startDate and endDate are required for FUND_RANKING' }] };
        }
        const data = await calculatePeriodReturn({ startDate, endDate, rankAll: true });
        return { results: data };
      }
      case 'HOLDING_RETURN': {
        const data = await calculateHoldingReturn({ fundName });
        return { results: data };
      }
      default:
        return { results: [{ error: `Unknown operation: ${operation}` }] };
    }
  },
});
