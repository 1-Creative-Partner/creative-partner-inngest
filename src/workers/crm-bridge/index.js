/**
 * CRM Bridge MCP — Cloudflare Worker
 * Worker: crm-bridge | Account: chad-590
 * 26 tools: 18 GHL + 6 Basecamp + 2 n8n
 * Env vars loaded at runtime from CF secrets — never hardcoded
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const BC_BASE = 'https://3.basecampapi.com';
const BC_ACCOUNT_ID = '6162345';
const BC_UA = 'CreativePartnerOS (chad@creativepartnersolutions.com)';
const N8N_SESSION_ENFORCEMENT_URL = 'https://creativepartneros.app.n8n.cloud/webhook/session-enforcement';

// ── Tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
  // GHL Contact (6)
  {
    name: 'get_contact',
    description: 'Get a GHL contact by ID',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'GHL Contact ID' },
        location: { type: 'string', description: 'Location key: cp, bailey, jumpstart, agency', default: 'cp' }
      },
      required: ['contactId']
    }
  },
  {
    name: 'create_contact',
    description: 'Create a new GHL contact',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        locationId: { type: 'string', description: 'GHL Location ID (overrides location key)' },
        tags: { type: 'array', items: { type: 'string' } },
        location: { type: 'string', description: 'Location key: cp, bailey, jumpstart, agency', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'update_contact',
    description: 'Update an existing GHL contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        location: { type: 'string', default: 'cp' }
      },
      required: ['contactId']
    }
  },
  {
    name: 'search_contacts',
    description: 'Search GHL contacts by query string',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (name, email, phone)' },
        locationId: { type: 'string' },
        limit: { type: 'number', default: 20 },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'upsert_contact',
    description: 'Upsert a GHL contact (create or update by email/phone)',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        locationId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'add_contact_note',
    description: 'Add a note to a GHL contact',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        body: { type: 'string', description: 'Note body text' },
        userId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['contactId', 'body']
    }
  },

  // GHL Conversation (3)
  {
    name: 'get_conversations',
    description: 'Get GHL conversations for a location or contact',
    inputSchema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        contactId: { type: 'string' },
        limit: { type: 'number', default: 20 },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'send_message',
    description: 'Send a message in a GHL conversation',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        type: { type: 'string', enum: ['SMS', 'Email', 'WhatsApp'], default: 'SMS' },
        message: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['conversationId', 'message']
    }
  },
  {
    name: 'search_conversations',
    description: 'Search GHL conversations',
    inputSchema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        contactId: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number', default: 20 },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },

  // GHL Opportunity (5)
  {
    name: 'get_opportunity',
    description: 'Get a GHL opportunity by ID',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['opportunityId']
    }
  },
  {
    name: 'create_opportunity',
    description: 'Create a new GHL opportunity',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        pipelineId: { type: 'string' },
        pipelineStageId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'], default: 'open' },
        contactId: { type: 'string' },
        locationId: { type: 'string' },
        monetaryValue: { type: 'number' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['title', 'pipelineId', 'pipelineStageId']
    }
  },
  {
    name: 'update_opportunity',
    description: 'Update a GHL opportunity',
    inputSchema: {
      type: 'object',
      properties: {
        opportunityId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        monetaryValue: { type: 'number' },
        pipelineStageId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['opportunityId']
    }
  },
  {
    name: 'search_opportunities',
    description: 'Search GHL opportunities',
    inputSchema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        query: { type: 'string' },
        status: { type: 'string' },
        pipelineId: { type: 'string' },
        limit: { type: 'number', default: 20 },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'get_pipelines',
    description: 'Get all GHL pipelines for a location',
    inputSchema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },

  // GHL Workflow (2)
  {
    name: 'get_workflows',
    description: 'Get all GHL workflows for a location',
    inputSchema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'add_contact_to_workflow',
    description: 'Add a GHL contact to a workflow',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['contactId', 'workflowId']
    }
  },
  {
    name: 'remove_contact_from_workflow',
    description: 'Remove a GHL contact from a workflow',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        workflowId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['contactId', 'workflowId']
    }
  },

  // GHL Calendar (2)
  {
    name: 'get_calendars',
    description: 'Get all GHL calendars for a location',
    inputSchema: {
      type: 'object',
      properties: {
        locationId: { type: 'string' },
        location: { type: 'string', default: 'cp' }
      },
      required: []
    }
  },
  {
    name: 'get_calendar_slots',
    description: 'Get available calendar time slots',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        startDate: { type: 'string', description: 'ISO date string, e.g. 2026-03-15' },
        endDate: { type: 'string', description: 'ISO date string, e.g. 2026-03-22' },
        timezone: { type: 'string', default: 'America/Chicago' },
        location: { type: 'string', default: 'cp' }
      },
      required: ['calendarId', 'startDate', 'endDate']
    }
  },

  // Basecamp (6)
  {
    name: 'bc_list_projects',
    description: 'List all Basecamp projects',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'bc_get_todolists',
    description: 'Get todolists in a Basecamp project todoset',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number', description: 'Basecamp project ID' },
        todosetId: { type: 'number', description: 'Basecamp todoset ID' }
      },
      required: ['projectId', 'todosetId']
    }
  },
  {
    name: 'bc_get_todos',
    description: 'Get todos in a Basecamp todolist',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        todolistId: { type: 'number' }
      },
      required: ['projectId', 'todolistId']
    }
  },
  {
    name: 'bc_create_todo',
    description: 'Create a new todo in a Basecamp todolist',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        todolistId: { type: 'number' },
        content: { type: 'string', description: 'Todo title' },
        description: { type: 'string', description: 'Optional description (HTML)' },
        dueOn: { type: 'string', description: 'Due date: YYYY-MM-DD' },
        assigneeIds: { type: 'array', items: { type: 'number' } }
      },
      required: ['projectId', 'todolistId', 'content']
    }
  },
  {
    name: 'bc_update_todo',
    description: 'Update a Basecamp todo',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        todoId: { type: 'number' },
        content: { type: 'string' },
        description: { type: 'string' },
        completed: { type: 'boolean' },
        dueOn: { type: 'string', description: 'Due date: YYYY-MM-DD' }
      },
      required: ['projectId', 'todoId']
    }
  },
  {
    name: 'bc_create_message',
    description: 'Create a message post in a Basecamp message board',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        messageBoardId: { type: 'number' },
        subject: { type: 'string' },
        content: { type: 'string', description: 'Message body (HTML allowed)' }
      },
      required: ['projectId', 'messageBoardId', 'subject', 'content']
    }
  },

  // n8n (2)
  {
    name: 'n8n_execute_workflow',
    description: 'Execute an n8n workflow via webhook URL',
    inputSchema: {
      type: 'object',
      properties: {
        webhookUrl: { type: 'string', description: 'Full n8n webhook URL' },
        payload: { type: 'object', description: 'JSON payload to POST to webhook' }
      },
      required: ['webhookUrl']
    }
  },
  {
    name: 'n8n_fire_session_enforcement',
    description: 'Fire the session enforcement n8n workflow',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string' },
        data: { type: 'object' }
      },
      required: []
    }
  }
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function ghlToken(env, location = 'cp') {
  const map = {
    cp: env.GHL_CP_PIT,
    bailey: env.GHL_BAILEY_PIT,
    jumpstart: env.GHL_JUMPSTART_PIT,
    agency: env.GHL_AGENCY_PIT
  };
  return map[location] || env.GHL_CP_PIT;
}

async function ghlFetch(method, path, env, location, body) {
  const token = ghlToken(env, location);
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': GHL_VERSION,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${GHL_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GHL ${method} ${path} → ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : { success: true };
}

async function bcToken(env) {
  const url = `${env.SUPABASE_URL}/rest/v1/system_awareness?awareness_key=eq.basecamp_oauth_app&select=structured_data&limit=1`;
  const res = await fetch(url, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  const rows = await res.json();
  if (!rows.length || !rows[0]?.structured_data?.access_token) {
    throw new Error('Basecamp access token not found in Supabase system_awareness');
  }
  return rows[0].structured_data.access_token;
}

async function bcFetch(method, path, env, body) {
  const token = await bcToken(env);
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': BC_UA
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BC_BASE}/${BC_ACCOUNT_ID}${path}`, opts);
  if (res.status === 204) return { success: true };
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Basecamp ${method} ${path} → ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function callTool(name, args, env) {
  const loc = args.location || 'cp';

  switch (name) {
    // ── GHL Contact ──
    case 'get_contact':
      return ghlFetch('GET', `/contacts/${args.contactId}`, env, loc);

    case 'create_contact':
      return ghlFetch('POST', '/contacts', env, loc, {
        firstName: args.firstName,
        lastName: args.lastName,
        email: args.email,
        phone: args.phone,
        locationId: args.locationId,
        tags: args.tags
      });

    case 'update_contact':
      return ghlFetch('PUT', `/contacts/${args.contactId}`, env, loc, {
        firstName: args.firstName,
        lastName: args.lastName,
        email: args.email,
        phone: args.phone,
        tags: args.tags
      });

    case 'search_contacts': {
      const params = new URLSearchParams();
      if (args.query) params.set('query', args.query);
      if (args.locationId) params.set('locationId', args.locationId);
      if (args.limit) params.set('limit', String(args.limit));
      return ghlFetch('GET', `/contacts/search?${params}`, env, loc);
    }

    case 'upsert_contact':
      return ghlFetch('POST', '/contacts/upsert', env, loc, {
        firstName: args.firstName,
        lastName: args.lastName,
        email: args.email,
        phone: args.phone,
        locationId: args.locationId
      });

    case 'add_contact_note':
      return ghlFetch('POST', `/contacts/${args.contactId}/notes`, env, loc, {
        body: args.body,
        userId: args.userId
      });

    // ── GHL Conversation ──
    case 'get_conversations': {
      const params = new URLSearchParams();
      if (args.locationId) params.set('locationId', args.locationId);
      if (args.contactId) params.set('contactId', args.contactId);
      if (args.limit) params.set('limit', String(args.limit));
      return ghlFetch('GET', `/conversations/search?${params}`, env, loc);
    }

    case 'send_message':
      return ghlFetch('POST', '/conversations/messages', env, loc, {
        conversationId: args.conversationId,
        type: args.type || 'SMS',
        message: args.message
      });

    case 'search_conversations': {
      const params = new URLSearchParams();
      if (args.locationId) params.set('locationId', args.locationId);
      if (args.contactId) params.set('contactId', args.contactId);
      if (args.query) params.set('query', args.query);
      if (args.limit) params.set('limit', String(args.limit));
      return ghlFetch('GET', `/conversations/search?${params}`, env, loc);
    }

    // ── GHL Opportunity ──
    case 'get_opportunity':
      return ghlFetch('GET', `/opportunities/${args.opportunityId}`, env, loc);

    case 'create_opportunity':
      return ghlFetch('POST', '/opportunities', env, loc, {
        title: args.title,
        pipelineId: args.pipelineId,
        pipelineStageId: args.pipelineStageId,
        status: args.status || 'open',
        contactId: args.contactId,
        locationId: args.locationId,
        monetaryValue: args.monetaryValue
      });

    case 'update_opportunity':
      return ghlFetch('PUT', `/opportunities/${args.opportunityId}`, env, loc, {
        title: args.title,
        status: args.status,
        monetaryValue: args.monetaryValue,
        pipelineStageId: args.pipelineStageId
      });

    case 'search_opportunities': {
      const params = new URLSearchParams();
      if (args.locationId) params.set('location_id', args.locationId);
      if (args.query) params.set('q', args.query);
      if (args.status) params.set('status', args.status);
      if (args.pipelineId) params.set('pipeline_id', args.pipelineId);
      if (args.limit) params.set('limit', String(args.limit));
      return ghlFetch('GET', `/opportunities/search?${params}`, env, loc);
    }

    case 'get_pipelines': {
      const params = new URLSearchParams();
      if (args.locationId) params.set('locationId', args.locationId);
      return ghlFetch('GET', `/opportunities/pipelines?${params}`, env, loc);
    }

    // ── GHL Workflow ──
    case 'get_workflows': {
      const params = new URLSearchParams();
      if (args.locationId) params.set('locationId', args.locationId);
      return ghlFetch('GET', `/workflows/?${params}`, env, loc);
    }

    case 'add_contact_to_workflow':
      return ghlFetch('POST', `/contacts/${args.contactId}/workflow/${args.workflowId}`, env, loc, {
        eventStartTime: new Date().toISOString()
      });

    case 'remove_contact_from_workflow':
      return ghlFetch('DELETE', `/contacts/${args.contactId}/workflow/${args.workflowId}`, env, loc);

    // ── GHL Calendar ──
    case 'get_calendars': {
      const params = new URLSearchParams();
      if (args.locationId) params.set('locationId', args.locationId);
      return ghlFetch('GET', `/calendars/?${params}`, env, loc);
    }

    case 'get_calendar_slots': {
      const params = new URLSearchParams({
        startDate: args.startDate,
        endDate: args.endDate,
        timezone: args.timezone || 'America/Chicago'
      });
      return ghlFetch('GET', `/calendars/${args.calendarId}/free-slots?${params}`, env, loc);
    }

    // ── Basecamp ──
    case 'bc_list_projects':
      return bcFetch('GET', '/projects.json', env);

    case 'bc_get_todolists':
      return bcFetch('GET', `/buckets/${args.projectId}/todosets/${args.todosetId}/todolists.json`, env);

    case 'bc_get_todos':
      return bcFetch('GET', `/buckets/${args.projectId}/todolists/${args.todolistId}/todos.json`, env);

    case 'bc_create_todo': {
      const body = { content: args.content };
      if (args.description) body.description = args.description;
      if (args.dueOn) body.due_on = args.dueOn;
      if (args.assigneeIds) body.assignee_ids = args.assigneeIds;
      return bcFetch('POST', `/buckets/${args.projectId}/todolists/${args.todolistId}/todos.json`, env, body);
    }

    case 'bc_update_todo': {
      const body = {};
      if (args.content !== undefined) body.content = args.content;
      if (args.description !== undefined) body.description = args.description;
      if (args.dueOn !== undefined) body.due_on = args.dueOn;
      if (args.completed !== undefined) body.completed = args.completed;
      return bcFetch('PUT', `/buckets/${args.projectId}/todos/${args.todoId}.json`, env, body);
    }

    case 'bc_create_message':
      return bcFetch('POST', `/buckets/${args.projectId}/message_boards/${args.messageBoardId}/messages.json`, env, {
        subject: args.subject,
        content: args.content
      });

    // ── n8n ──
    case 'n8n_execute_workflow': {
      const res = await fetch(args.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args.payload || {})
      });
      const text = await res.text();
      return text ? JSON.parse(text) : { success: true, status: res.status };
    }

    case 'n8n_fire_session_enforcement': {
      const res = await fetch(N8N_SESSION_ENFORCEMENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: args.sessionId,
          action: args.action,
          data: args.data || {}
        })
      });
      const text = await res.text();
      return text ? JSON.parse(text) : { success: true };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP JSON-RPC handler ─────────────────────────────────────────────────────

function jsonrpcOk(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function jsonrpcErr(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function handleMcp(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonrpcErr(null, -32700, 'Parse error');
  }

  const { id, method, params } = body;

  // Handle batch (array) — not supported
  if (Array.isArray(body)) {
    return jsonrpcErr(null, -32600, 'Batch requests not supported');
  }

  switch (method) {
    case 'initialize':
      return jsonrpcOk(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'crm-bridge', version: '1.0.0' }
      });

    case 'tools/list':
      return jsonrpcOk(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      if (!toolName) return jsonrpcErr(id, -32602, 'Missing tool name');

      const tool = TOOLS.find(t => t.name === toolName);
      if (!tool) return jsonrpcErr(id, -32602, `Unknown tool: ${toolName}`);

      try {
        const result = await callTool(toolName, toolArgs, env);
        return jsonrpcOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        });
      } catch (err) {
        return jsonrpcOk(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        });
      }
    }

    case 'notifications/initialized':
      // No-op acknowledgment
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

    default:
      return jsonrpcErr(id, -32601, `Method not found: ${method}`);
  }
}

// ── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', tools: TOOLS.length, worker: 'crm-bridge' }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'POST required' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
      return handleMcp(req, env);
    }

    // Root redirect info
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        name: 'CRM Bridge MCP',
        version: '1.0.0',
        endpoints: { health: '/health', mcp: '/mcp' },
        tools: TOOLS.length
      }), {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
