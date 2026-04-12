import { createClient } from '@supabase/supabase-js';

type HeaderValue = string | string[] | undefined;

const readHeader = (headers: Record<string, HeaderValue> | undefined, name: string) => {
  if (!headers) return '';
  const exact = headers[name];
  const lowered = headers[name.toLowerCase()];
  const raw = exact ?? lowered;
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
};

const resolveSiteUrl = (req: any, configuredSiteUrl?: string) => {
  const explicit = String(configuredSiteUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;

  const protocol = readHeader(req?.headers, 'x-forwarded-proto') || 'http';
  const host = readHeader(req?.headers, 'x-forwarded-host') || readHeader(req?.headers, 'host');
  if (host) {
    return `${protocol}://${host}`.replace(/\/+$/, '');
  }

  return 'http://localhost:3000';
};

const readJsonBody = async (req: any) => {
  if (req?.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req?.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  const iteratorFactory = req?.[Symbol.asyncIterator];
  if (!iteratorFactory) {
    return {};
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<unknown>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
};

const buildTempPassword = () => {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
  let password = '';
  for (let i = 0; i < 14; i += 1) {
    password += charset[Math.floor(Math.random() * charset.length)];
  }
  return password;
};

const findAuthUserIdByEmail = async (supabaseAdmin: any, email: string) => {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw error;
    }

    const users = Array.isArray(data?.users) ? data.users : [];
    const matchedUser = users.find(
      (user: any) => String(user?.email || '').trim().toLowerCase() === email
    );
    if (matchedUser?.id) {
      return matchedUser.id as string;
    }

    const lastPage = Number(data?.lastPage || 0);
    if (!users.length || (lastPage && page >= lastPage) || users.length < perPage) {
      return null;
    }

    page += 1;
  }
};

export default async function adminUsers(req: any, res: any) {
  const supabaseUrl = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const serviceKey = String(
    process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
  ).trim();
  const siteUrl = String(process.env.VITE_SITE_URL || process.env.SITE_URL || '').trim();
  const supabaseAdmin =
    supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey) : null;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
    return;
  }

  if (!supabaseAdmin) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Supabase admin credentials are not configured on the server.' }));
    return;
  }

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
    return;
  }

  const payload = body as Record<string, unknown>;
  const email = String(payload.email || '').trim().toLowerCase();
  const displayName = String(payload.displayName || '').trim() || email;
  const role = String(payload.role || '').trim();

  if (!email) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Email is required.' }));
    return;
  }

  if (!role) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Role is required.' }));
    return;
  }

  const tempPassword = buildTempPassword();

  try {
    let userId: string | null = null;
    let createdNewUser = false;

    try {
      const { data: profileByEmail } = await supabaseAdmin
        .from('profiles')
        .select('user_id')
        .ilike('email', email)
        .limit(1)
        .maybeSingle();
      userId = profileByEmail?.user_id || null;
    } catch {}

    if (!userId) {
      try {
        const { data: profileByAltEmail } = await supabaseAdmin
          .from('profiles')
          .select('user_id')
          .ilike('email_address', email)
          .limit(1)
          .maybeSingle();
        userId = profileByAltEmail?.user_id || null;
      } catch {}
    }

    if (!userId) {
      try {
        userId = await findAuthUserIdByEmail(supabaseAdmin, email);
      } catch {}
    }

    if (!userId) {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: false,
        user_metadata: {
          full_name: displayName,
          temporary_password: tempPassword,
        },
      });
      if (createErr) {
        throw createErr;
      }
      userId = created?.user?.id ?? null;
      createdNewUser = true;
    }

    if (createdNewUser) {
      const redirectTo = `${resolveSiteUrl(req, siteUrl)}/auth/callback?next=/reset-password`;
      const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
      });
      if (inviteErr) {
        throw inviteErr;
      }
    }

    const { data: existingAdmin } = await supabaseAdmin
      .from('admin_users')
      .select('id,user_id')
      .ilike('email', email)
      .limit(1)
      .maybeSingle();

    if (existingAdmin?.id) {
      const { error: adminUpdateErr } = await supabaseAdmin
        .from('admin_users')
        .update({
          user_id: userId,
          email,
          display_name: displayName,
          role,
        })
        .eq('id', existingAdmin.id);
      if (adminUpdateErr) {
        throw adminUpdateErr;
      }
    } else {
      const { error: adminInsertErr } = await supabaseAdmin.from('admin_users').insert({
        user_id: userId,
        email,
        display_name: displayName,
        role,
      });
      if (adminInsertErr) {
        throw adminInsertErr;
      }
    }

    if (userId) {
      const { error: profileErr } = await supabaseAdmin.from('profiles').upsert(
        {
          user_id: userId,
          display_name: displayName,
          email,
          email_address: email,
        },
        { onConflict: 'user_id' }
      );
      if (profileErr) {
        throw profileErr;
      }
    }

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        email,
        tempPassword: createdNewUser ? tempPassword : '',
        userId,
        createdNewUser,
        message: createdNewUser
          ? `A confirmation email with the invite link has been sent to ${email}.`
          : `${email} already has an account and was added as an admin.`,
      })
    );
  } catch (error: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error?.message || 'Failed to create admin user.' }));
  }
}
