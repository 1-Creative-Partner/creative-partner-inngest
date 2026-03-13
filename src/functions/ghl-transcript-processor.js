import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
async function getGHLPIT(locationId) {
  const { data } = await supabase.from("api_credential").select("credential_value, id").not("credential_value", "is", null);
  if (!data)
    throw new Error("No api_credential records found");
  for (const cred of data) {
    try {
      const parsed = JSON.parse(cred.credential_value);
      if (parsed.location_id === locationId && parsed.token?.startsWith("pit-")) {
        return parsed.token;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`No PIT token found for location: ${locationId}`);
}
const ghlTranscriptProcessor = inngest.createFunction(
  {
    id: "ghl-transcript-processor",
    name: "GHL Intelligence: Transcript Processor",
    retries: 2,
    concurrency: { limit: 5 }
  },
  { event: "ghl/transcript.processed" },
  async ({ event, step }) => {
    const {
      contactId,
      locationId,
      call_transcript,
      gpt_extraction,
      // JSON string from GHL's GPT-4o Mini action
      call_duration,
      call_direction,
      call_type,
      phone_number,
      _meta
    } = event.data;
    const intelligence = await step.run("parse-gpt-extraction", async () => {
      let parsed = {};
      if (gpt_extraction) {
        try {
          const cleanJson = typeof gpt_extraction === "string" ? gpt_extraction.replace(/```json?/g, "").replace(/```/g, "").trim() : gpt_extraction;
          parsed = typeof cleanJson === "string" ? JSON.parse(cleanJson) : cleanJson;
        } catch {
          parsed = { parse_error: true, raw: gpt_extraction?.substring?.(0, 200) };
        }
      }
      return {
        contact_id: contactId,
        location_id: locationId,
        // Standard 7-layer Phase 0 extraction fields
        client_name: parsed.client_name || parsed.name || null,
        company_name: parsed.company_name || parsed.business_name || null,
        intent: parsed.intent || parsed.call_intent || null,
        pain_points: parsed.pain_points || parsed.challenges || [],
        services_mentioned: parsed.services_mentioned || parsed.services || [],
        budget_signals: parsed.budget_signals || parsed.budget || null,
        timeline_signals: parsed.timeline_signals || parsed.timeline || null,
        decision_maker: parsed.decision_maker ?? parsed.is_decision_maker ?? null,
        next_steps: parsed.next_steps || parsed.follow_up || [],
        sentiment: parsed.sentiment || "neutral",
        tags: parsed.tags || [],
        summary: parsed.summary || parsed.call_summary || null,
        raw_extraction: parsed
      };
    });
    const customer = await step.run("lookup-customer", async () => {
      const { data } = await supabase.from("customer").select("id, company_name, tenant_id, ghl_contact_id").eq("ghl_contact_id", contactId).limit(1).single();
      if (data)
        return data;
      try {
        const pit = await getGHLPIT(locationId);
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          headers: {
            "Authorization": `Bearer ${pit}`,
            "Version": "2021-07-28"
          }
        });
        if (res.ok) {
          const ghlContact = await res.json();
          const contact = ghlContact.contact || ghlContact;
          return {
            id: null,
            company_name: contact.companyName || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unknown",
            tenant_id: "creative-partner",
            ghl_contact_id: contactId
          };
        }
      } catch {
      }
      return { id: null, company_name: intelligence.company_name || "Unknown", tenant_id: "creative-partner", ghl_contact_id: contactId };
    });
    const intakeRecord = await step.run("write-communication-intake", async () => {
      const { data, error } = await supabase.from("communication_intake").insert({
        source_channel: "call",
        source_system: "ghl",
        customer_id: customer.id,
        contact_identifier: contactId,
        contact_name: intelligence.client_name || customer.company_name || "Unknown",
        direction: call_direction || "unknown",
        raw_content: call_transcript || "[transcript not available]",
        key_entities: {
          call_duration,
          call_type,
          phone_number,
          gpt_extraction: intelligence.raw_extraction,
          source: "ghl-phase0-workflow"
        },
        sentiment: intelligence.sentiment,
        intent_tags: intelligence.tags,
        processed: true,
        processed_at: new Date().toISOString(),
        received_at: new Date().toISOString()
      }).select("id").single();
      if (error) {
        console.warn("communication_intake write warning:", error.message);
        return { id: null, skipped: true };
      }
      return data;
    });

    // Fire task-router event immediately after successful intake write
    if (intakeRecord?.id) {
      await step.run("fire-task-router", async () => {
        await inngest.send({
          name: "communication/intake.received",
          data: { intake_id: intakeRecord.id },
        });
      });
    }
    await step.run("enrich-knowledge-graph", async () => {
      if (!customer.id)
        return { skipped: true, reason: "No customer ID" };
      const { data: existing } = await supabase.from("client_knowledge_graph").select("id, call_intelligence").eq("customer_id", customer.id).single();
      const callIntelligenceEntry = {
        date: new Date().toISOString(),
        intent: intelligence.intent,
        sentiment: intelligence.sentiment,
        pain_points: intelligence.pain_points,
        services_mentioned: intelligence.services_mentioned,
        budget_signals: intelligence.budget_signals,
        timeline_signals: intelligence.timeline_signals,
        decision_maker: intelligence.decision_maker,
        next_steps: intelligence.next_steps,
        summary: intelligence.summary,
        ghl_contact_id: contactId
      };
      if (existing) {
        const existingCalls = Array.isArray(existing.call_intelligence) ? existing.call_intelligence : [];
        await supabase.from("client_knowledge_graph").update({
          call_intelligence: [...existingCalls, callIntelligenceEntry],
          updated_at: new Date().toISOString()
        }).eq("id", existing.id);
      } else {
        await supabase.from("client_knowledge_graph").upsert({
          customer_id: customer.id,
          call_intelligence: [callIntelligenceEntry],
          business_overview: {
            company_name: intelligence.company_name || customer.company_name
          }
        }, { onConflict: "customer_id" });
      }
      return { enriched: true };
    });
    await step.run("log-cia-episode", async () => {
      const summary = intelligence.summary || `Call with ${customer.company_name}. Intent: ${intelligence.intent || "unknown"}. Sentiment: ${intelligence.sentiment}.`;
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "ghl",
        actor: "ghl-phase0-workflow",
        content: `Call transcript processed: ${customer.company_name || contactId}. ${summary} Pain points: ${Array.isArray(intelligence.pain_points) ? intelligence.pain_points.join(", ") : intelligence.pain_points || "none identified"}.`,
        metadata: {
          ghl_contact_id: contactId,
          location_id: locationId,
          customer_id: customer.id,
          intent: intelligence.intent,
          sentiment: intelligence.sentiment,
          services_mentioned: intelligence.services_mentioned,
          next_steps: intelligence.next_steps,
          call_duration,
          intake_id: intakeRecord?.id
        },
        timestamp_event: new Date().toISOString()
      });
    });
    return {
      success: true,
      contactId,
      customerId: customer.id,
      companyName: customer.company_name,
      intent: intelligence.intent,
      sentiment: intelligence.sentiment,
      intakeId: intakeRecord?.id
    };
  }
);
export {
  ghlTranscriptProcessor
};
