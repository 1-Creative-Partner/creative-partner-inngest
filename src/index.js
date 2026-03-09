import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from './inngest-client.js';
import { analyticsNightlyPull } from './functions/analytics-nightly-pull.js';
import { adsNightlyPull } from './functions/ads-nightly-pull.js';
import { basecampNightlySync } from './functions/basecamp-nightly-sync.js';
import { basecampTokenRefresh } from './functions/credentials/basecamp-token-refresh.js';
import { metaTokenRefresh } from './functions/credentials/meta-token-refresh.js';
import { promptAutoscorer } from './functions/prompt-autoscorer.js';
import { helloWorldHealthCheck } from './functions/health/hello-world-health.js';
import { sessionEnforcement } from './functions/session/session-enforcement.js';
import { competitorSignalWeekly } from './functions/monitoring/competitor-signal-weekly.js';
import { kgEnrichmentSunday } from './functions/monitoring/kg-enrichment-sunday.js';

const app = express();
app.use(express.json());

// Health check - Render uses this to confirm service is alive
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'creative-partner-os',
    timestamp: new Date().toISOString(),
    functions: [
      'analytics-nightly-pull', 
      'ads-nightly-pull', 
      'basecamp-nightly-sync',
      'basecamp-token-refresh',
      'meta-token-refresh',
      'prompt-autoscorer',
      'hello-world-health-check',
      'session-enforcement',
      'competitor-signal-weekly',
      'kg-enrichment-sunday',
    ]
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
      basecampTokenRefresh,
      metaTokenRefresh,
      promptAutoscorer,
      helloWorldHealthCheck,
      sessionEnforcement,
      competitorSignalWeekly,
      kgEnrichmentSunday,
    ],
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Creative Partner OS running on port ${PORT}`);
  console.log(`Inngest endpoint: http://localhost:${PORT}/api/inngest`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
