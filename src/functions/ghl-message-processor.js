import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
import { routeModel } from "../model-router.js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ghlInboundMessageProcessor = inngest.createFunction(
  {
    id: "ghl-inbound-message-processor",
    name: "GHL Intelligence: Inbound Message Buffer",
    retries: 2,
    concurrency: { limit: 5 }
  },
  { event: "ghl/message.inbound" },
  async ({ event, step }) => {
    const {
      contactId,
      conversationId,
      locationId,
      type: messageType,
      body: bodyField,
      message_body,
      message_subject,
      direction,
      dateAdded
    } = event.data;
    const body = bodyField || message_body || message_subject || "";
    const customerId = await step.run("lookup-customer", async () => {
      const { data } = await supabase.from("customer").select("id").eq("ghl_contact_id", contactId).limit(1).single();
      return data?.id || null;
    });
    const intakeResult = await step.run("buffer-to-intake", async () => {
      if (!body || body.trim().length === 0)
        return { skipped: true, reason: "Empty message body" };
      const { data, error } = await supabase.from("communication_intake").insert({
        source_channel: messageType || "sms",
        source_system: "ghl",
        customer_id: customerId,
        contact_identifier: contactId,
        direction: direction || "inbound",
        raw_content: body,
        key_entities: {
          conversation_id: conversationId,
          date_added: dateAdded,
          source: "ghl-webhook"
        },
        processed: false,
        received_at: dateAdded || new Date().toISOString()
      }).select("id").single();
      if (error) {
        console.warn("communication_intake buffer warning:", error.message);
        return { skipped: true, error: error.message };
      }
      return { buffered: true, id: data?.id };
    });

    // Fire task-router event immediately after successful intake write
    if (intakeResult?.id) {
      await step.run("fire-task-router", async () => {
        await inngest.send({
          name: "communication/intake.received",
          data: { intake_id: intakeResult.id },
        });
      });
    }
    return {
      success: true,
      contactId,
      conversationId,
      messageType,
      customerId
    };
  }
);
const ghlCommunicationExtraction = inngest.createFunction(
  {
    id: "ghl-communication-extraction",
    name: "GHL Intelligence: Nightly Communication Extraction",
    retries: 1,
    concurrency: { limit: 1 }
  },
  { cron: "0 8 * * *" },
  // 3am EST = 8am UTC
  async ({ step }) => {
    const unprocessed = await step.run("get-unprocessed-messages", async () => {
      const { data, error } = await supabase.from("communication_intake").select("id, customer_id, ghl_contact_id, communication_type, direction, content, metadata, received_at").eq("processed", false).neq("content", null).order("received_at", { ascending: true }).limit(100);
      if (error)
        throw new Error(`Failed to fetch unprocessed messages: ${error.message}`);
      return data || [];
    });
    if (unprocessed.length === 0) {
      return { success: true, processed: 0, message: "No unprocessed messages" };
    }
    const grouped = await step.run("group-by-customer", async () => {
      const groups = {};
      for (const msg of unprocessed) {
        const key = msg.customer_id || msg.ghl_contact_id || "unknown";
        if (!groups[key])
          groups[key] = [];
        groups[key].push(msg);
      }
      return groups;
    });
    const extractionResults = await step.run("extract-intelligence", async () => {
      const results = [];
      for (const [customerId, messages] of Object.entries(grouped)) {
        const messageContext = messages.map((m) => `[${m.direction?.toUpperCase() || "MSG"} - ${m.communication_type}]: ${m.content?.substring(0, 500)}`).join("\n\n");
        try {
          const routeResult = await routeModel({
            task: "simple extraction",
            prompt: `Analyze these business communications from a single client. Extract intelligence signals.\n\nCommunications:\n${messageContext}\n\nReturn ONLY valid JSON array, one object per message in the EXACT order given:\n[\n  {\n    "sentiment": "positive|neutral|negative|mixed",\n    "intent_tags": ["array", "of", "intent", "tags"],\n    "key_phrases": ["important", "phrases"],\n    "satisfaction_signal": 1-5,\n    "action_items": ["follow-up", "items"]\n  }\n]\n\nSentiment: positive=happy/interested, negative=frustrated/unhappy, neutral=transactional, mixed=both.\nIntent tags: from [purchase_intent, complaint, question, feedback, scheduling, payment, project_update, approval, revision_request, general_inquiry]\nSatisfaction: 1=very unhappy, 3=neutral, 5=very happy. null if unclear.`,
            caller: "ghl-communication-extraction",
            maxTokens: 1024,
          });
          const content = routeResult.text || "[]";
          let extractions = [];
          try {
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch)
              extractions = JSON.parse(jsonMatch[0]);
          } catch {
            extractions = [];
          }
          for (let i = 0; i < messages.length; i++) {
            const extraction = extractions[i] || {};
            results.push({
              id: messages[i].id,
              updates: {
                processed: true,
                processed_at: new Date().toISOString(),
                sentiment: extraction.sentiment || "neutral",
                intent_tags: extraction.intent_tags || [],
                satisfaction_signal: extraction.satisfaction_signal || null,
                key_phrases: extraction.key_phrases || [],
                action_items: extraction.action_items || []
              }
            });
          }
        } catch (err) {
          for (const msg of messages) {
            results.push({ id: msg.id, updates: { processed: true, processed_at: new Date().toISOString(), sentiment: "unknown", intent_tags: ["extraction_failed"] } });
          }
        }
      }
      return results;
    });
    const writeResult = await step.run("write-extractions", async () => {
      let successCount = 0;
      let errorCount = 0;
      for (const { id, updates } of extractionResults) {
        const { error } = await supabase.from("communication_intake").update(updates).eq("id", id);
        if (error) {
          console.error(`Failed to update message ${id}:`, error.message);
          errorCount++;
        } else {
          successCount++;
        }
      }
      return { successCount, errorCount };
    });
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "measurement",
        source_system: "ghl",
        actor: "ghl-communication-extraction",
        content: `Nightly communication extraction complete. Processed ${writeResult.successCount}/${unprocessed.length} messages via model router. Customers analyzed: ${Object.keys(grouped).length}. Errors: ${writeResult.errorCount}.`,
        metadata: {
          messages_processed: writeResult.successCount,
          messages_total: unprocessed.length,
          customers_analyzed: Object.keys(grouped).length,
          routing: "model-router",
          errors: writeResult.errorCount
        },
        timestamp_event: new Date().toISOString()
      });
    });
    return {
      success: true,
      messagesProcessed: writeResult.successCount,
      customersAnalyzed: Object.keys(grouped).length,
      errors: writeResult.errorCount
    };
  }
);
export {
  ghlCommunicationExtraction,
  ghlInboundMessageProcessor
};
