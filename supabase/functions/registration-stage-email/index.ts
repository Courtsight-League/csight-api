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
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

const jsonResponse = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed.' });
  }

  let payload: RegistrationEmailPayload;
  try {
    payload = (await req.json()) as RegistrationEmailPayload;
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON payload.' });
  }

  const stage = String(payload.stage || '').trim() as RegistrationStage;
  const subject = String(payload.subject || '').trim();
  const body = typeof payload.body === 'string' ? payload.body : '';
  const bodyHtml = typeof payload.bodyHtml === 'string' ? payload.bodyHtml : '';
  const recipientEmail = String(payload.recipientEmail || '').trim().toLowerCase();
  // Claim-profile invites should target only the player unless explicitly overridden.
  const includeAdminRecipients =
    stage === 'stats_portal_registration' || stage === 'claim_profile_invite'
      ? payload.includeAdminRecipients === true
      : payload.includeAdminRecipients !== false;
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null;

  if (!stage) return jsonResponse(400, { ok: false, error: 'Missing registration stage.' });
  if (!subject) return jsonResponse(400, { ok: false, error: 'Missing email subject.' });
  if (!body && !bodyHtml) return jsonResponse(400, { ok: false, error: 'Missing email body.' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { ok: false, error: 'Missing Supabase service credentials.' });
  }

  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('REGISTRATION_EMAIL_FROM') || Deno.env.get('SMTP_FROM');
  if (!resendApiKey || !fromEmail) {
    return jsonResponse(500, {
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
    return jsonResponse(200, { ok: true, sent: false, reason: 'no-recipients' });
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
    return jsonResponse(502, {
      ok: false,
      error: 'Email provider request failed.',
      details,
    });
  }

  const providerResult = await resendResponse.json();
  return jsonResponse(200, {
    ok: true,
    sent: true,
    stage: safeStage,
    recipients,
    metadata,
    providerResult,
  });
});
