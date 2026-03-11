import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const CP_LOCATION_ID = "VpL3sVe4Vb1ANBx9DOL6";
const ghlContactCreated = inngest.createFunction(
  { id: "ghl-contact-created", name: "GHL: New Contact Created" },
  { event: "ghl/contact.created" },
  async ({ event, step }) => {
    const { firstName, lastName, email, phone, locationId, id: contactId, tags } = event.data;
    await step.run("log-cia-episode", async () => {
      const name = [firstName, lastName].filter(Boolean).join(" ") || email || contactId;
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "ghl",
        actor: "ghl-webhook",
        content: `New GHL contact created: ${name}${email ? ` (${email})` : ""}. Location: ${locationId || "unknown"}.`,
        metadata: {
          contact_id: contactId,
          email,
          phone,
          location_id: locationId,
          tags,
          event: "ghl/contact.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    if (locationId === CP_LOCATION_ID) {
      await step.run("sync-to-customer", async () => {
        const { error } = await supabase.from("customer").upsert({
          ghl_contact_id: contactId,
          company_name: [firstName, lastName].filter(Boolean).join(" ") || email || "Unknown",
          email,
          phone,
          tenant_id: "creative-partner",
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }, { onConflict: "ghl_contact_id", ignoreDuplicates: false });
        if (error) {
          console.warn("Customer upsert warning:", error.message);
        }
      });
    }
    return { success: true, contactId, event: "ghl/contact.created" };
  }
);
const ghlOpportunityCreated = inngest.createFunction(
  { id: "ghl-opportunity-created", name: "GHL: Opportunity Created" },
  { event: "ghl/opportunity.created" },
  async ({ event, step }) => {
    const {
      id: opportunityId,
      name: oppName,
      monetaryValue,
      status,
      pipelineId,
      pipelineStageId,
      contactId,
      locationId,
      assignedTo
    } = event.data;
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "ghl",
        actor: assignedTo || "ghl-webhook",
        content: `New GHL opportunity created: "${oppName}"${monetaryValue ? ` \u2014 $${monetaryValue}` : ""}. Status: ${status || "open"}.`,
        metadata: {
          opportunity_id: opportunityId,
          opportunity_name: oppName,
          monetary_value: monetaryValue,
          status,
          pipeline_id: pipelineId,
          stage_id: pipelineStageId,
          contact_id: contactId,
          location_id: locationId,
          event: "ghl/opportunity.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, opportunityId, event: "ghl/opportunity.created" };
  }
);
const ghlOpportunityStageUpdated = inngest.createFunction(
  { id: "ghl-opportunity-stage-updated", name: "GHL: Opportunity Stage Changed" },
  { event: "ghl/opportunity.stage.updated" },
  async ({ event, step }) => {
    const { id: opportunityId, name: oppName, pipelineStageId, status, contactId } = event.data;
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "ghl",
        actor: "ghl-webhook",
        content: `GHL opportunity stage updated: "${oppName || opportunityId}" moved to stage ${pipelineStageId}. Status: ${status || "open"}.`,
        metadata: {
          opportunity_id: opportunityId,
          opportunity_name: oppName,
          new_stage_id: pipelineStageId,
          status,
          contact_id: contactId,
          event: "ghl/opportunity.stage.updated"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, opportunityId, newStage: pipelineStageId };
  }
);
const ghlMessageInbound = inngest.createFunction(
  { id: "ghl-message-inbound", name: "GHL: Inbound Message Received" },
  { event: "ghl/message.inbound" },
  async ({ event, step }) => {
    const {
      conversationId,
      contactId,
      type: messageType,
      body,
      locationId,
      direction
    } = event.data;
    await step.run("log-cia-episode", async () => {
      const preview = body ? body.substring(0, 150) + (body.length > 150 ? "..." : "") : "[no body]";
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "ghl",
        actor: "client",
        content: `Inbound ${messageType || "message"} received. Contact: ${contactId}. Preview: "${preview}"`,
        metadata: {
          conversation_id: conversationId,
          contact_id: contactId,
          message_type: messageType,
          direction,
          location_id: locationId,
          event: "ghl/message.inbound"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, conversationId, event: "ghl/message.inbound" };
  }
);
const ghlContactTagsUpdated = inngest.createFunction(
  { id: "ghl-contact-tags-updated", name: "GHL: Contact Tags Updated" },
  { event: "ghl/contact.tags.updated" },
  async ({ event, step }) => {
    const { id: contactId, tags, locationId } = event.data;
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "ghl",
        actor: "ghl-webhook",
        content: `GHL contact tags updated. Contact: ${contactId}. Tags: ${Array.isArray(tags) ? tags.join(", ") : tags || "none"}.`,
        metadata: {
          contact_id: contactId,
          tags,
          location_id: locationId,
          event: "ghl/contact.tags.updated"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, contactId, tags };
  }
);
const ghlAppointmentCreated = inngest.createFunction(
  { id: "ghl-appointment-created", name: "GHL: Appointment Created" },
  { event: "ghl/appointment.created" },
  async ({ event, step }) => {
    const {
      id: appointmentId,
      title,
      startTime,
      endTime,
      contactId,
      calendarId,
      locationId,
      assignedUserId
    } = event.data;
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "ghl",
        actor: assignedUserId || "ghl-webhook",
        content: `New GHL appointment: "${title || appointmentId}". Scheduled: ${startTime || "TBD"}. Contact: ${contactId || "unknown"}.`,
        metadata: {
          appointment_id: appointmentId,
          title,
          start_time: startTime,
          end_time: endTime,
          contact_id: contactId,
          calendar_id: calendarId,
          location_id: locationId,
          event: "ghl/appointment.created"
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return { success: true, appointmentId, event: "ghl/appointment.created" };
  }
);
export {
  ghlAppointmentCreated,
  ghlContactCreated,
  ghlContactTagsUpdated,
  ghlMessageInbound,
  ghlOpportunityCreated,
  ghlOpportunityStageUpdated
};
