import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const clickupTaskCreated = inngest.createFunction(
  { id: "clickup-task-created", name: "ClickUp: Task Created" },
  { event: "clickup/task.created" },
  async ({ event, step }) => {
    const { task_id, webhook_id, history_items } = event.data;
    const historyItem = history_items?.[0];
    await step.run("log-cia-episode", async () => {
      const taskName = historyItem?.data?.name || task_id;
      const assignees = historyItem?.data?.assignees?.map((a) => a.username).join(", ") || "unassigned";
      const listName = historyItem?.parent_id || "unknown list";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "clickup",
        actor: historyItem?.user?.username || "clickup-webhook",
        content: `New ClickUp task created: "${taskName}". Assigned to: ${assignees}.`,
        metadata: {
          task_id,
          task_name: taskName,
          webhook_id,
          list_id: listName,
          status: historyItem?.data?.status?.status,
          priority: historyItem?.data?.priority?.priority,
          due_date: historyItem?.data?.due_date,
          event: "clickup/task.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, taskId: task_id, event: "clickup/task.created" };
  }
);
const clickupTaskStatusUpdated = inngest.createFunction(
  { id: "clickup-task-status-updated", name: "ClickUp: Task Status Changed" },
  { event: "clickup/task.status.updated" },
  async ({ event, step }) => {
    const { task_id, history_items } = event.data;
    const historyItem = history_items?.[0];
    await step.run("log-cia-episode", async () => {
      const before = historyItem?.before?.status || "unknown";
      const after = historyItem?.after?.status || "unknown";
      const actorName = historyItem?.user?.username || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "clickup",
        actor: actorName,
        content: `ClickUp task ${task_id} status changed: "${before}" \u2192 "${after}" by ${actorName}.`,
        metadata: {
          task_id,
          status_before: before,
          status_after: after,
          actor: actorName,
          event: "clickup/task.status.updated"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, taskId: task_id, statusChange: { before: history_items?.[0]?.before?.status, after: history_items?.[0]?.after?.status } };
  }
);
const clickupTaskCommentPosted = inngest.createFunction(
  { id: "clickup-task-comment-posted", name: "ClickUp: Comment Posted on Task" },
  { event: "clickup/task.comment.posted" },
  async ({ event, step }) => {
    const { task_id, history_items } = event.data;
    const historyItem = history_items?.[0];
    await step.run("log-cia-episode", async () => {
      const commentText = historyItem?.comment?.text_content || historyItem?.after?.text || "[no text]";
      const preview = commentText.substring(0, 200) + (commentText.length > 200 ? "..." : "");
      const actorName = historyItem?.user?.username || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "clickup",
        actor: actorName,
        content: `ClickUp comment posted on task ${task_id} by ${actorName}: "${preview}"`,
        metadata: {
          task_id,
          comment_id: historyItem?.id,
          actor: actorName,
          preview: preview.substring(0, 500),
          event: "clickup/task.comment.posted"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, taskId: task_id, event: "clickup/task.comment.posted" };
  }
);
const clickupTaskUpdated = inngest.createFunction(
  { id: "clickup-task-updated", name: "ClickUp: Task Updated" },
  { event: "clickup/task.updated" },
  async ({ event, step }) => {
    const { task_id, history_items } = event.data;
    const historyItem = history_items?.[0];
    await step.run("log-cia-episode", async () => {
      const field = historyItem?.field || "unknown field";
      const before = JSON.stringify(historyItem?.before || {});
      const after = JSON.stringify(historyItem?.after || {});
      const actorName = historyItem?.user?.username || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "clickup",
        actor: actorName,
        content: `ClickUp task ${task_id} updated field "${field}" by ${actorName}.`,
        metadata: {
          task_id,
          field_changed: field,
          before,
          after,
          actor: actorName,
          event: "clickup/task.updated"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, taskId: task_id, fieldChanged: historyItem?.field };
  }
);
const clickupTaskAssigneeUpdated = inngest.createFunction(
  { id: "clickup-task-assignee-updated", name: "ClickUp: Task Assigned/Unassigned" },
  { event: "clickup/task.assignee.updated" },
  async ({ event, step }) => {
    const { task_id, history_items } = event.data;
    const historyItem = history_items?.[0];
    await step.run("log-cia-episode", async () => {
      const added = historyItem?.after?.map((u) => u.username).join(", ") || "none";
      const removed = historyItem?.before?.map((u) => u.username).join(", ") || "none";
      const actorName = historyItem?.user?.username || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "clickup",
        actor: actorName,
        content: `ClickUp task ${task_id} assignees changed by ${actorName}. Added: ${added}. Removed: ${removed}.`,
        metadata: {
          task_id,
          added,
          removed,
          actor: actorName,
          event: "clickup/task.assignee.updated"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, taskId: task_id, event: "clickup/task.assignee.updated" };
  }
);
const clickupTaskDeleted = inngest.createFunction(
  { id: "clickup-task-deleted", name: "ClickUp: Task Deleted" },
  { event: "clickup/task.deleted" },
  async ({ event, step }) => {
    const { task_id, history_items } = event.data;
    const historyItem = history_items?.[0];
    await step.run("log-cia-episode", async () => {
      const actorName = historyItem?.user?.username || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "clickup",
        actor: actorName,
        content: `ClickUp task deleted: ${task_id} by ${actorName}.`,
        metadata: {
          task_id,
          actor: actorName,
          event: "clickup/task.deleted"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, taskId: task_id, event: "clickup/task.deleted" };
  }
);
export {
  clickupTaskAssigneeUpdated,
  clickupTaskCommentPosted,
  clickupTaskCreated,
  clickupTaskDeleted,
  clickupTaskStatusUpdated,
  clickupTaskUpdated
};
