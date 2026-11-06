// Reckoning — Claude proxy (Supabase Edge Function "claude").
// The browser sends { system, messages, tools }. This function checks who is
// calling, adds the model and the Anthropic key server-side, and passes
// Anthropic's reply back unchanged. No keys live in this file: they come from
// Supabase secrets ANTHROPIC_API_KEY, ALLOWED_EMAILS, CLAUDE_MODEL (optional).
// "Verify JWT" can be off for this function: it does its own auth check below.

const ORIGIN = 'https://reckoning.coopersfault.com';
const CORS = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

// Errors use Anthropic's own shape so the chat shows every failure the same way.
function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'Use POST.');

  try {
    // 1. Who is calling? Ask Supabase Auth with the caller's own token.
    const auth = req.headers.get('authorization');
    const apikey = req.headers.get('apikey');
    if (!auth || !apikey) return fail(401, 'Not signed in (missing Authorization or apikey header).');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) return fail(500, 'Server misconfigured: SUPABASE_URL is not set.');
    const who = await fetch(supabaseUrl + '/auth/v1/user', { headers: { Authorization: auth, apikey } });
    if (!who.ok) return fail(401, 'Not signed in (session rejected, status ' + who.status + '). Try signing out and back in.');
    const user = await who.json();
    const email = String(user?.email || '').trim().toLowerCase();

    // 2. Sign-up is open, so only listed emails may use Claude.
    const allowed = (Deno.env.get('ALLOWED_EMAILS') || '')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!email || !allowed.includes(email)) return fail(403, 'This account is not allowed to use Claude.');

    // 3. Accept only { system, messages, tools }.
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return fail(400, 'Request body is not valid JSON.'); }
    const { system, messages, tools } = body ?? {};
    if (system !== undefined && typeof system !== 'string') return fail(400, '"system" must be a string.');
    if (!Array.isArray(messages) || !messages.length) return fail(400, '"messages" must be a non-empty array.');
    if (tools !== undefined && !Array.isArray(tools)) return fail(400, '"tools" must be an array.');

    // 4. Call Anthropic with the server-side key, model and max_tokens.
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return fail(500, 'Server misconfigured: ANTHROPIC_API_KEY secret is not set.');
    const payload: Record<string, unknown> = {
      model: Deno.env.get('CLAUDE_MODEL') || 'claude-sonnet-5-5',
      max_tokens: 1024,
      messages,
    };
    if (system) payload.system = system;
    if (tools && (tools as unknown[]).length) payload.tools = tools;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // 5. Return Anthropic's status and body unchanged.
    return new Response(await r.text(), {
      status: r.status,
      headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json' },
    });
  } catch (e) {
    return fail(502, 'Proxy error: ' + (e instanceof Error ? e.message : String(e)));
  }
});
