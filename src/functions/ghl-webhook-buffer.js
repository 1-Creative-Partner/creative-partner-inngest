import { inngest } from "../inngest-client.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * GHL Webhook Buffer
 *
 * Receives cp/ghl.webhook.received events from crm-bridge Worker.
 * Writes to webhook_event_buffer, deduplicates within 5-min window,
 * then fans out to specific domain events.
 *
 * Concurrency: 5 (free plan max)
 */
export const ghlWebhookBuffer = inngest.createFunction(
  {
    id: "ghl-webhook-buffer",
    name: "GHL Webhook Buffer",
    concurrency: { limit: 5 },
    retries: 2,
  },
  { event: "cp/ghl.webhook.received" },
  async ({ event, step }) => {
    const payload = event.data || {};
    const meta = payload._meta || {};
    const eventType = meta.eventType || payload.type || "unknown";
    const contactId = payload.contactId || payload.contact_id || payload.id || null;
    const opportunityId = payload.opportunityId || payload.opportunity_id || null;
    const locationId = meta.locationId || payload.locationId || null;

    // Step 1: Write to webhook_event_buffer
    const bufferId = await step.run("write-to-buffer", async () => {
      const body = {
        event_type: eventType,
        location_id: locationId || "",
        contact_id: contactId || "",
        raw_payload: payload,
        received_at: new Date().toISOString(),
        processed: false,
        status: "buffered",
        source: "crm-bridge-worker",
      };

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/webhook_event_buffer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: "return=representation",
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Buffer write failed: ${res.status} ${err}`);
      }

      const [record] = await res.json();
      return record.id;
    });

    // Step 2: Deduplicate — check for same event_type + entity within 5-min window
    const isDuplicate = await step.run("check-dedup", async () => {
      const entityId = contactId || opportunityId || "";
      if (!entityId) return false; // Can't dedup without entity ID

      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/webhook_event_buffer?event_type=eq.${encodeURIComponent(eventType)}&contact_id=eq.${encodeURIComponent(entityId)}&received_at=gte.${fiveMinAgo}&id=neq.${bufferId}&select=id&limit=1`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        }
      );

      const dupes = await res.json();
      return Array.isArray(dupes) && dupes.length > 0;
    });

    if (isDuplicate) {
      // Mark as processed (deduplicated) and stop
      await step.run("mark-deduped", async () => {
        await fetch(
          `${SUPABASE_URL}/rest/v1/webhook_event_buffer?id=eq.${bufferId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({
              processed: true,
              processed_at: new Date().toISOString(),
              status: "deduplicated",
            }),
          }
        );
      });

      return { status: "deduplicated", bufferId, eventType };
    }

    // Step 3: Fan out — fire domain-specific events
    const fanoutMap = {
      ContactCreate: "cp/ghl.contact.created",
      ContactUpdate: "cp/ghl.contact.updated",
      ContactDelete: "cp/ghl.contact.deleted",
      ContactTagUpdate: "cp/ghl.contact.tags.updated",
      OpportunityCreate: "cp/ghl.opportunity.created",
      OpportunityUpdate: "cp/ghl.opportunity.updated",
      OpportunityStageUpdate: "cp/ghl.opportunity.stage.updated",
      AppointmentCreate: "cp/ghl.appointment.created",
      AppointmentUpdate: "cp/ghl.appointment.updated",
      InboundMessage: "cp/ghl.message.inbound",
      OutboundMessage: "cp/ghl.message.outbound",
      ConversationUnreadUpdate: "cp/ghl.conversation.updated",
      NoteCreate: "cp/ghl.note.created",
      TaskCreate: "cp/ghl.task.created",
      TaskComplete: "cp/ghl.task.completed",
      TranscriptProcessed: "cp/ghl.transcript.processed",
      FormSubmitted: "cp/ghl.form.submitted",
    };

    const fanoutEvent = fanoutMap[eventType] || `cp/ghl.${eventType.toLowerCase()}`;

    await step.run("fanout-event", async () => {
      await inngest.send({
        name: fanoutEvent,
        data: {
          ...payload,
          _buffer: {
            bufferId,
            eventType,
            contactId,
            opportunityId,
            locationId,
            bufferedAt: new Date().toISOString(),
          },
        },
      });
    });

    // Step 4: Mark buffer record as processed
    await step.run("mark-processed", async () => {
      await fetch(
        `${SUPABASE_URL}/rest/v1/webhook_event_buffer?id=eq.${bufferId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            processed: true,
            processed_at: new Date().toISOString(),
            status: "processed",
            inngest_event_id: event.id || null,
          }),
        }
      );
    });

    return {
      status: "processed",
      bufferId,
      eventType,
      fanoutEvent,
      contactId,
      opportunityId,
    };
  }
);
