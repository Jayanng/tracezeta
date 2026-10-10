const neatlogs = require('neatlogs');
neatlogs.init({ apiKey: process.env.NEATLOGS_API_KEY, workflowName: 'sdk-shape-test' });

(async () => {
  await neatlogs.trace({ name: 'sdk-shape-test', kind: 'WORKFLOW' }, async () => {
    await neatlogs.trace({ name: 'get_exchange_rate', kind: 'TOOL' }, async () => {
      return { rate: 0.89 };
    });
  });
  console.log('  spans closed');
  await neatlogs.flush();
  await neatlogs.shutdown();
  console.log('  flushed + shutdown');
})();
