const neatlogs = require('neatlogs');
neatlogs.init({
  apiKey: process.env.NEATLOGS_API_KEY,
  workflowName: 'sdk-otlp-verif',
  debug: true,
});

(async () => {
  await neatlogs.trace({ name: 'sdk-otlp-verif', kind: 'WORKFLOW' }, async () => {
    await neatlogs.trace({ name: 'tool_call', kind: 'TOOL' }, async () => {
      return { ok: 1 };
    });
  });
  await neatlogs.flush();
  await neatlogs.shutdown();
})();
