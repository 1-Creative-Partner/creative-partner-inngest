import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from './inngest-client.js';

// ── EXISTING FUNCTIONS (.js) ───────────────────────────────────────────────
import { analyticsNightlyPull } from './functions/analytics-nightly-pull.js';
import { adsNightlyPull } from './functions/ads-nightly-pull.js';
import { basecampNightlySync } from './functions/basecamp-nightly-sync.js';
import { basecampTokenRefresh } from './functions/credentials/basecamp-token-refresh.js';
import { metaTokenRefresh } from './functions/credentials/meta-token-refresh.js';
import { ghlOauthRefresh } from './functions/credentials/ghl-oauth-refresh.js';
import { promptAutoscorer } from './functions/prompt-autoscorer.js';
import { helloWorldHealthCheck } from './functions/health/hello-world-health.js';
import { sessionEnforcement } from './functions/session/session-enforcement.js';
import { competitorSignalWeekly } from './functions/monitoring/competitor-signal-weekly.js';
import { kgEnrichmentSunday } from './functions/monitoring/kg-enrichment-sunday.js';

// ── NEW FUNCTIONS (.ts) ────────────────────────────────────────────────────
// GHL Webhook Pipeline
import { ghlWebhookRouter } from './functions/ghl-webhook-router.ts';
import { ghlTranscriptProcessor } from './functions/ghl-transcript-processor.ts';
import { ghlInboundMessageProcessor, ghlCommunicationExtraction } from './functions/ghl-message-processor.ts';
import { ghlFormProcessor } from './functions/ghl-form-processor.ts';
import {
  ghlContactCreated, ghlOpportunityCreated, ghlOpportunityStageUpdated,
  ghlMessageInbound, ghlContactTagsUpdated, ghlAppointmentCreated
} from './functions/ghl-webhook-processor.ts';

// AI Agents
import { transcriptIntelligenceAgent } from './functions/transcript-intelligence-agent.ts';
import { metaAgentOptimizer } from './functions/meta-agent-optimizer.ts';
import { morningBriefingAgent } from './functions/morning-briefing-agent.ts';
import dailyHealthMonitor from './functions/daily-health-monitor.ts';

// Client Lifecycle
import { clientOnboardingAutomation } from './functions/client-onboarding.ts';
import { proposalNotify } from './functions/proposal-notify.ts';

// Webhook Processors
import {
  basecampTodoCreated, basecampTodoCompleted, basecampCommentCreated,
  basecampMessageCreated, basecampTodoUncompleted, basecampDocumentCreated
} from './functions/basecamp-webhook-processor.ts';
import {
  clickupTaskCreated, clickupTaskStatusUpdated, clickupTaskCommentPosted,
  clickupTaskUpdated, clickupTaskAssigneeUpdated, clickupTaskDeleted
} from './functions/clickup-webhook-processor.ts';
import { bugherdWebhookReceiver, bugherdCommentReceiver } from './functions/bugherd-webhook.ts';
import { googleDocsCommentPoller, checkSingleDocComments } from './functions/google-docs-comment-poller.ts';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'creative-partner-os', timestamp: new Date().toISOString() });
});

app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [
      // Existing
      analyticsNightlyPull, adsNightlyPull, basecampNightlySync,
      basecampTokenRefresh, metaTokenRefresh, ghlOauthRefresh,
      promptAutoscorer, helloWorldHealthCheck, sessionEnforcement,
      competitorSignalWeekly, kgEnrichmentSunday,
      // GHL Pipeline
      ghlWebhookRouter, ghlTranscriptProcessor, ghlInboundMessageProcessor,
      ghlCommunicationExtraction, ghlFormProcessor, ghlContactCreated,
      ghlOpportunityCreated, ghlOpportunityStageUpdated, ghlMessageInbound,
      ghlContactTagsUpdated, ghlAppointmentCreated,
      // AI Agents
      transcriptIntelligenceAgent, metaAgentOptimizer, morningBriefingAgent, dailyHealthMonitor,
      // Client Lifecycle
      clientOnboardingAutomation, proposalNotify,
      // Webhook Processors
      basecampTodoCreated, basecampTodoCompleted, basecampCommentCreated,
      basecampMessageCreated, basecampTodoUncompleted, basecampDocumentCreated,
      clickupTaskCreated, clickupTaskStatusUpdated, clickupTaskCommentPosted,
      clickupTaskUpdated, clickupTaskAssigneeUpdated, clickupTaskDeleted,
      bugherdWebhookReceiver, bugherdCommentReceiver,
      googleDocsCommentPoller, checkSingleDocComments,
    ],
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Creative Partner OS running on port ${PORT}`);
});
