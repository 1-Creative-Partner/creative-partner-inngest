import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SLACK_WEBHOOK_PROPOSALS = process.env.SLACK_WEBHOOK_PROPOSALS;
const PORTAL_BASE_URL = "https://portal.creativepartnersolutions.com";
const proposalNotify = inngest.createFunction(
  {
    id: "proposal-notify",
    name: "Proposal: Event Router + Slack Notify",
    retries: 2
  },
  { event: "proposal/event.received" },
  async ({ event, step }) => {
    const {
      event_type,
      client_slug,
      client_name = "Client",
      proposal_name = "Proposal",
      scroll_depth = 0,
      time_on_page_seconds = 0,
      session_id = "n/a"
    } = event.data;
    const proposalUrl = `${PORTAL_BASE_URL}/proposals/${client_slug}`;
    const timestamp = (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
      timeZone: "America/Detroit",
      hour12: true
    });
    await step.run("send-slack-notification", async () => {
      const isApproval2 = event_type === "PROPOSAL_ACCEPTED" || event_type === "approval_submitted";
      let slackPayload;
      if (isApproval2) {
        slackPayload = {
          text: "PROPOSAL APPROVED!",
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "PROPOSAL APPROVED \u2014 Take Action!", emoji: true }
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Client:*
${client_name}` },
                { type: "mrkdwn", text: `*Proposal:*
${proposal_name}` },
                { type: "mrkdwn", text: `*Time:*
${timestamp}` }
              ]
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Move them to *Proposal Approved* in GHL and send kickoff confirmation email!"
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "View Proposal", emoji: true },
                  url: proposalUrl,
                  style: "primary"
                }
              ]
            }
          ]
        };
      } else {
        slackPayload = {
          text: "Proposal Opened!",
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Proposal Opened \u2014 Client is Reading!", emoji: true }
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Client:*
${client_name}` },
                { type: "mrkdwn", text: `*Proposal:*
${proposal_name}` },
                { type: "mrkdwn", text: `*Time:*
${timestamp}` },
                { type: "mrkdwn", text: `*Scroll Depth:*
${scroll_depth}%` },
                { type: "mrkdwn", text: `*Time on Page:*
${time_on_page_seconds}s` },
                { type: "mrkdwn", text: `*Event:*
${event_type}` }
              ]
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "View Proposal", emoji: true },
                  url: proposalUrl,
                  style: "primary"
                }
              ]
            }
          ]
        };
      }
      const res = await fetch(SLACK_WEBHOOK_PROPOSALS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload)
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Slack notification failed: ${res.status} ${err}`);
      }
      return { sent: true, eventType: event_type, isApproval: isApproval2 };
    });
    await step.run("log-to-supabase", async () => {
      const { error } = await supabase.from("proposal_view_event").insert({
        client_slug,
        event_type: `${event_type}_inngest_processed`,
        session_id,
        value: "processed",
        metadata: {
          scroll_depth,
          time_on_page_seconds,
          client_name,
          proposal_name,
          processed_by: "inngest"
        }
      });
      if (error) {
        console.error("Failed to log proposal event to Supabase:", error.message);
      }
      return { logged: !error };
    });
    const isApproval = event_type === "PROPOSAL_ACCEPTED" || event_type === "approval_submitted";
    if (isApproval) {
      await step.run("log-approval-cia-episode", async () => {
        await supabase.from("cia_episode").insert({
          episode_type: "change",
          source_system: "claude",
          actor: client_name,
          content: `Proposal approved by ${client_name} (${client_slug}). Proposal: "${proposal_name}". Action required: move to Proposal Approved stage in GHL.`,
          metadata: {
            client_slug,
            client_name,
            proposal_name,
            proposal_url: proposalUrl,
            session_id,
            event_type,
            action_required: "Move GHL opportunity to Proposal Approved stage"
          },
          timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
        });
      });
    }
    return {
      success: true,
      eventType: event_type,
      clientSlug: client_slug,
      isApproval,
      slackSent: true
    };
  }
);
export {
  proposalNotify
};
