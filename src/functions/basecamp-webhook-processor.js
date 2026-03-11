import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const basecampTodoCreated = inngest.createFunction(
  { id: "basecamp-todo-created", name: "Basecamp: Todo Created" },
  { event: "basecamp/todo.created" },
  async ({ event, step }) => {
    const { recording, creator, bucket } = event.data;
    await step.run("log-cia-episode", async () => {
      const todoTitle = recording?.title || recording?.content || "Untitled";
      const projectName = bucket?.name || bucket?.title || "unknown project";
      const actorName = creator?.name || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "basecamp",
        actor: actorName,
        content: `New Basecamp todo created: "${todoTitle}" in ${projectName}. Created by: ${actorName}.`,
        metadata: {
          todo_id: recording?.id,
          todo_title: todoTitle,
          project_id: bucket?.id,
          project_name: projectName,
          creator_name: actorName,
          creator_email: creator?.email_address,
          due_on: recording?.due_on,
          url: recording?.app_url,
          event: "basecamp/todo.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, todoId: event.data.recording?.id, event: "basecamp/todo.created" };
  }
);
const basecampTodoCompleted = inngest.createFunction(
  { id: "basecamp-todo-completed", name: "Basecamp: Todo Completed" },
  { event: "basecamp/todo.completed" },
  async ({ event, step }) => {
    const { recording, creator, bucket } = event.data;
    await step.run("log-cia-episode", async () => {
      const todoTitle = recording?.title || recording?.content || "Untitled";
      const projectName = bucket?.name || bucket?.title || "unknown project";
      const completedBy = creator?.name || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "basecamp",
        actor: completedBy,
        content: `Basecamp todo completed: "${todoTitle}" in ${projectName}. Completed by: ${completedBy}.`,
        metadata: {
          todo_id: recording?.id,
          todo_title: todoTitle,
          project_id: bucket?.id,
          project_name: projectName,
          completed_by: completedBy,
          url: recording?.app_url,
          event: "basecamp/todo.completed"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, todoId: event.data.recording?.id, event: "basecamp/todo.completed" };
  }
);
const basecampCommentCreated = inngest.createFunction(
  { id: "basecamp-comment-created", name: "Basecamp: Comment Created" },
  { event: "basecamp/comment.created" },
  async ({ event, step }) => {
    const { recording, creator, bucket, parent } = event.data;
    await step.run("log-cia-episode", async () => {
      const commentText = recording?.content || "[no content]";
      const preview = commentText.replace(/<[^>]*>/g, "").substring(0, 200);
      const projectName = bucket?.name || bucket?.title || "unknown project";
      const parentTitle = parent?.title || parent?.content || "unknown item";
      const authorName = creator?.name || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "basecamp",
        actor: authorName,
        content: `Basecamp comment added by ${authorName} on "${parentTitle}" in ${projectName}. Preview: "${preview.substring(0, 150)}${preview.length > 150 ? "..." : ""}"`,
        metadata: {
          comment_id: recording?.id,
          parent_id: parent?.id,
          parent_title: parentTitle,
          parent_type: parent?.type,
          project_id: bucket?.id,
          project_name: projectName,
          author: authorName,
          url: recording?.app_url,
          event: "basecamp/comment.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, commentId: event.data.recording?.id, event: "basecamp/comment.created" };
  }
);
const basecampMessageCreated = inngest.createFunction(
  { id: "basecamp-message-created", name: "Basecamp: Message Posted" },
  { event: "basecamp/message.created" },
  async ({ event, step }) => {
    const { recording, creator, bucket } = event.data;
    await step.run("log-cia-episode", async () => {
      const subject = recording?.subject || recording?.title || "Untitled message";
      const projectName = bucket?.name || bucket?.title || "unknown project";
      const authorName = creator?.name || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "basecamp",
        actor: authorName,
        content: `New Basecamp message: "${subject}" posted in ${projectName} by ${authorName}.`,
        metadata: {
          message_id: recording?.id,
          subject,
          project_id: bucket?.id,
          project_name: projectName,
          author: authorName,
          url: recording?.app_url,
          event: "basecamp/message.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, messageId: event.data.recording?.id, event: "basecamp/message.created" };
  }
);
const basecampTodoUncompleted = inngest.createFunction(
  { id: "basecamp-todo-uncompleted", name: "Basecamp: Todo Reopened" },
  { event: "basecamp/todo.uncompleted" },
  async ({ event, step }) => {
    const { recording, creator, bucket } = event.data;
    await step.run("log-cia-episode", async () => {
      const todoTitle = recording?.title || recording?.content || "Untitled";
      const projectName = bucket?.name || bucket?.title || "unknown project";
      const actorName = creator?.name || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "basecamp",
        actor: actorName,
        content: `Basecamp todo reopened: "${todoTitle}" in ${projectName}. Reopened by: ${actorName}.`,
        metadata: {
          todo_id: recording?.id,
          todo_title: todoTitle,
          project_id: bucket?.id,
          project_name: projectName,
          actor: actorName,
          event: "basecamp/todo.uncompleted"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, todoId: event.data.recording?.id, event: "basecamp/todo.uncompleted" };
  }
);
const basecampDocumentCreated = inngest.createFunction(
  { id: "basecamp-document-created", name: "Basecamp: Document Created" },
  { event: "basecamp/document.created" },
  async ({ event, step }) => {
    const { recording, creator, bucket } = event.data;
    await step.run("log-cia-episode", async () => {
      const docTitle = recording?.title || "Untitled document";
      const projectName = bucket?.name || bucket?.title || "unknown project";
      const authorName = creator?.name || "unknown";
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "basecamp",
        actor: authorName,
        content: `New Basecamp document created: "${docTitle}" in ${projectName} by ${authorName}.`,
        metadata: {
          document_id: recording?.id,
          document_title: docTitle,
          project_id: bucket?.id,
          project_name: projectName,
          author: authorName,
          url: recording?.app_url,
          event: "basecamp/document.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, documentId: event.data.recording?.id, event: "basecamp/document.created" };
  }
);
export {
  basecampCommentCreated,
  basecampDocumentCreated,
  basecampMessageCreated,
  basecampTodoCompleted,
  basecampTodoCreated,
  basecampTodoUncompleted
};
