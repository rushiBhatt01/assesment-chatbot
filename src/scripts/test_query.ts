import { mastra } from '../mastra';

async function test() {
  const agent = mastra.getAgent('taraAgent');
  const question = "How much did I spend in January 2024?";
  
  console.log(`Running query: "${question}"`);
  const result = await agent.generate([
    {
      role: 'user',
      content: question,
    }
  ]);
  
  console.log('Result text:', JSON.stringify(result.text));
  console.log('Steps:');
  console.dir(result.steps, { depth: null });
  
  process.exit(0);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
