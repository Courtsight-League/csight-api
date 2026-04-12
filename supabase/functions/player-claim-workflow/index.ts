import { createClient } from 'npm:@supabase/supabase-js@2';

type WorkflowAction =
  | 'send_claim_email'
  | 'preview_claim'
  | 'confirm_claim'
  | 'resend_claim_email';

type WorkflowPayload = {
  action?: WorkflowAction;
  token?: string;
  playerId?: string | null;
  email?: string | null;
  password?: string | null;
  playerName?: string | null;
  teamName?: string | null;
  seasonName?: string | null;
  createdBy?: string | null;
};

const CLAIM_TEMPLATE_SUBJECT_KEY = 'email_template_claim_profile_invite_subject';
const CLAIM_TEMPLATE_BODY_KEY = 'email_template_claim_profile_invite_body';
const CLAIM_TEMPLATE_DEFAULT_SUBJECT = 'Claim your Courtsight profile: {{fullName}}';
const CLAIM_TEMPLATE_DEFAULT_BODY =
  'Hi {{fullName}},\n\nYou were added to {{teamName}} for {{season}}.\n\nClaim your Courtsight profile here:\n{{claimLink}}\n\nUse this link to set your password and access your player account.\n\nIf this was not you, please ignore this email or contact support.\n\nCourtsight League';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

const jsonResponse = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });

const normalizeEmail = (value?: string | null) => String(value || '').trim().toLowerCase();
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const hasHtmlMarkup = (value: string) => /<\/?[a-z][\s\S]*>/i.test(value || '');

const renderTemplateString = (
  template: string,
  data: Record<string, string | number | boolean | null | undefined>
) =>
  String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token) => {
    const value = data[token];
    if (value === null || value === undefined) return '';
    return String(value);
  });

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

const isStrongPassword = (value: string) =>
  value.length >= 8 && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);

const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
};

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const hashToken = async (token: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(digest);
};

const generateToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const parseMissingColumn = (message: string) => {
  const lower = String(message || '').toLowerCase();
  const relationMatch = lower.match(/column\s+\"?([a-z0-9_]+)\"?\s+of relation/);
  if (relationMatch?.[1]) return relationMatch[1];
  const genericMatch = lower.match(/column\s+([a-z0-9_]+)\s+does not exist/);
  return genericMatch?.[1] || null;
};

const requestIp = (req: Request) => {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  if (!forwarded) return '';
  return forwarded.split(',')[0]?.trim() || '';
};

const parseTeamPayment = (value: string | null | undefined) => {
  const normalized = String(value || '').trim().toLowerCase();
  const paid = normalized === 'paid' || normalized === 'paid-active' || normalized === 'complete' || normalized === 'completed';
  return {
    claimStatus: paid ? 'Paid-Active' : 'Unpaid-Pending',
    paymentStatus: paid ? 'paid' : 'pending',
  };
};

const getBaseUrl = (req: Request) => {
  const configured = (Deno.env.get('PUBLIC_SITE_URL') || Deno.env.get('VITE_PUBLIC_SITE_URL') || '').trim();
  if (configured) return configured.replace(/\/+$/g, '');
  const origin = req.headers.get('origin') || '';
  if (origin) return origin.replace(/\/+$/g, '');
  return 'https://courtsightleague.com';
};

const getSupportUrl = (req: Request) => `${getBaseUrl(req)}/contact`;

const buildClaimUrl = (req: Request, token: string) =>
  `${getBaseUrl(req)}/claim?token=${encodeURIComponent(token)}`;

const getSupabaseAdmin = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase service credentials.');
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
};

const safePlayerUpdate = async (supabaseAdmin: any, playerId: string, payload: Record<string, unknown>) => {
  let nextPayload: Record<string, unknown> = { ...payload };
  while (Object.keys(nextPayload).length) {
    const { error } = await supabaseAdmin.from('players').update(nextPayload).eq('id', playerId);
    if (!error) return;
    const missing = parseMissingColumn(error.message || '');
    if (missing && Object.prototype.hasOwnProperty.call(nextPayload, missing)) {
      delete nextPayload[missing];
      continue;
    }
    throw error;
  }
};

const safeProfileUpsert = async (supabaseAdmin: any, payload: Record<string, unknown>) => {
  let nextPayload: Record<string, unknown> = { ...payload };
  while (Object.keys(nextPayload).length) {
    const { error } = await supabaseAdmin.from('profiles').upsert(nextPayload, { onConflict: 'user_id' });
    if (!error) return;
    const missing = parseMissingColumn(error.message || '');
    if (missing && Object.prototype.hasOwnProperty.call(nextPayload, missing)) {
      delete nextPayload[missing];
      continue;
    }
    throw error;
  }
};

const loadClaimInviteTemplate = async (supabaseAdmin: any) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('site_settings')
      .select('key,value')
      .in('key', [CLAIM_TEMPLATE_SUBJECT_KEY, CLAIM_TEMPLATE_BODY_KEY]);
    if (error) throw error;

    const byKey = new Map<string, string>();
    (data || []).forEach((row: any) => {
      if (row?.key && typeof row?.value === 'string') {
        byKey.set(String(row.key), row.value);
      }
    });

    return {
      subject: byKey.get(CLAIM_TEMPLATE_SUBJECT_KEY)?.trim() || CLAIM_TEMPLATE_DEFAULT_SUBJECT,
      body: byKey.get(CLAIM_TEMPLATE_BODY_KEY)?.trim() || CLAIM_TEMPLATE_DEFAULT_BODY,
    };
  } catch (err) {
    console.warn('claim invite template lookup failed, using defaults', err);
    return {
      subject: CLAIM_TEMPLATE_DEFAULT_SUBJECT,
      body: CLAIM_TEMPLATE_DEFAULT_BODY,
    };
  }
};

const queryPlayersByEmail = async (supabaseAdmin: any, email: string) => {
  const selectVariants = [
    'id,first_name,last_name,team_id,season_id,user_id,email,email_address,photo_url',
    'id,first_name,last_name,team_id,season_id,user_id,email,photo_url',
    'id,first_name,last_name,team_id,season_id,user_id,email_address,photo_url',
    'id,first_name,last_name,team_id,season_id,user_id,photo_url',
  ];

  let rows: any[] = [];
  let lastErr: any = null;
  for (const selectQuery of selectVariants) {
    const hasEmail = selectQuery.includes('email');
    const hasEmailAddress = selectQuery.includes('email_address');
    let query = supabaseAdmin.from('players').select(selectQuery).order('created_at', { ascending: false });
    if (hasEmail && hasEmailAddress) {
      query = query.or(`email.eq.${email},email_address.eq.${email}`);
    } else if (hasEmail) {
      query = query.eq('email', email);
    } else if (hasEmailAddress) {
      query = query.eq('email_address', email);
    } else {
      continue;
    }
    const { data, error } = await query;
    if (!error) {
      rows = data || [];
      lastErr = null;
      break;
    }
    lastErr = error;
    const missing = parseMissingColumn(error.message || '');
    if (!missing) break;
  }

  if (lastErr) throw lastErr;

  const teamIds = Array.from(new Set(rows.map((r: any) => r.team_id).filter(Boolean)));
  const seasonIds = Array.from(new Set(rows.map((r: any) => r.season_id).filter(Boolean)));

  const [teamRows, seasonRows] = await Promise.all([
    teamIds.length
      ? supabaseAdmin.from('teams').select('id,name,division,payment_status').in('id', teamIds)
      : Promise.resolve({ data: [], error: null }),
    seasonIds.length
      ? supabaseAdmin.from('seasons').select('id,name,year,start_date').in('id', seasonIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (teamRows.error) throw teamRows.error;
  if (seasonRows.error) throw seasonRows.error;

  const teamMap = new Map<string, any>((teamRows.data || []).map((row: any) => [row.id, row]));
  const seasonMap = new Map<string, any>((seasonRows.data || []).map((row: any) => [row.id, row]));

  const profileRows = rows.map((row: any) => {
    const season = row.season_id ? seasonMap.get(row.season_id) : null;
    const seasonName = season?.name || 'Season';
    const seasonYear = season?.year != null ? String(season.year).trim() : '';
    const seasonLabel = seasonYear && !seasonName.includes(seasonYear)
      ? `${seasonName} ${seasonYear}`.trim()
      : seasonName;
    return {
      id: String(row.id),
      firstName: String(row.first_name || '').trim(),
      lastName: String(row.last_name || '').trim(),
      fullName: `${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`.trim() || 'Player',
      userId: row.user_id ? String(row.user_id) : null,
      teamId: row.team_id ? String(row.team_id) : null,
      teamName: row.team_id ? (teamMap.get(row.team_id)?.name || 'Team') : 'Team',
      division: row.team_id ? (teamMap.get(row.team_id)?.division || 'Division') : 'Division',
      seasonId: row.season_id ? String(row.season_id) : null,
      seasonLabel,
      teamPaymentStatus: row.team_id ? (teamMap.get(row.team_id)?.payment_status || null) : null,
    };
  });

  return profileRows;
};

const logClaimEvent = async (
  supabaseAdmin: any,
  args: {
    tokenId?: string | null;
    email?: string | null;
    playerId?: string | null;
    ipAddress?: string | null;
    action: string;
    outcome: string;
    details?: Record<string, unknown>;
  }
) => {
  try {
    await supabaseAdmin.from('player_claim_events').insert({
      token_id: args.tokenId || null,
      email: args.email || null,
      player_id: args.playerId || null,
      ip_address: args.ipAddress || null,
      action: args.action,
      outcome: args.outcome,
      details: args.details || {},
    });
  } catch {
    // non-blocking audit
  }
};

const checkRateLimit = async (supabaseAdmin: any, ipAddress: string) => {
  if (!ipAddress) return false;
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  try {
    const { count, error } = await supabaseAdmin
      .from('player_claim_events')
      .select('id', { count: 'exact', head: true })
      .eq('ip_address', ipAddress)
      .in('action', ['preview_claim', 'confirm_claim'])
      .gte('created_at', since);
    if (error) return false;
    return (count || 0) >= RATE_LIMIT_MAX_ATTEMPTS;
  } catch {
    return false;
  }
};

const issueClaimToken = async (
  supabaseAdmin: any,
  args: {
    email: string;
    playerId?: string | null;
    createdBy?: string | null;
    metadata?: Record<string, unknown>;
  }
) => {
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const rawToken = generateToken();
  const tokenHash = await hashToken(rawToken);

  await supabaseAdmin
    .from('player_claim_tokens')
    .update({ revoked_at: nowIso })
    .eq('email', args.email)
    .is('used_at', null)
    .is('revoked_at', null);

  const { data, error } = await supabaseAdmin
    .from('player_claim_tokens')
    .insert({
      player_id: args.playerId || null,
      email: args.email,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_by: args.createdBy || null,
      metadata: args.metadata || {},
    })
    .select('id,expires_at')
    .single();

  if (error || !data?.id) throw error || new Error('Unable to issue claim token.');

  return {
    tokenId: String(data.id),
    token: rawToken,
    expiresAt: String(data.expires_at || expiresAt),
  };
};

const sendClaimEmail = async (
  supabaseAdmin: any,
  req: Request,
  args: {
    email: string;
    playerName?: string | null;
    teamName?: string | null;
    seasonName?: string | null;
    claimUrl: string;
    expiresAt: string;
  }
) => {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('REGISTRATION_EMAIL_FROM') || Deno.env.get('SMTP_FROM');
  if (!resendApiKey || !fromEmail) {
    throw new Error('Missing RESEND_API_KEY or REGISTRATION_EMAIL_FROM secret.');
  }

  const friendlyName = (args.playerName || '').trim() || 'Player';
  const nameParts = friendlyName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ');
  const teamLabel = (args.teamName || 'your team').trim();
  const seasonLabel = (args.seasonName || 'current season').trim();
  const supportUrl = getSupportUrl(req);
  const template = await loadClaimInviteTemplate(supabaseAdmin);
  const templateData = {
    fullName: friendlyName,
    firstName,
    lastName,
    email: args.email,
    phone: '',
    registrationType: 'Claim Profile Invite',
    teamName: teamLabel,
    teamId: '',
    season: seasonLabel,
    seasonId: '',
    division: '',
    paymentChoice: '',
    portalLink: args.claimUrl,
    claimLink: args.claimUrl,
    supportUrl,
  };
  const subject = renderTemplateString(template.subject, templateData).trim() || 'Claim your Courtsight profile';
  const renderedBody = renderTemplateString(template.body, templateData).trim();
  const htmlBody = hasHtmlMarkup(renderedBody) ? renderedBody : undefined;
  const textBody = htmlBody ? htmlToText(renderedBody) : renderedBody;

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [args.email],
      subject,
      text: textBody,
      html: htmlBody,
      headers: {
        'X-Courtsight-Claim-Workflow': 'true',
      },
    }),
  });

  if (!resendResponse.ok) {
    const details = await resendResponse.text();
    throw new Error(`Email provider request failed: ${details}`);
  }
};

const findTokenRow = async (supabaseAdmin: any, token: string) => {
  const tokenHash = await hashToken(token);
  const { data, error } = await supabaseAdmin
    .from('player_claim_tokens')
    .select('id,player_id,email,expires_at,used_at,revoked_at,created_at,metadata')
    .eq('token_hash', tokenHash)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed.' });

  let payload: WorkflowPayload;
  try {
    payload = (await req.json()) as WorkflowPayload;
  } catch {
    return jsonResponse(400, { ok: false, error: 'Invalid JSON payload.' });
  }

  const action = String(payload.action || '').trim() as WorkflowAction;
  if (!action) return jsonResponse(400, { ok: false, error: 'Missing action.' });

  let supabaseAdmin: any;
  try {
    supabaseAdmin = getSupabaseAdmin();
  } catch (err: any) {
    return jsonResponse(500, { ok: false, error: err?.message || 'Server configuration error.' });
  }

  const ipAddress = requestIp(req);

  try {
    if (action === 'send_claim_email') {
      const email = normalizeEmail(payload.email);
      if (!isValidEmail(email)) {
        return jsonResponse(400, { ok: false, error: 'Invalid email address.' });
      }

      const issued = await issueClaimToken(supabaseAdmin, {
        email,
        playerId: payload.playerId || null,
        createdBy: payload.createdBy || null,
        metadata: {
          source: 'manual-invite',
          playerName: payload.playerName || null,
          teamName: payload.teamName || null,
          seasonName: payload.seasonName || null,
        },
      });
      const claimUrl = buildClaimUrl(req, issued.token);
      await sendClaimEmail(supabaseAdmin, req, {
        email,
        playerName: payload.playerName || null,
        teamName: payload.teamName || null,
        seasonName: payload.seasonName || null,
        claimUrl,
        expiresAt: issued.expiresAt,
      });
      await logClaimEvent(supabaseAdmin, {
        tokenId: issued.tokenId,
        email,
        playerId: payload.playerId || null,
        ipAddress,
        action,
        outcome: 'sent',
      });

      return jsonResponse(200, {
        ok: true,
        sent: true,
        tokenId: issued.tokenId,
        expiresAt: issued.expiresAt,
        claimUrl,
      });
    }

    if (action === 'preview_claim') {
      const limited = await checkRateLimit(supabaseAdmin, ipAddress);
      if (limited) {
        return jsonResponse(429, {
          ok: false,
          error: 'Too many attempts. Please wait and try again later.',
        });
      }

      const token = String(payload.token || '').trim();
      if (!token) {
        return jsonResponse(400, {
          ok: false,
          status: 'invalid',
          error: 'Invalid or expired claim link.',
        });
      }

      const tokenRow = await findTokenRow(supabaseAdmin, token);
      if (!tokenRow || tokenRow.revoked_at) {
        await logClaimEvent(supabaseAdmin, {
          ipAddress,
          action,
          outcome: 'invalid-token',
        });
        return jsonResponse(200, {
          ok: true,
          status: 'invalid',
          message: 'This claim link is invalid or no longer available.',
        });
      }

      if (tokenRow.used_at) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email: tokenRow.email,
          playerId: tokenRow.player_id,
          ipAddress,
          action,
          outcome: 'already-claimed',
        });
        return jsonResponse(200, {
          ok: true,
          status: 'already_claimed',
          message: 'This profile has already been claimed. If this is incorrect, contact support.',
        });
      }

      const expired = new Date(tokenRow.expires_at).getTime() < Date.now();
      if (expired) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email: tokenRow.email,
          playerId: tokenRow.player_id,
          ipAddress,
          action,
          outcome: 'expired',
        });
        return jsonResponse(200, {
          ok: true,
          status: 'expired',
          message: 'This claim link has expired.',
        });
      }

      const email = normalizeEmail(tokenRow.email);
      const profiles = await queryPlayersByEmail(supabaseAdmin, email);
      if (!profiles.length) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email,
          ipAddress,
          action,
          outcome: 'no-profile',
        });
        return jsonResponse(200, {
          ok: true,
          status: 'invalid',
          message: 'This claim link is invalid or no longer available.',
        });
      }

      const claimableProfiles = profiles.filter((p) => !p.userId);
      const status = claimableProfiles.length ? 'ready' : 'already_claimed';
      await logClaimEvent(supabaseAdmin, {
        tokenId: tokenRow.id,
        email,
        playerId: tokenRow.player_id,
        ipAddress,
        action,
        outcome: status === 'ready' ? 'preview-ok' : 'already-claimed',
        details: { profileCount: profiles.length, claimableCount: claimableProfiles.length },
      });

      return jsonResponse(200, {
        ok: true,
        status,
        emailMasked: maskEmail(email),
        expiresAt: tokenRow.expires_at,
        profiles: profiles.map((p: any) => ({
          id: p.id,
          fullName: p.fullName,
          teamName: p.teamName,
          seasonLabel: p.seasonLabel,
          division: p.division,
          claimed: Boolean(p.userId),
          preferred: tokenRow.player_id ? String(tokenRow.player_id) === String(p.id) : false,
        })),
        message:
          status === 'already_claimed'
            ? 'This profile has already been claimed. If this is incorrect, contact support.'
            : undefined,
      });
    }

    if (action === 'confirm_claim') {
      const limited = await checkRateLimit(supabaseAdmin, ipAddress);
      if (limited) {
        return jsonResponse(429, {
          ok: false,
          error: 'Too many attempts. Please wait and try again later.',
        });
      }

      const token = String(payload.token || '').trim();
      const password = String(payload.password || '');
      if (!token) return jsonResponse(400, { ok: false, error: 'Missing claim token.' });
      if (!isStrongPassword(password)) {
        return jsonResponse(400, {
          ok: false,
          error: 'Password must be at least 8 characters with at least one number and one special character.',
        });
      }

      const tokenRow = await findTokenRow(supabaseAdmin, token);
      if (!tokenRow || tokenRow.revoked_at) {
        await logClaimEvent(supabaseAdmin, {
          ipAddress,
          action,
          outcome: 'invalid-token',
        });
        return jsonResponse(400, { ok: false, status: 'invalid', error: 'Invalid or expired claim link.' });
      }
      if (tokenRow.used_at) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email: tokenRow.email,
          playerId: tokenRow.player_id,
          ipAddress,
          action,
          outcome: 'already-claimed',
        });
        return jsonResponse(400, {
          ok: false,
          status: 'already_claimed',
          error: 'This profile has already been claimed. If this is incorrect, contact support.',
        });
      }
      if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email: tokenRow.email,
          playerId: tokenRow.player_id,
          ipAddress,
          action,
          outcome: 'expired',
        });
        return jsonResponse(400, {
          ok: false,
          status: 'expired',
          error: 'This claim link has expired. Request a new one.',
        });
      }

      const email = normalizeEmail(tokenRow.email);
      const profiles = await queryPlayersByEmail(supabaseAdmin, email);
      if (!profiles.length) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email,
          ipAddress,
          action,
          outcome: 'no-profile',
        });
        return jsonResponse(400, { ok: false, status: 'invalid', error: 'Invalid or expired claim link.' });
      }

      const requestedPlayerId = String(payload.playerId || '').trim();
      let selectedProfile = null as any;
      if (requestedPlayerId) {
        selectedProfile = profiles.find((p: any) => String(p.id) === requestedPlayerId) || null;
      }
      if (!selectedProfile && tokenRow.player_id) {
        selectedProfile = profiles.find((p: any) => String(p.id) === String(tokenRow.player_id)) || null;
      }
      if (!selectedProfile && profiles.length === 1) {
        selectedProfile = profiles[0];
      }
      if (!selectedProfile) {
        return jsonResponse(400, { ok: false, error: 'Please select the correct profile to claim.' });
      }
      if (selectedProfile.userId) {
        await logClaimEvent(supabaseAdmin, {
          tokenId: tokenRow.id,
          email,
          playerId: selectedProfile.id,
          ipAddress,
          action,
          outcome: 'already-claimed-selected',
        });
        return jsonResponse(400, {
          ok: false,
          status: 'already_claimed',
          error: 'This profile has already been claimed. If this is incorrect, contact support.',
        });
      }

      const displayName = selectedProfile.fullName || 'Player';
      let userId = '' as string;
      const existing = await supabaseAdmin.auth.admin.getUserByEmail(email);
      if (!existing.error && existing.data?.user?.id) {
        userId = existing.data.user.id;
        const { error: updateUserErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
          password,
          email_confirm: true,
          user_metadata: {
            ...(existing.data.user.user_metadata || {}),
            full_name: displayName,
          },
        });
        if (updateUserErr) throw updateUserErr;
      } else {
        const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: displayName },
        });
        if (createErr || !created?.user?.id) throw createErr || new Error('Unable to create account.');
        userId = created.user.id;
      }

      const { claimStatus, paymentStatus } = parseTeamPayment(selectedProfile.teamPaymentStatus);
      const claimedAt = new Date().toISOString();
      await safePlayerUpdate(supabaseAdmin, selectedProfile.id, {
        user_id: userId,
        payment_status: paymentStatus,
        claim_status: claimStatus,
        claimed_at: claimedAt,
      });

      await safeProfileUpsert(supabaseAdmin, {
        user_id: userId,
        display_name: displayName,
        email,
        email_address: email,
        payment_status: paymentStatus,
      });

      await supabaseAdmin
        .from('player_claim_tokens')
        .update({
          used_at: claimedAt,
          claimed_player_id: selectedProfile.id,
          claimed_user_id: userId,
        })
        .eq('id', tokenRow.id);

      await logClaimEvent(supabaseAdmin, {
        tokenId: tokenRow.id,
        email,
        playerId: selectedProfile.id,
        ipAddress,
        action,
        outcome: 'claimed',
        details: {
          userId,
          claimStatus,
          paymentStatus,
        },
      });

      return jsonResponse(200, {
        ok: true,
        status: 'claimed',
        email,
        playerId: selectedProfile.id,
        userId,
        claimStatus,
        paymentStatus,
      });
    }

    if (action === 'resend_claim_email') {
      let email = normalizeEmail(payload.email);
      let playerId = payload.playerId || null;
      let playerName = payload.playerName || null;
      let teamName = payload.teamName || null;
      let seasonName = payload.seasonName || null;
      const token = String(payload.token || '').trim();

      if (!email && token) {
        const tokenRow = await findTokenRow(supabaseAdmin, token);
        if (tokenRow?.email) {
          email = normalizeEmail(tokenRow.email);
          if (!playerId && tokenRow.player_id) playerId = String(tokenRow.player_id);
        }
      }

      if (!isValidEmail(email)) {
        return jsonResponse(200, {
          ok: true,
          sent: true,
          message: 'If your record exists, a new claim email has been sent.',
        });
      }

      const profiles = await queryPlayersByEmail(supabaseAdmin, email);
      if (profiles.length) {
        const preferred = profiles.find((p: any) => String(p.id) === String(playerId || '')) || profiles[0];
        playerId = preferred?.id || playerId || null;
        playerName = playerName || preferred?.fullName || null;
        teamName = teamName || preferred?.teamName || null;
        seasonName = seasonName || preferred?.seasonLabel || null;
      }

      const issued = await issueClaimToken(supabaseAdmin, {
        email,
        playerId: playerId || null,
        createdBy: 'self-resend',
        metadata: {
          source: 'resend',
          playerName,
          teamName,
          seasonName,
        },
      });
      const claimUrl = buildClaimUrl(req, issued.token);
      await sendClaimEmail(supabaseAdmin, req, {
        email,
        playerName,
        teamName,
        seasonName,
        claimUrl,
        expiresAt: issued.expiresAt,
      });
      await logClaimEvent(supabaseAdmin, {
        tokenId: issued.tokenId,
        email,
        playerId: playerId || null,
        ipAddress,
        action,
        outcome: 'resent',
      });

      return jsonResponse(200, {
        ok: true,
        sent: true,
        expiresAt: issued.expiresAt,
        message: 'A new claim email has been sent.',
      });
    }

    return jsonResponse(400, { ok: false, error: 'Unsupported action.' });
  } catch (err: any) {
    const message = err?.message || 'Claim workflow request failed.';
    return jsonResponse(500, { ok: false, error: message });
  }
});
