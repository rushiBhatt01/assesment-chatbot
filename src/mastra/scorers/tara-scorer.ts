import { z } from 'zod';
import { createToolCallAccuracyScorerCode } from '@mastra/evals/scorers/prebuilt';
import { getAssistantMessageFromRunOutput, getUserMessageFromRunInput } from '@mastra/evals/scorers/utils';
import { createScorer } from '@mastra/core/evals';

// 1. Tool Call Accuracy Scorer (prebuilt check)
export const toolCallAccuracyScorer = createToolCallAccuracyScorerCode({
  expectedTool: 'query-transactions',
  strictMode: false,
});

// Helper to extract tool output values from execution run
function extractNumbers(obj: any): Set<number> {
  const numbers = new Set<number>();
  const traverse = (val: any) => {
    if (typeof val === 'number') {
      numbers.add(val);
    } else if (typeof val === 'string') {
      const match = val.match(/-?\d+(\.\d+)?/g);
      if (match) {
        match.forEach(num => numbers.add(parseFloat(num)));
      }
    } else if (val && typeof val === 'object') {
      Object.values(val).forEach(traverse);
    }
  };
  traverse(obj);
  return numbers;
}

// 2. Strict Grounding Scorer (LLM-judged check)
// Ensures the agent does not calculate or hallucinate any numeric values not present in tool outputs
export const strictGroundingScorer = createScorer({
  id: 'strict-grounding-scorer',
  name: 'Strict Factual Grounding',
  description: 'Ensures all mentioned financial figures in the response match the raw tool results exactly (no math/calculations allowed)',
  type: 'agent',
  judge: {
    model: 'google/gemini-2.5-flash',
    instructions:
      'You are a financial auditor checking for hallucinations and calculation errors in agent responses. ' +
      'Compare the numbers reported in the assistant response with the raw tool data provided. ' +
      'Check if any calculation was made by the assistant, or if any number was mentioned that was not in the raw tool data. ' +
      'Only return JSON matching the specified output schema.',
  },
})
  .preprocess(({ run }) => {
    const userText = getUserMessageFromRunInput(run.input) || '';
    const assistantText = getAssistantMessageFromRunOutput(run.output) || '';
    
    // Extract tool results from the run log
    const toolResults: any[] = [];
    if (run.steps) {
      run.steps.forEach(step => {
        if (step.toolResults) {
          step.toolResults.forEach((tr: any) => {
            toolResults.push(tr.result || tr.payload);
          });
        }
      });
    }

    return { userText, assistantText, toolResults };
  })
  .analyze({
    description: 'Analyze assistant response numbers against tool outputs',
    outputSchema: z.object({
      hasCalculationsOrHallucinations: z.boolean().describe('True if the assistant performed its own math or mentioned any number not present in the toolResults.'),
      unmatchedNumbers: z.array(z.number()).describe('List of numbers in assistantText that do not exist in toolResults.'),
      explanation: z.string().describe('Detailed explanation of why the score was given.'),
    }),
    createPrompt: ({ results }) => `
      You are auditing an agent's response for a strict "no calculations / no hallucinations" rule.
      
      Raw Tool Data:
      """
      ${JSON.stringify(results.preprocessStepResult.toolResults, null, 2)}
      """
      
      Assistant Response:
      """
      ${results.preprocessStepResult.assistantText}
      """
      
      Audit task:
      1) Extract all numbers, figures, and rates mentioned in the assistant's response.
      2) Verify if each of those numbers is present in the raw tool data.
      3) Verify if the assistant calculated any percentages, changes, or net sums that do not exist in the raw tool data.
      4) Identify if any numbers in the response are missing from the raw tool data.
      
      Return JSON:
      {
        "hasCalculationsOrHallucinations": boolean,
        "unmatchedNumbers": [number],
        "explanation": "string"
      }
    `,
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    // If the agent performed calculation or wrote unmatched numbers, score is 0. Else 1.
    return r.hasCalculationsOrHallucinations ? 0 : 1;
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `Audit score=${score}. ${r.explanation || ''} ${r.unmatchedNumbers?.length ? `Unmatched numbers: ${r.unmatchedNumbers.join(', ')}` : ''}`;
  });

export const scorers = {
  toolCallAccuracyScorer,
  strictGroundingScorer,
};
