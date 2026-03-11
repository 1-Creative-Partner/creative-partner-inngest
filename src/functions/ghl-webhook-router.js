import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const GHL_TYPE_MAP = {
  // Phase 0 — Transcript Intelligence
  "TranscriptProcessed": "ghl/transcript.processed",
  "transcript_processed": "ghl/transcript.processed",
  "CallTranscript": "ghl/transcript.processed",
  "call_transcript": "ghl/transcript.processed",
  // Phase 0.5 — Inbound Message Intelligence
  "InboundMessage": "ghl/message.inbound",
  "CustomerReplied": "ghl/message.inbound",
  "MessageAdded": "ghl/message.inbound",
  "inbound_message": "ghl/message.inbound",
  "message_inbound": "ghl/message.inbound",
  "SMSReceived": "ghl/message.inbound",
  "EmailReceived": "ghl/message.inbound",
  // Phase 1 — Form Submission Intelligence
  "FormSubmitted": "ghl/form.submitted",
  "form_submitted": "ghl/form.submitted",
  "FormSubmission": "ghl/form.submitted",
  "OptiInFormA2P": "ghl/form.submitted",
  // Standard GHL webhook types (also handled by ghl-webhook-processor)
  "ContactCreated": "ghl/contact.created",
  "contact_created": "ghl/contact.created",
  "OpportunityCreated": "ghl/opportunity.created",
  "opportunity_created": "ghl/opportunity.created",
  "OpportunityStatusChanged": "ghl/opportunity.stage.updated",
  "OpportunityStageChanged": "ghl/opportunity.stage.updated",
  "ContactTagAdded": "ghl/contact.tags.updated",
  "ContactTagRemoved": "ghl/contact.tags.updated",
  "AppointmentCreated": "ghl/appointment.created",
  "AppointmentBooked": "ghl/appointment.created"
};
function detectEventFromContent(payload) {
  if (payload.call_transcript || payload.transcript || payload.recording_url) {
    return "ghl/transcript.processed";
  }
  if (payload.form_id || payload.form_name || payload.form_data || payload.formId) {
    return "ghl/form.submitted";
  }
  if (payload.body && payload.direction || payload.message_type || payload.messageType || payload.conversation_id) {
    return "ghl/message.inbound";
  }
  if (payload.first_name && payload.email && !payload.stage_id) {
    return "ghl/contact.created";
  }
  return null;
}
async function markBufferProcessed(bufferId, routedTo) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/webhook_event_buffer?id=eq.${bufferId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        processed: true,
        status: "processed",
        updated_at: (/* @__PURE__ */ new Date()).toISOString(),
        notes: `Routed to ${routedTo}`
      })
    });
  } catch (e) {
    console.error("Failed to mark buffer processed:", e);
  }
}
const ghlWebhookRouter = inngest.createFunction(
  {
    id: "ghl-webhook-router",
    name: "GHL Webhook Router: cp/ghl.webhook.received \u2192 specific events",
    retries: 2,
    concurrency: { limit: 20 }
  },
  { event: "cp/ghl.webhook.received" },
  async ({ event, step }) => {
    const {
      buffer_id,
      event_type,
      // what webhook-receiver detected as eventType
      payload
      // the original GHL webhook body
    } = event.data;
    if (!payload || typeof payload !== "object") {
      return { skipped: true, reason: "No payload in event data" };
    }
    const routing = await step.run("determine-route", async () => {
      const typeField = payload.type || payload.event_type || event_type || "";
      const fromTypeMap = typeField ? GHL_TYPE_MAP[typeField] : null;
      if (fromTypeMap) {
        return { targetEvent: fromTypeMap, method: "type_map", typeValue: typeField };
      }
      const fromContent = detectEventFromContent(payload);
      if (fromContent) {
        return { targetEvent: fromContent, method: "content_detection", typeValue: typeField };
      }
      return { targetEvent: null, method: "unmatched", typeValue: typeField };
    });
    if (!routing.targetEvent) {
      await step.run("log-unrouted", async () => {
        await supabase.from("cia_episode").insert({
          episode_type: "observation",
          source_system: "ghl",
          actor: "ghl-webhook-router",
          content: `Unrouted GHL webhook. type='${routing.typeValue}'. payload keys: ${Object.keys(payload).join(", ")}. buffer_id: ${buffer_id}.`,
          metadata: {
            buffer_id,
            event_type: routing.typeValue,
            payload_keys: Object.keys(payload),
            detection_method: routing.method
          },
          timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
        });
        if (buffer_id) {
          await markBufferProcessed(buffer_id, "unrouted");
        }
      });
      return {
        routed: false,
        reason: "No matching event type",
        typeValue: routing.typeValue,
        payloadKeys: Object.keys(payload)
      };
    }
    await step.run("fire-specific-event", async () => {
      const specificEventData = {
        ...payload,
        _buffer_id: buffer_id,
        _routed_from: "cp/ghl.webhook.received",
        _routing_method: routing.method
      };
      const { data: credData } = await supabase.from("api_credential").select("credential_value").eq("service", "inngest").eq("credential_key", "INNGEST_EVENT_KEY").eq("is_active", true).single();
      const eventKey = credData?.credential_value;
      if (!eventKey)
        throw new Error("No Inngest event key in api_credential");
      const res = await fetch(`https://inn.gs/e/${eventKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: routing.targetEvent,
          data: specificEventData
        })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Inngest send failed: ${res.status} ${err}`);
      }
      const r = await res.json();
      return { inngestEventId: r?.ids?.[0], targetEvent: routing.targetEvent };
    });
    if (buffer_id) {
      await step.run("mark-buffer-processed", async () => {
        await markBufferProcessed(buffer_id, routing.targetEvent);
      });
    }
    return {
      routed: true,
      targetEvent: routing.targetEvent,
      method: routing.method,
      typeValue: routing.typeValue,
      bufferId: buffer_id
    };
  }
);
export {
  ghlWebhookRouter
};
