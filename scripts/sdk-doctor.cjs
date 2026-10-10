const neatlogs = require('neatlogs');
(async () => {
  await neatlogs.init({
    apiKey: process.env.NEATLOGS_API_KEY,
    workflowName: 'doctor-probe',
    doctorProbe: true,
    diagnosticCapture: true,
  });
  await neatlogs.trace({ name: 'doctor-probe-run', kind: 'WORKFLOW' }, async () => {
    await neatlogs.trace({ name: 'probe_tool', kind: 'TOOL' }, async () => 1);
  });
  await neatlogs.flush();
  await neatlogs.shutdown();
  console.log('PROBE DONE');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
