import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SLACK_WEBHOOK_SYSTEM_ALERTS = process.env.SLACK_WEBHOOK_SYSTEM_ALERTS;
const HIGH_VALUE_FORM_KEYWORDS = ["intake", "application", "onboard", "discovery", "proposal"];
const ghlFormProcessor = inngest.createFunction(
  {
    id: "ghl-form-processor",
    name: "GHL Intelligence: Form Submission Processor",
    retries: 2,
    concurrency: { limit: 10 }
  },
  { event: "ghl/form.submitted" },
  async ({ event, step }) => {
    const {
      contactId,
      locationId,
      formId,
      formName,
      submittedAt,
      data: formData = {},
      // GHL format varies — also check these paths
      contact,
      form
    } = event.data;
    const resolvedFormName = formName || form?.name || "Unknown Form";
    const resolvedFormId = formId || form?.id;
    const resolvedContactId = contactId || contact?.id;
    const isHighValue = HIGH_VALUE_FORM_KEYWORDS.some(
      (kw) => resolvedFormName.toLowerCase().includes(kw)
    );
    const customer = await step.run("lookup-customer", async () => {
      if (!resolvedContactId)
        return { id: null, company_name: "Unknown", email: null };
      const { data } = await supabase.from("customer").select("id, company_name, email, tenant_id").eq("ghl_contact_id", resolvedContactId).limit(1).single();
      if (data)
        return data;
      const companyName = formData.company_name || formData.business_name || formData.companyName || [formData.first_name, formData.last_name].filter(Boolean).join(" ") || contact?.name || "Unknown";
      const email = formData.email || formData.email_address || contact?.email || null;
      return { id: null, company_name: companyName, email, tenant_id: "creative-partner" };
    });
    await step.run("buffer-to-intake", async () => {
      const contentSummary = Object.entries(formData).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`).join("\n").substring(0, 2e3);
      const { error } = await supabase.from("communication_intake").insert({
        customer_id: customer.id,
        ghl_contact_id: resolvedContactId,
        location_id: locationId,
        communication_type: "form_submission",
        direction: "inbound",
        content: contentSummary || "[No form data]",
        metadata: {
          form_id: resolvedFormId,
          form_name: resolvedFormName,
          submitted_at: submittedAt,
          raw_data: formData,
          is_high_value: isHighValue,
          source: "ghl-form"
        },
        processed: false,
        received_at: submittedAt || (/* @__PURE__ */ new Date()).toISOString()
      });
      if (error) {
        console.warn("communication_intake form buffer warning:", error.message);
        return { skipped: true };
      }
      return { buffered: true };
    });
    const isPortalIntake = resolvedFormName.toLowerCase().includes("intake") || (formData.client_id || formData.customer_id);
    if (isPortalIntake) {
      await step.run("write-intake-form-response", async () => {
        const clientId = formData.client_id || formData.customer_id || resolvedContactId;
        const { error } = await supabase.from("intake_form_responses").upsert({
          client_id: clientId,
          contact_name: formData.contact_name || customer.company_name,
          email: formData.email || customer.email,
          phone: formData.phone,
          company_name: formData.company_name || formData.business_name || customer.company_name,
          website: formData.website,
          form_data: formData,
          submitted: true,
          submitted_at: submittedAt || (/* @__PURE__ */ new Date()).toISOString(),
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }, { onConflict: "client_id" });
        if (error)
          console.warn("intake_form_responses write warning:", error.message);
        return { written: !error };
      });
    }
    if (customer.id) {
      await step.run("update-customer-record", async () => {
        const updatePayload = {
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (formData.company_name || formData.business_name) {
          updatePayload.company_name = formData.company_name || formData.business_name;
        }
        if (formData.website)
          updatePayload.website = formData.website;
        if (formData.phone)
          updatePayload.phone = formData.phone;
        if (formData.industry)
          updatePayload.industry = formData.industry;
        if (Object.keys(updatePayload).length > 1) {
          const { error } = await supabase.from("customer").update(updatePayload).eq("id", customer.id);
          if (error)
            console.warn("Customer update warning:", error.message);
          return { updated: !error };
        }
        return { skipped: true, reason: "No updatable fields" };
      });
    }
    if (isHighValue && SLACK_WEBHOOK_SYSTEM_ALERTS) {
      await step.run("send-slack-alert", async () => {
        const fields = Object.entries(formData).filter(([, v]) => v != null && v !== "" && typeof v !== "object").slice(0, 6).map(([k, v]) => ({ type: "mrkdwn", text: `*${k.replace(/_/g, " ")}:*
${v}` }));
        await fetch(SLACK_WEBHOOK_SYSTEM_ALERTS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `Form submitted: ${resolvedFormName} \u2014 ${customer.company_name}`,
            blocks: [
              {
                type: "header",
                text: { type: "plain_text", text: `Form Submitted: ${resolvedFormName}`, emoji: true }
              },
              {
                type: "section",
                fields: [
                  { type: "mrkdwn", text: `*Client:*
${customer.company_name}` },
                  { type: "mrkdwn", text: `*Form:*
${resolvedFormName}` },
                  ...fields.slice(0, 4)
                ]
              }
            ]
          })
        });
        return { sent: true };
      });
    }
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "ghl",
        actor: customer.company_name || resolvedContactId || "unknown",
        content: `GHL form submitted: "${resolvedFormName}" by ${customer.company_name || "unknown client"}. ${isHighValue ? "HIGH-VALUE form \u2014 intake/onboarding." : ""} Contact: ${resolvedContactId}.`,
        metadata: {
          form_id: resolvedFormId,
          form_name: resolvedFormName,
          ghl_contact_id: resolvedContactId,
          location_id: locationId,
          customer_id: customer.id,
          is_high_value: isHighValue,
          is_portal_intake: isPortalIntake,
          field_count: Object.keys(formData).length
        },
        timestamp_event: submittedAt || (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return {
      success: true,
      contactId: resolvedContactId,
      formName: resolvedFormName,
      customerId: customer.id,
      isHighValue,
      isPortalIntake
    };
  }
);
export {
  ghlFormProcessor
};
