import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { pgDataRepository } from '../../database/pgRepo';
import { detectSubscriptions } from '../../database/subscriptionDetection';
import { calculateHoldingReturn } from '../../database/fundAnalytics';

// Step 1: Fetch transactions and spending metrics
const fetchSpendingStep = createStep({
  id: 'fetch-spending',
  description: 'Fetches transaction spending totals and metrics for a given date range',
  inputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
  outputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    spending: z.any(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');
    const startIso = new Date(inputData.startDate).toISOString();
    const endIso = new Date(inputData.endDate).toISOString();

    const spending = await pgDataRepository.advancedLedgerQuery({
      start: startIso,
      end: endIso,
      operationMode: 'SUM',
      includeRefunds: false,
    });

    return {
      startDate: inputData.startDate,
      endDate: inputData.endDate,
      spending,
    };
  },
});

// Step 2: Detect subscriptions
const detectSubscriptionsStep = createStep({
  id: 'detect-subscriptions',
  description: 'Detects recurring subscriptions in the transaction history',
  inputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    spending: z.any(),
  }),
  outputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    spending: z.any(),
    subscriptions: z.any(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');

    const subscriptions = await detectSubscriptions({
      minOccurrences: 2,
      amountTolerancePct: 10,
      intervalMinDays: 25,
      intervalMaxDays: 35,
    });

    return {
      ...inputData,
      subscriptions,
    };
  },
});

// Step 3: Evaluate portfolio holdings
const evaluatePortfolioStep = createStep({
  id: 'evaluate-portfolio',
  description: 'Calculates realized returns on mutual fund holdings',
  inputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    spending: z.any(),
    subscriptions: z.any(),
  }),
  outputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    spending: z.any(),
    subscriptions: z.any(),
    portfolio: z.any(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData) throw new Error('Missing input data');

    const portfolio = await calculateHoldingReturn({});

    return {
      ...inputData,
      portfolio,
    };
  },
});

// Step 4: Compile report using Tara Agent
const compileReportStep = createStep({
  id: 'compile-report',
  description: 'Compiles a monthly financial health report using Tara Agent',
  inputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
    spending: z.any(),
    subscriptions: z.any(),
    portfolio: z.any(),
  }),
  outputSchema: z.object({
    report: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData) throw new Error('Missing input data');

    const agent = mastra?.getAgent('taraAgent');
    if (!agent) throw new Error('Tara agent not found');

    const prompt = `Generate a monthly financial health report for the period between ${inputData.startDate} and ${inputData.endDate}.
    
Here is the raw data retrieved from the database:
- Spending Summary: ${JSON.stringify(inputData.spending, null, 2)}
- Active Subscriptions: ${JSON.stringify(inputData.subscriptions, null, 2)}
- Mutual Fund Portfolio Returns: ${JSON.stringify(inputData.portfolio, null, 2)}

Provide a grounded, professional financial health report. Remember your zero-tolerance grounding constraints:
1. Every financial figure, total, or return factor you quote MUST match the raw data above exactly.
2. Do not perform any arithmetic calculations (sums, differences, percentages) yourself. Only report the calculated numbers present in the data.
3. Exclude any transfer transactions from spending totals.`;

    const response = await agent.generate([
      {
        role: 'user',
        content: prompt,
      },
    ]);

    return {
      report: response.text,
    };
  },
});

// Define and commit the workflow
export const taraFinancialReportWorkflow = createWorkflow({
  id: 'tara-financial-report-workflow',
  inputSchema: z.object({
    startDate: z.string().describe('Start date boundary (YYYY-MM-DD)'),
    endDate: z.string().describe('End date boundary (YYYY-MM-DD)'),
  }),
  outputSchema: z.object({
    report: z.string(),
  }),
})
  .then(fetchSpendingStep)
  .then(detectSubscriptionsStep)
  .then(evaluatePortfolioStep)
  .then(compileReportStep);

taraFinancialReportWorkflow.commit();
