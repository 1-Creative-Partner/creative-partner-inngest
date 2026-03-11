import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const googleDocsCommentPoller = inngest.createFunction(
  {
    id: "google-docs-comment-poller",
    name: "Google Docs Comment Poller"
  },
  { cron: "*/30 * * * *" },
  // Every 30 minutes
  async ({ step }) => {
    const activeDocs = await step.run("get-active-docs", async () => {
      const { data, error } = await supabase.from("content_revision").select("id, customer_id, google_doc_id, google_doc_url, content_title, updated_at").not("google_doc_id", "is", null).in("status", ["pending", "in_progress"]).order("updated_at", { ascending: false });
      if (error)
        throw error;
      return data || [];
    });
    if (activeDocs.length === 0) {
      return { success: true, docs_checked: 0, new_comments: 0 };
    }
    const drive = await step.run("init-google-drive", async () => {
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
        scopes: ["https://www.googleapis.com/auth/drive"]
      });
      return google.drive({ version: "v3", auth });
    });
    const results = await step.run("check-all-docs-for-comments", async () => {
      const results2 = [];
      for (const doc of activeDocs) {
        try {
          const lastCheckTime = new Date(doc.updated_at);
          lastCheckTime.setMinutes(lastCheckTime.getMinutes() - 35);
          const response = await drive.comments.list({
            fileId: doc.google_doc_id,
            fields: "comments(id,content,htmlContent,createdTime,modifiedTime,resolved,author,anchor)",
            startModifiedTime: lastCheckTime.toISOString(),
            includeDeleted: false,
            pageSize: 100
          });
          const newComments = response.data.comments || [];
          if (newComments.length > 0) {
            results2.push({
              doc_id: doc.id,
              google_doc_id: doc.google_doc_id,
              customer_id: doc.customer_id,
              content_title: doc.content_title,
              new_comments: newComments,
              comment_count: newComments.length
            });
          }
        } catch (error) {
          console.error(`Error checking doc ${doc.google_doc_id}:`, error);
          results2.push({
            doc_id: doc.id,
            google_doc_id: doc.google_doc_id,
            error: error.message
          });
        }
      }
      return results2;
    });
    for (const result of results.filter((r) => !r.error && r.new_comments?.length > 0)) {
      await step.run(`process-comments-${result.doc_id}`, async () => {
        const { data: customer } = await supabase.from("customer").select("id, company_name, tenant_id").eq("id", result.customer_id).single();
        for (const comment of result.new_comments) {
          if (comment.resolved)
            continue;
          const feedback_text = comment.htmlContent || comment.content || "";
          const author_name = comment.author?.displayName || comment.author?.emailAddress || "Unknown";
          const { data: existingDoc } = await supabase.from("content_revision").select("client_feedback, feedback_parsed").eq("id", result.doc_id).single();
          const updatedFeedback = existingDoc?.client_feedback ? `${existingDoc.client_feedback}

---
**${author_name}** (${new Date(comment.createdTime).toLocaleString()}):
${feedback_text}` : `**${author_name}** (${new Date(comment.createdTime).toLocaleString()}):
${feedback_text}`;
          const updatedParsed = {
            ...existingDoc?.feedback_parsed || {},
            google_comments: [
              ...existingDoc?.feedback_parsed?.google_comments || [],
              {
                comment_id: comment.id,
                author: author_name,
                content: feedback_text,
                created_time: comment.createdTime,
                modified_time: comment.modifiedTime,
                anchor: comment.anchor
              }
            ]
          };
          await supabase.from("content_revision").update({
            client_feedback: updatedFeedback,
            feedback_parsed: updatedParsed,
            feedback_source: existingDoc?.client_feedback ? "multiple" : "google_docs",
            automation_status: "comment_detected",
            updated_at: (/* @__PURE__ */ new Date()).toISOString()
          }).eq("id", result.doc_id);
          const slackWebhook = process.env.SLACK_WEBHOOK_CLIENT_FEEDBACK;
          if (slackWebhook) {
            await fetch(slackWebhook, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: `\u{1F4DD} ${customer?.company_name || "Client"}: New Google Doc comment`,
                blocks: [
                  {
                    type: "header",
                    text: {
                      type: "plain_text",
                      text: `\u{1F4DD} ${customer?.company_name || "Client"} left a comment`,
                      emoji: true
                    }
                  },
                  {
                    type: "section",
                    fields: [
                      {
                        type: "mrkdwn",
                        text: `*Document:*
${result.content_title || "Untitled"}`
                      },
                      {
                        type: "mrkdwn",
                        text: `*Author:*
${author_name}`
                      }
                    ]
                  },
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `*Comment:*
${feedback_text.substring(0, 500)}${feedback_text.length > 500 ? "..." : ""}`
                    }
                  },
                  {
                    type: "context",
                    elements: [
                      {
                        type: "mrkdwn",
                        text: `<https://docs.google.com/document/d/${result.google_doc_id}|View Document> | Comment ID: ${comment.id}`
                      }
                    ]
                  }
                ]
              })
            });
          }
          await supabase.from("cia_episode").insert({
            episode_type: "change",
            source_system: "google_docs",
            actor: author_name,
            content: `Google Doc Comment: ${customer?.company_name || "Client"} commented on "${result.content_title || "document"}". Comment: "${feedback_text.substring(0, 200)}${feedback_text.length > 200 ? "..." : ""}"`,
            customer_id: customer?.id || result.customer_id,
            metadata: {
              google_doc_id: result.google_doc_id,
              comment_id: comment.id,
              content_revision_id: result.doc_id,
              tags: ["google_docs", "client_feedback", "content_revision", "automated"]
            },
            timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      });
    }
    const totalNewComments = results.reduce((sum, r) => sum + (r.comment_count || 0), 0);
    return {
      success: true,
      docs_checked: activeDocs.length,
      docs_with_new_comments: results.filter((r) => !r.error && r.new_comments?.length > 0).length,
      new_comments: totalNewComments,
      errors: results.filter((r) => r.error).length
    };
  }
);
const checkSingleDocComments = inngest.createFunction(
  {
    id: "check-single-doc-comments",
    name: "Check Single Google Doc for Comments"
  },
  { event: "google-docs/check-comments" },
  async ({ event, step }) => {
    const { google_doc_id, content_revision_id } = event.data;
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
    const drive = google.drive({ version: "v3", auth });
    const response = await step.run("list-comments", async () => {
      return await drive.comments.list({
        fileId: google_doc_id,
        fields: "comments(id,content,htmlContent,createdTime,modifiedTime,resolved,author,anchor)",
        includeDeleted: false,
        pageSize: 100
      });
    });
    const comments = response.data.comments || [];
    const unresolvedComments = comments.filter((c) => !c.resolved);
    return {
      success: true,
      google_doc_id,
      total_comments: comments.length,
      unresolved_comments: unresolvedComments.length,
      comments: unresolvedComments
    };
  }
);
export {
  checkSingleDocComments,
  googleDocsCommentPoller
};
