import { createClient } from 'npm:@supabase/supabase-js@2';

type RegistrationStage =
  | 'league_registration'
  | 'payment'
  | 'stats_portal_registration'
  | 'claim_profile_invite';

type RegistrationEmailPayload = {
  stage?: RegistrationStage;
  subject?: string;
  body?: string;
  bodyHtml?: string;
  recipientEmail?: string;
  includeAdminRecipients?: boolean;
  metadata?: Record<string, unknown> | null;
};

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const getAllowedOrigins = () =>
  (Deno.env.get('ALLOWED_ORIGINS') ||
    `${Deno.env.get('PUBLIC_SITE_URL') || 'http://localhost:3000'},http://localhost:3000,http://127.0.0.1:3000`)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const resolveCorsHeaders = (origin: string | null) => {
  const allowedOrigins = getAllowedOrigins();
  const allowOrigin =
    origin && allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0] || 'http://localhost:3000';

  return {
    ...corsHeaders,
    'Access-Control-Allow-Origin': allowOrigin,
    Vary: 'Origin',
  };
};

const hasHtmlMarkup = (value: string) => /<\/?[a-z][\s\S]*>/i.test(value || '');
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const htmlToText = (value: string) => {
  if (!value) return '';
  if (!hasHtmlMarkup(value)) return value;
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const jsonResponse = (req: Request, status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...resolveCorsHeaders(req.headers.get('origin')),
      'Content-Type': 'application/json',
    },
  });

const validateOrigin = (req: Request) => {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
};

const getAuthenticatedUser = async (req: Request) => {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!token || !supabaseUrl || !anonKey) {
    return null;
  }

  const supabaseUser = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const { data, error } = await supabaseUser.auth.getUser();
  if (error || !data?.user) {
    return null;
  }

  return data.user;
};

Deno.serve(async (req: Request) => {
  if (!validateOrigin(req)) {
    return jsonResponse(req, 403, { ok: false, error: 'Origin not allowed.' });
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: resolveCorsHeaders(req.headers.get('origin')) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, 405, { ok: false, error: 'Method not allowed.' });
  }

  let payload: RegistrationEmailPayload;
  try {
    payload = (await req.json()) as RegistrationEmailPayload;
  } catch {
    return jsonResponse(req, 400, { ok: false, error: 'Invalid JSON payload.' });
  }

  const stage = String(payload.stage || '').trim() as RegistrationStage;
  const subject = String(payload.subject || '').trim();
  const body = typeof payload.body === 'string' ? payload.body : '';
  const bodyHtml = typeof payload.bodyHtml === 'string' ? payload.bodyHtml : '';
  const recipientEmail = String(payload.recipientEmail || '').trim().toLowerCase();
  const includeAdminRecipients =
    stage === 'stats_portal_registration' || stage === 'claim_profile_invite'
      ? payload.includeAdminRecipients === true
      : payload.includeAdminRecipients !== false;
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null;

  if (!stage) return jsonResponse(req, 400, { ok: false, error: 'Missing registration stage.' });
  if (!subject) return jsonResponse(req, 400, { ok: false, error: 'Missing email subject.' });
  if (!body && !bodyHtml) return jsonResponse(req, 400, { ok: false, error: 'Missing email body.' });
  if (subject.length > 200) {
    return jsonResponse(req, 400, { ok: false, error: 'Email subject is too long.' });
  }
  if (body.length > 10000 || bodyHtml.length > 20000) {
    return jsonResponse(req, 400, { ok: false, error: 'Email body is too large.' });
  }
  if (recipientEmail && !isValidEmail(recipientEmail)) {
    return jsonResponse(req, 400, { ok: false, error: 'Invalid recipient email.' });
  }

  const requiresAuthenticatedCaller =
    stage === 'claim_profile_invite' || includeAdminRecipients === true;
  if (requiresAuthenticatedCaller) {
    const authUser = await getAuthenticatedUser(req);
    if (!authUser) {
      return jsonResponse(req, 401, { ok: false, error: 'Authenticated caller required.' });
    }
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(req, 500, { ok: false, error: 'Missing Supabase service credentials.' });
  }

  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('REGISTRATION_EMAIL_FROM') || Deno.env.get('SMTP_FROM');
  if (!resendApiKey || !fromEmail) {
    return jsonResponse(req, 500, {
      ok: false,
      error: 'Missing RESEND_API_KEY or REGISTRATION_EMAIL_FROM secret.',
    });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  let adminEmails: string[] = [];
  if (includeAdminRecipients) {
    const fallbackEmails = (Deno.env.get('ADMIN_NOTIFICATION_EMAILS') || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    let dbEmails: string[] = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('admin_users')
        .select('email');
      if (error) throw error;
      dbEmails = (data || [])
        .map((row: any) => (row?.email || '').trim().toLowerCase())
        .filter(Boolean);
    } catch (err) {
      console.warn('registration-stage-email admin lookup failed', err);
    }
    adminEmails = [...fallbackEmails, ...dbEmails];
  }

  const recipients = Array.from(
    new Set([
      ...(isValidEmail(recipientEmail) ? [recipientEmail] : []),
      ...adminEmails.filter((email) => isValidEmail(email)),
    ])
  );
  if (!recipients.length) {
    return jsonResponse(req, 200, { ok: true, sent: false, reason: 'no-recipients' });
  }

  const html = bodyHtml && hasHtmlMarkup(bodyHtml) ? bodyHtml : undefined;
  const text = (body || '').trim() || htmlToText(bodyHtml || '');
  const safeStage = stage.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'registration';

  const resendPayload = {
    from: fromEmail,
    to: recipients,
    subject,
    text: text || undefined,
    html,
    headers: {
      'X-Courtsight-Registration-Stage': safeStage,
    },
  };

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(resendPayload),
  });

  if (!resendResponse.ok) {
    const details = await resendResponse.text();
    return jsonResponse(req, 502, {
      ok: false,
      error: 'Email provider request failed.',
      details,
    });
  }

  const providerResult = await resendResponse.json();
  return jsonResponse(req, 200, {
    ok: true,
    sent: true,
    stage: safeStage,
    recipients,
    metadata,
    providerResult,
  });
});
