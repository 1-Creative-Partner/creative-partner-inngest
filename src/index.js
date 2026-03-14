import express from 'express';
import { serve } from 'inngest/express';
import { inngest } from './inngest-client.js';

// ── EXISTING FUNCTIONS ─────────────────────────────────────────────────────
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

// ── NEW FUNCTIONS ──────────────────────────────────────────────────────────
// DISABLED 2026-03-14: duplicated ghl-webhook-buffer on cp/ghl.webhook.received
// import { ghlWebhookRouter } from './functions/ghl-webhook-router.js';
import { ghlTranscriptProcessor } from './functions/ghl-transcript-processor.js';
import { ghlInboundMessageProcessor, ghlCommunicationExtraction } from './functions/ghl-message-processor.js';
import { ghlFormProcessor } from './functions/ghl-form-processor.js';
import {
  ghlContactCreated, ghlOpportunityCreated, ghlOpportunityStageUpdated,
  ghlContactTagsUpdated, ghlAppointmentCreated
} from './functions/ghl-webhook-processor.js';
import { transcriptIntelligenceAgent } from './functions/transcript-intelligence-agent.js';
import { metaAgentOptimizer } from './functions/meta-agent-optimizer.js';
import { morningBriefingAgent } from './functions/morning-briefing-agent.js';
import dailyHealthMonitor from './functions/daily-health-monitor.js';
import { clientOnboardingAutomation } from './functions/client-onboarding.js';
import { proposalNotify } from './functions/proposal-notify.js';
import {
  basecampTodoCreated, basecampTodoCompleted, basecampCommentCreated,
  basecampMessageCreated, basecampTodoUncompleted, basecampDocumentCreated
} from './functions/basecamp-webhook-processor.js';
import {
  clickupTaskCreated, clickupTaskStatusUpdated, clickupTaskCommentPosted,
  clickupTaskUpdated, clickupTaskAssigneeUpdated, clickupTaskDeleted
} from './functions/clickup-webhook-processor.js';
import { bugherdWebhookReceiver, bugherdCommentReceiver } from './functions/bugherd-webhook.js';
import { googleDocsCommentPoller, checkSingleDocComments } from './functions/google-docs-comment-poller.js';
import { ghlWebhookBuffer } from './functions/ghl-webhook-buffer.js';
import { llmLandscapeMonitor } from './functions/monitoring/llm-landscape-monitor.js';
import { matrixOptimizer } from './functions/monitoring/matrix-optimizer.js';
import { routingQualityScorer } from './functions/monitoring/routing-quality-scorer.js';
import { promptOptimizer } from './functions/monitoring/prompt-optimizer.js';

// ── PHASE 1: Pipeline Functions ──────────────────────────────────────────────
import { modelRouterTest } from './functions/health/model-router-test.js';
import { dealDetector } from './functions/deal-detector.js';
import { businessAnalyzer } from './functions/business-analyzer.js';

// ── TASK ROUTER ──────────────────────────────────────────────────────────────
import { taskRouterImmediate, taskRouterScheduled } from './functions/task-router.js';

// ── SYSTEM AUDIT ─────────────────────────────────────────────────────────────
import { systemAuditRunner, systemAuditOnDemand } from './functions/system-audit-runner.js';
import { weeklySystemAudit } from './functions/weekly-system-audit.js';

// ── HEALTH MONITORS ──────────────────────────────────────────────────────────
import { portalHealthMonitor } from './functions/portal-health-monitor.js';
import { pipelineSmokeTest } from './functions/pipeline-smoke-test.js';

// ── SLACK ACTIONS ────────────────────────────────────────────────────────────
import { setupSlackRoutes } from './routes/slack-actions.js';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'creative-partner-os', timestamp: new Date().toISOString() });
});

// Register Slack interactive button handler
setupSlackRoutes(app);

app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [
      analyticsNightlyPull, adsNightlyPull, basecampNightlySync,
      basecampTokenRefresh, metaTokenRefresh, ghlOauthRefresh,
      promptAutoscorer, helloWorldHealthCheck, sessionEnforcement,
      competitorSignalWeekly, kgEnrichmentSunday,
      ghlTranscriptProcessor, ghlInboundMessageProcessor,
      ghlCommunicationExtraction, ghlFormProcessor, ghlContactCreated,
      ghlOpportunityCreated, ghlOpportunityStageUpdated,
      ghlContactTagsUpdated, ghlAppointmentCreated,
      transcriptIntelligenceAgent, metaAgentOptimizer, morningBriefingAgent, dailyHealthMonitor,
      clientOnboardingAutomation, proposalNotify,
      basecampTodoCreated, basecampTodoCompleted, basecampCommentCreated,
      basecampMessageCreated, basecampTodoUncompleted, basecampDocumentCreated,
      clickupTaskCreated, clickupTaskStatusUpdated, clickupTaskCommentPosted,
      clickupTaskUpdated, clickupTaskAssigneeUpdated, clickupTaskDeleted,
      bugherdWebhookReceiver, bugherdCommentReceiver,
      googleDocsCommentPoller, checkSingleDocComments,
      ghlWebhookBuffer,
      llmLandscapeMonitor,
      matrixOptimizer,
      routingQualityScorer,
      promptOptimizer,
      // Phase 1: Pipeline
      modelRouterTest,
      dealDetector,
      businessAnalyzer,
      // Task Router
      taskRouterImmediate,
      taskRouterScheduled,
      // System Audit
      systemAuditRunner,
      systemAuditOnDemand,
      weeklySystemAudit,
      // Health Monitors
      portalHealthMonitor,
      pipelineSmokeTest,
    ],
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Creative Partner OS running on port ${PORT}`);
});
