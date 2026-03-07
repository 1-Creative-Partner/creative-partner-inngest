import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from './inngest-client.js';
import { analyticsNightlyPull } from './functions/analytics-nightly-pull.js';
import { adsNightlyPull } from './functions/ads-nightly-pull.js';
import { basecampNightlySync } from './functions/basecamp-nightly-sync.js';
import { promptAutoscorer } from './functions/prompt-autoscorer.js';

const app = express();
app.use(express.json());

// Health check - Render uses this to confirm service is alive
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'creative-partner-os',
    timestamp: new Date().toISOString(),
    functions: ['analytics-nightly-pull', 'ads-nightly-pull', 'basecamp-nightly-sync', 'prompt-autoscorer']
  });
});

// Inngest serve endpoint - this is what Inngest calls to execute functions
app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [
      analyticsNightlyPull,
      adsNightlyPull,
      basecampNightlySync,
      promptAutoscorer,
    ],
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Creative Partner OS running on port ${PORT}`);
  console.log(`Inngest endpoint: http://localhost:${PORT}/api/inngest`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
