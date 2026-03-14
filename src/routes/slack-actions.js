import express from 'express';
import crypto from 'crypto';
import { supabase } from '../supabase-client.js';
import { getGHLToken } from '../ghl-token.js';

const GHL_LOCATION_ID = 'VpL3sVe4Vb1ANBx9DOL6';

function verifySlackSignature(rawBody, headers, signingSecret) {
  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig = headers['x-slack-signature'];
  if (!timestamp || !slackSig) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(slackSig));
  } catch {
    return false;
  }
}

async function handleSendDraft(taskId, responseUrl) {
  const { data: rows } = await supabase.from('task').select('*').eq('id', taskId).limit(1);
  const t = rows?.[0];
  if (!t) throw new Error('Task not found');

  const { draft_message, contact_identifier, contact_name, source_channel } = t.input || {};
  if (!draft_message) throw new Error('No draft message on this task');

  const pitToken = await getGHLToken();
  const msgType = source_channel === 'email' ? 'Email' : 'SMS';

  const sendRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${pitToken}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: msgType,
      contactId: contact_identifier,
      locationId: GHL_LOCATION_ID,
      message: draft_message,
    }),
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text();
    throw new Error(`GHL send failed: ${sendRes.status} — ${errText.slice(0, 200)}`);
  }

  await supabase.from('task')
    .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', taskId);

  await supabase.from('cia_episode').insert({
    episode_type: 'observation',
    source_system: 'task-router',
    actor: 'slack-actions',
    content: `${msgType} sent to ${contact_name || contact_identifier} via Slack approval. Task: ${t.name}`,
    timestamp_event: new Date().toISOString(),
  });

  if (responseUrl) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace_original: true,
        text: `✅ *${msgType} sent* to ${contact_name || contact_identifier}\n_"${draft_message.slice(0, 120)}${draft_message.length > 120 ? '…' : ''}"_`,
      }),
    }).catch(() => {});
  }
}

async function handleSkipTask(taskId, responseUrl) {
  const { data: rows } = await supabase.from('task').select('name').eq('id', taskId).limit(1);
  const t = rows?.[0];

  await supabase.from('task')
    .update({ status: 'skipped', updated_at: new Date().toISOString() })
    .eq('id', taskId);

  if (responseUrl) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace_original: true,
        text: `⊘ Skipped — _${t?.name || taskId}_`,
      }),
    }).catch(() => {});
  }
}

async function handleMarkDone(taskId, responseUrl) {
  const { data: rows } = await supabase.from('task').select('name').eq('id', taskId).limit(1);
  const t = rows?.[0];

  await supabase.from('task')
    .update({ status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', taskId);

  if (responseUrl) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace_original: true,
        text: `✅ Done — _${t?.name || taskId}_`,
      }),
    }).catch(() => {});
  }
}

export function setupSlackRoutes(app) {
  app.post(
    '/api/slack/actions',
    express.urlencoded({
      extended: true,
      verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
    }),
    async (req, res) => {
      // Verify Slack signature
      const { data: sigCred } = await supabase.from('api_credential')
        .select('credential_value')
        .eq('service', 'slack')
        .eq('credential_key', 'signing_secret')
        .single();

      if (sigCred?.credential_value && req.rawBody) {
        if (!verifySlackSignature(req.rawBody, req.headers, sigCred.credential_value)) {
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }

      const payloadStr = req.body?.payload;
      if (!payloadStr) return res.status(400).json({ error: 'No payload' });

      let payload;
      try { payload = JSON.parse(payloadStr); } catch { return res.status(400).json({ error: 'Invalid payload JSON' }); }

      const action = payload.actions?.[0];
      const responseUrl = payload.response_url;
      const taskId = action?.value;

      // Must respond within 3 seconds
      res.json({ response_type: 'in_channel', replace_original: false, text: 'On it...' });

      // Process async
      setImmediate(async () => {
        try {
          if (action?.action_id === 'send_draft') {
            await handleSendDraft(taskId, responseUrl);
          } else if (action?.action_id === 'skip_task') {
            await handleSkipTask(taskId, responseUrl);
          } else if (action?.action_id === 'mark_done') {
            await handleMarkDone(taskId, responseUrl);
          }
        } catch (e) {
          console.error('Slack action error:', e.message);
          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ replace_original: true, text: `❌ Error: ${e.message}` }),
            }).catch(() => {});
          }
        }
      });
    }
  );
}
