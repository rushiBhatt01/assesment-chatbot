import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { detectSubscriptions } from '../../database/subscriptionDetection';
import { checkAndTriggerAsync } from '../../utils/asyncContext';

export const detectSubscriptionsTool = createTool({
  id: 'detect-subscriptions',
  description: 'Detects recurring subscription-like transactions by analyzing merchant transaction patterns. Identifies merchants with regular monthly intervals (25-35 days) and consistent amounts (within ±10% tolerance). Returns structured subscription data including typical amount, annual estimate, and confidence.',
  inputSchema: z.object({
    minOccurrences: z.number().int().default(2).describe('Minimum number of transactions required to consider a merchant as a subscription. Default: 2.'),
    amountTolerancePct: z.number().default(10).describe('Maximum allowed percentage variance between min and max transaction amounts. Default: 10 (meaning ±10%).'),
    intervalMinDays: z.number().int().default(25).describe('Minimum days between transactions to qualify as monthly interval. Default: 25.'),
    intervalMaxDays: z.number().int().default(35).describe('Maximum days between transactions to qualify as monthly interval. Default: 35.'),
  }),
  outputSchema: z.object({
    subscriptions: z.array(z.object({
      merchant: z.string(),
      occurrence_count: z.number(),
      typical_amount: z.number(),
      annual_estimate: z.number(),
      monthly_confidence_pct: z.number(),
      first_date: z.string(),
      last_date: z.string(),
    })).optional(),
    count: z.number().optional(),
    job_id: z.string().optional(),
    status: z.string().optional(),
  }),
  execute: async ({ minOccurrences, amountTolerancePct, intervalMinDays, intervalMaxDays }) => {
    const asyncTrigger = await checkAndTriggerAsync('detect-subscriptions', {
      minOccurrences,
      amountTolerancePct,
      intervalMinDays,
      intervalMaxDays,
    });
    if (asyncTrigger) {
      return asyncTrigger;
    }

    const subscriptions = await detectSubscriptions({
      minOccurrences,
      amountTolerancePct,
      intervalMinDays,
      intervalMaxDays,
    });

    return {
      subscriptions,
      count: subscriptions.length,
    };
  },
});
