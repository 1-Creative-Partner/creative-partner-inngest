import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const bugherdWebhookReceiver = inngest.createFunction(
  {
    id: "bugherd-webhook-receiver",
    name: "BugHerd Webhook Receiver - Client Feedback"
  },
  { event: "bugherd/task.created" },
  async ({ event, step }) => {
    const { task, project } = event.data;
    const feedback = await step.run("parse-bugherd-task", async () => {
      return {
        task_id: task.id,
        project_id: project.id,
        project_name: project.name,
        page_url: task.metadata?.url || task.requester?.url || null,
        feedback_text: task.description,
        priority: task.priority,
        status: task.status,
        tags: task.tags || [],
        created_by: task.created_by?.email || task.requester?.email || "Unknown",
        created_at: task.created_at
      };
    });
    const customer = await step.run("find-customer", async () => {
      const { data } = await supabase.from("customer").select("id, company_name, tenant_id").ilike("company_name", `%${project.name}%`).limit(1).single();
      return data || { id: "unknown", company_name: project.name, tenant_id: "creative-partner" };
    });
    const revision = await step.run("create-content-revision", async () => {
      const { data, error } = await supabase.from("content_revision").insert({
        tenant_id: customer.tenant_id || "creative-partner",
        customer_id: customer.id,
        content_type: "website_page",
        content_identifier: feedback.page_url || `bugherd-${feedback.task_id}`,
        content_title: `${project.name} - ${feedback.page_url || "Page Feedback"}`,
        version: 1,
        revision_round: 1,
        client_feedback: feedback.feedback_text,
        feedback_source: "bugherd",
        feedback_raw: JSON.stringify(task),
        feedback_parsed: {
          task_id: feedback.task_id,
          project_id: feedback.project_id,
          priority: feedback.priority,
          tags: feedback.tags,
          page_url: feedback.page_url
        },
        status: "pending",
        created_by: feedback.created_by,
        automation_status: "webhook_received"
      }).select().single();
      if (error)
        throw error;
      return data;
    });
    await step.run("send-slack-notification", async () => {
      const slackWebhook = process.env.SLACK_WEBHOOK_CLIENT_FEEDBACK;
      if (!slackWebhook) {
        console.warn("SLACK_WEBHOOK_CLIENT_FEEDBACK not configured");
        return { skipped: true };
      }
      const message = {
        text: `\u{1F41B} New BugHerd Feedback: ${customer.company_name}`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `\u{1F41B} ${customer.company_name} left feedback`,
              emoji: true
            }
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `*Page:*
${feedback.page_url || "N/A"}`
              },
              {
                type: "mrkdwn",
                text: `*Priority:*
${feedback.priority || "Normal"}`
              }
            ]
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Feedback:*
${feedback.feedback_text.substring(0, 500)}${feedback.feedback_text.length > 500 ? "..." : ""}`
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `BugHerd Task ID: ${feedback.task_id} | <https://bugherd.com/projects/${feedback.project_id}/tasks/${feedback.task_id}|View in BugHerd>`
              }
            ]
          }
        ]
      };
      await fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });
      return { sent: true, channel: "#client-feedback" };
    });
    const basecampTask = await step.run("create-basecamp-task", async () => {
      console.log(`TODO: Create Basecamp task for revision ${revision.id}`);
      return {
        skipped: true,
        reason: "Basecamp integration pending",
        revision_id: revision.id
      };
    });
    await step.run("log-to-cia", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "bugherd",
        actor: feedback.created_by,
        content: `BugHerd Feedback Received: ${customer.company_name} left feedback on ${feedback.page_url || "page"}. Feedback: "${feedback.feedback_text.substring(0, 200)}${feedback.feedback_text.length > 200 ? "..." : ""}"`,
        customer_id: customer.id,
        metadata: {
          bugherd_task_id: feedback.task_id,
          bugherd_project_id: feedback.project_id,
          content_revision_id: revision.id,
          page_url: feedback.page_url,
          tags: ["bugherd", "client_feedback", "content_revision", "automated"]
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return {
      success: true,
      revision_id: revision.id,
      customer: customer.company_name,
      slack_sent: true,
      basecamp_task: basecampTask
    };
  }
);
const bugherdCommentReceiver = inngest.createFunction(
  {
    id: "bugherd-comment-receiver",
    name: "BugHerd Comment Receiver"
  },
  { event: "bugherd/comment.created" },
  async ({ event, step }) => {
    const { comment, task, project } = event.data;
    const { data: existingRevision } = await supabase.from("content_revision").select("*").eq("feedback_source", "bugherd").contains("feedback_parsed", { task_id: task.id }).order("created_at", { ascending: false }).limit(1).single();
    if (existingRevision) {
      await supabase.from("content_revision").update({
        client_feedback: `${existingRevision.client_feedback}

---
New comment: ${comment.text}`,
        feedback_parsed: {
          ...existingRevision.feedback_parsed,
          comments: [...existingRevision.feedback_parsed.comments || [], comment]
        },
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      }).eq("id", existingRevision.id);
    }
    const slackWebhook = process.env.SLACK_WEBHOOK_CLIENT_FEEDBACK;
    if (slackWebhook) {
      await fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `\u{1F4AC} ${project.name}: New comment on BugHerd task #${task.id}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${comment.user?.name || "Client"}:* ${comment.text}`
              }
            }
          ]
        })
      });
    }
    return { success: true, revision_updated: !!existingRevision };
  }
);
export {
  bugherdCommentReceiver,
  bugherdWebhookReceiver
};
