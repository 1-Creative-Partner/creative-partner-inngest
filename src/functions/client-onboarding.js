import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SLACK_WEBHOOK_SYSTEM_ALERTS = process.env.SLACK_WEBHOOK_SYSTEM_ALERTS;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const clientOnboardingAutomation = inngest.createFunction(
  {
    id: "client-onboarding-automation",
    name: "Client Onboarding: Full Provisioning",
    retries: 2
  },
  { event: "customer/onboarding.started" },
  async ({ event, step }) => {
    const {
      customer_id,
      company_name,
      contact_name,
      email,
      phone,
      website,
      industry = "unknown",
      trigger_type = "new_customer"
    } = event.data;
    const basecampAuth = await step.run("get-basecamp-account-id", async () => {
      const { data } = await supabase.from("system_awareness").select("structured_data, content").eq("awareness_key", "basecamp_oauth_app").single();
      if (!data)
        throw new Error("Basecamp OAuth app config not found in system_awareness");
      const accessToken = data.structured_data?.access_token || data.structured_data?.token;
      if (!accessToken)
        throw new Error("No Basecamp access token in system_awareness");
      const authRes = await fetch("https://launchpad.37signals.com/authorization.json", {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": "Creative Partner OS (chad@creativepartnersolutions.com)"
        }
      });
      if (!authRes.ok)
        throw new Error(`Basecamp auth failed: ${authRes.status}`);
      const auth = await authRes.json();
      const account = auth.accounts?.find((a) => a.product === "bc3" || a.product === "bc4") || auth.accounts?.[0];
      if (!account)
        throw new Error("No Basecamp account found");
      return { accountId: account.id, baseUrl: account.href, accessToken };
    });
    const basecampProject = await step.run("create-basecamp-project", async () => {
      const res = await fetch(`${basecampAuth.baseUrl}/projects.json`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${basecampAuth.accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "Creative Partner OS (chad@creativepartnersolutions.com)"
        },
        body: JSON.stringify({
          name: company_name,
          description: `Client project for ${company_name}. Industry: ${industry}. Contact: ${contact_name}.`
        })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Basecamp project creation failed: ${res.status} ${err}`);
      }
      return res.json();
    });
    await step.run("store-basecamp-project-id", async () => {
      const { error } = await supabase.from("customer").update({ basecamp_project_id: String(basecampProject.id) }).eq("id", customer_id);
      if (error)
        throw new Error(`Failed to store Basecamp project ID: ${error.message}`);
    });
    const ghlContact = await step.run("create-ghl-contact", async () => {
      const { data: cred } = await supabase.from("api_credential").select("credential_value").eq("id", "ac_312efcfe-7abc-4d0a-9590-d58fc5389920").single();
      let token;
      try {
        const parsed = JSON.parse(cred?.credential_value || "{}");
        token = parsed.token || parsed.access_token || cred?.credential_value || "";
      } catch {
        token = cred?.credential_value || "";
      }
      if (!token)
        throw new Error("No GHL token available");
      const nameParts = (contact_name || "").split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";
      const res = await fetch("https://services.leadconnectorhq.com/contacts/", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Version": "2021-07-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          companyName: company_name,
          website,
          locationId: "VpL3sVe4Vb1ANBx9DOL6",
          tags: ["new-client", "onboarding", industry].filter(Boolean)
        })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`GHL contact creation failed: ${res.status} ${err}`);
      }
      const result = await res.json();
      return result.contact || result;
    });
    await step.run("store-ghl-contact-id", async () => {
      const ghlId = ghlContact.id || ghlContact.contact?.id;
      if (!ghlId)
        return { skipped: true, reason: "No GHL contact ID in response" };
      const { error } = await supabase.from("customer").update({ ghl_contact_id: ghlId }).eq("id", customer_id);
      if (error)
        throw new Error(`Failed to store GHL contact ID: ${error.message}`);
      return { ghlContactId: ghlId };
    });
    await step.run("scaffold-knowledge-graph", async () => {
      const { error } = await supabase.from("client_knowledge_graph").upsert({
        customer_id,
        business_overview: {
          company_name,
          industry,
          website,
          contact_name,
          email
        },
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      }, { onConflict: "customer_id" });
      if (error) {
        console.warn("Knowledge graph scaffold warning:", error.message);
      }
    });
    await step.run("create-client-state", async () => {
      const { error } = await supabase.from("client_state").upsert({
        customer_id,
        lifecycle_stage: "onboarding",
        health_score: 80,
        engagement_score: 50,
        last_activity_at: (/* @__PURE__ */ new Date()).toISOString()
      }, { onConflict: "customer_id" });
      if (error) {
        console.warn("Client state creation warning:", error.message);
      }
    });
    await step.run("send-slack-notification", async () => {
      if (!SLACK_WEBHOOK_SYSTEM_ALERTS) {
        console.warn("SLACK_WEBHOOK_SYSTEM_ALERTS not set");
        return { skipped: true };
      }
      await fetch(SLACK_WEBHOOK_SYSTEM_ALERTS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `New Client Onboarded: ${company_name}`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "New Client Onboarded", emoji: true }
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Company:*
${company_name}` },
                { type: "mrkdwn", text: `*Contact:*
${contact_name || "N/A"}` },
                { type: "mrkdwn", text: `*Industry:*
${industry}` },
                { type: "mrkdwn", text: `*Basecamp:*
Project #${basecampProject.id} created` }
              ]
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: "All systems created automatically. Ready to begin discovery." }
            }
          ]
        })
      });
      return { sent: true };
    });
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "change",
        source_system: "claude",
        actor: "client-onboarding-automation",
        content: `New client onboarded: ${company_name}. Basecamp project #${basecampProject.id} created. GHL contact created. Knowledge graph scaffolded. Trigger: ${trigger_type}.`,
        metadata: {
          customer_id,
          company_name,
          industry,
          basecamp_project_id: basecampProject.id,
          ghl_contact_id: ghlContact.id,
          trigger_type
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return {
      success: true,
      customer_id,
      company_name,
      basecamp_project_id: basecampProject.id,
      ghl_contact_id: ghlContact.id
    };
  }
);
export {
  clientOnboardingAutomation
};
