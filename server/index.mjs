#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: new URL('../.env.local', import.meta.url) });

const PORT = Number(process.env.PORT || process.env.API_PORT || 4000);
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ADMIN_EMAILS = (process.env.ADMIN_NOTIFICATION_EMAILS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || `${PUBLIC_SITE_URL},http://localhost:3000,http://127.0.0.1:3000`)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const CURRENCY = (process.env.STRIPE_CURRENCY || 'cad').toLowerCase();
const ALLOWED_COUNTRIES = (process.env.STRIPE_SHIPPING_COUNTRIES || 'CA,US')
  .split(',')
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);
const DEFAULT_LEAD_DAYS = 14;
const DAY_IN_MS = 1000 * 60 * 60 * 24;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase API environment variables. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  process.exit(1);
}

const SUPABASE_HOSTNAME = new URL(SUPABASE_URL).hostname;
const ALLOWED_IMAGE_PROXY_HOSTS = (
  process.env.ALLOWED_IMAGE_PROXY_HOSTS ||
  `${SUPABASE_HOSTNAME},ui-avatars.com,lh3.googleusercontent.com,images.unsplash.com`
)
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const stripe =
  STRIPE_SECRET_KEY
    ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' })
    : null;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'Courtsight Orders <orders@courtsight.ca>';

const transporter =
  SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS,
        },
      })
    : null;

const formatCurrency = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
});

const app = express();
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed.'));
  },
  credentials: true,
}));

const SAFE_SUPABASE_PATHS = [
  /^\/auth\/v1\//,
  /^\/rest\/v1\//,
  /^\/storage\/v1\//,
  /^\/functions\/v1\//,
];

const SAFE_SUPABASE_HEADERS = new Set([
  'accept',
  'accept-language',
  'apikey',
  'authorization',
  'cache-control',
  'content-profile',
  'content-type',
  'if-match',
  'if-none-match',
  'prefer',
  'range',
  'x-client-info',
]);

const toForwardHeaders = (headers) => {
  const nextHeaders = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (!value) continue;
    const normalized = key.toLowerCase();
    if (
      normalized === 'host' ||
      normalized === 'connection' ||
      normalized === 'upgrade' ||
      normalized === 'content-length' ||
      normalized === 'accept-encoding'
    ) {
      continue;
    }
    if (!SAFE_SUPABASE_HEADERS.has(normalized)) {
      continue;
    }
    nextHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return nextHeaders;
};

const pipeUpstreamResponse = async (upstream, res) => {
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding' || key.toLowerCase() === 'transfer-encoding') {
      return;
    }
    res.setHeader(key, value);
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  return res.end(body);
};

app.use('/supabase', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const upstreamPath = req.originalUrl.replace(/^\/supabase/, '') || '/';
    const isAllowedPath = SAFE_SUPABASE_PATHS.some((pattern) => pattern.test(upstreamPath));
    if (!isAllowedPath) {
      return res.status(403).json({ error: 'Supabase proxy path not allowed.' });
    }
    if (!req.headers.apikey && !req.headers.authorization) {
      return res.status(401).json({ error: 'Missing Supabase auth headers.' });
    }
    const upstreamUrl = new URL(upstreamPath, SUPABASE_URL);
    const method = req.method.toUpperCase();
    const headers = toForwardHeaders(req.headers);
    const init = {
      method,
      headers,
      redirect: 'manual',
    };

    if (!['GET', 'HEAD'].includes(method)) {
      init.body = req.body?.length ? req.body : undefined;
    }

    const upstream = await fetch(upstreamUrl, init);
    return await pipeUpstreamResponse(upstream, res);
  } catch (error) {
    console.error('Supabase proxy error', error);
    return res.status(502).json({ error: 'Supabase proxy request failed.' });
  }
});

const createUserClientFromAuthHeader = (authHeader) => {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};

const requireAdmin = (minimumRole = 'any') => async (req, res, next) => {
  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin backend is not configured.' });
    }
    const userClient = createUserClientFromAuthHeader(req.headers.authorization);
    if (!userClient) {
      return res.status(401).json({ error: 'Missing bearer token.' });
    }

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid session.' });
    }

    const authUser = userData.user;
    const normalizedEmail = String(authUser.email || '').trim();
    let query = supabaseAdmin
      .from('admin_users')
      .select('id, role, email')
      .eq('id', authUser.id)
      .maybeSingle();
    let { data: adminRow, error: adminError } = await query;
    if (adminError) throw adminError;

    if (!adminRow && normalizedEmail) {
      const emailLookup = await supabaseAdmin
        .from('admin_users')
        .select('id, role, email')
        .ilike('email', normalizedEmail)
        .maybeSingle();
      if (emailLookup.error) throw emailLookup.error;
      adminRow = emailLookup.data;
    }

    if (!adminRow) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    if (minimumRole === 'full' && String(adminRow.role || '').toUpperCase() !== 'ADMIN_FULL') {
      return res.status(403).json({ error: 'Full admin access required.' });
    }

    req.adminUser = authUser;
    req.adminRole = adminRow.role;
    return next();
  } catch (error) {
    console.error('Admin auth error', error);
    return res.status(500).json({ error: 'Unable to validate admin session.' });
  }
};

const normalizeRemoteUrl = (source) => {
  let remoteUrl;
  try {
    remoteUrl = new URL(source);
  } catch {
    return null;
  }
  if (remoteUrl.protocol !== 'http:' && remoteUrl.protocol !== 'https:') {
    return null;
  }
  return remoteUrl;
};

const isPrivateIpAddress = (ip) => {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return true;
};

const isAllowedAvatarHost = async (hostname) => {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized || !ALLOWED_IMAGE_PROXY_HOSTS.includes(normalized)) {
    return false;
  }

  if (net.isIP(normalized)) {
    return !isPrivateIpAddress(normalized);
  }

  try {
    const records = await dns.lookup(normalized, { all: true });
    return records.length > 0 && records.every((record) => !isPrivateIpAddress(record.address));
  } catch {
    return false;
  }
};

const resolveProductUnitPriceCents = (product) => {
  const cents = Number(product?.price_cents ?? product?.unit_price_cents ?? product?.unitPriceCents);
  if (Number.isFinite(cents) && cents > 0) {
    return Math.round(cents);
  }
  const dollars = Number(product?.price ?? product?.unit_price ?? product?.unitPrice);
  if (Number.isFinite(dollars) && dollars > 0) {
    return Math.round(dollars * 100);
  }
  return 0;
};

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/avatar-proxy', async (req, res) => {
  try {
    const source = Array.isArray(req.query.src) ? req.query.src[0] : req.query.src;
    if (!source || typeof source !== 'string') {
      return res.status(400).json({ error: 'Missing src query parameter' });
    }

    const remoteUrl = normalizeRemoteUrl(source);
    if (!remoteUrl) {
      return res.status(400).json({ error: 'Invalid src URL' });
    }
    if (!(await isAllowedAvatarHost(remoteUrl.hostname))) {
      return res.status(403).json({ error: 'Avatar source host not allowed.' });
    }

    const upstream = await fetch(remoteUrl.toString(), {
      redirect: 'follow',
      headers: {
        Accept: 'image/*,*/*;q=0.8',
        'User-Agent': 'courtsight-avatar-proxy',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream request failed (${upstream.status})` });
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(415).json({ error: 'Avatar proxy only supports image responses.' });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.end(body);
  } catch (error) {
    console.error('Avatar proxy error', error);
    return res.status(500).json({ error: 'Avatar proxy error' });
  }
});

app.post('/admin-role', requireAdmin(), async (req, res) => {
  const { userId, email } = req.body || {};
  if (!userId && !email) {
    return res.status(400).json({ message: 'Provide userId or email.' });
  }

  try {
    let row = null;
    if (userId) {
      const { data, error } = await supabaseAdmin
        .from('admin_users')
        .select('id, role, email')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    if (!row && email) {
      const { data, error } = await supabaseAdmin
        .from('admin_users')
        .select('id, role, email')
        .ilike('email', email)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    return res.json({ role: row?.role ?? null });
  } catch (error) {
    console.error('Admin role lookup error', error);
    return res.status(500).json({ message: 'Unable to resolve admin role.' });
  }
});

app.post('/admin/auth/create-user', requireAdmin('full'), async (req, res) => {
  try {
    const { email, password, email_confirm, user_metadata, app_metadata } = req.body || {};
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm,
      user_metadata,
      app_metadata,
    });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('Create admin user error', error);
    return res.status(500).json({ error: 'Unable to create user.' });
  }
});

app.post('/admin/auth/invite-user', requireAdmin('full'), async (req, res) => {
  try {
    const { email, redirectTo, data: metadata } = req.body || {};
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: metadata,
    });
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('Invite admin user error', error);
    return res.status(500).json({ error: 'Unable to invite user.' });
  }
});

app.get('/admin/auth/user-by-email', requireAdmin(), async (req, res) => {
  try {
    const email = String(req.query.email || '').trim();
    if (!email) {
      return res.status(400).json({ error: 'Missing email.' });
    }
    const { data, error } = await supabaseAdmin.auth.admin.getUserByEmail(email);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('Get user by email error', error);
    return res.status(500).json({ error: 'Unable to load user.' });
  }
});

app.get('/admin/auth/user-by-id/:userId', requireAdmin(), async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'Missing user id.' });
    }
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    return res.json(data);
  } catch (error) {
    console.error('Get user by id error', error);
    return res.status(500).json({ error: 'Unable to load user.' });
  }
});

app.post('/admin-users', express.json({ limit: '2mb' }), requireAdmin('full'), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const displayName = String(req.body?.displayName || '').trim() || email;
    const role = String(req.body?.role || '').trim();

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    if (!role) {
      return res.status(400).json({ error: 'Role is required.' });
    }

    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
    let tempPassword = '';
    for (let i = 0; i < 14; i += 1) {
      tempPassword += charset[Math.floor(Math.random() * charset.length)];
    }

    let userId = null;
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
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserByEmail(email);
        userId = authUser?.user?.id || null;
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
        return res.status(400).json({ error: createErr.message });
      }
      userId = created?.user?.id ?? null;
      createdNewUser = true;
    }

    if (createdNewUser) {
      const redirectTo = `${PUBLIC_SITE_URL}/auth/callback?next=/reset-password`;
      const { error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        redirectTo,
      });
      if (inviteErr) {
        return res.status(400).json({ error: inviteErr.message });
      }
    }

    const { data: existingAdmin, error: existingAdminErr } = await supabaseAdmin
      .from('admin_users')
      .select('id,user_id')
      .ilike('email', email)
      .limit(1)
      .maybeSingle();
    if (existingAdminErr) {
      return res.status(400).json({ error: existingAdminErr.message });
    }

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
        return res.status(400).json({ error: adminUpdateErr.message });
      }
    } else {
      const { error: adminInsertErr } = await supabaseAdmin.from('admin_users').insert({
        user_id: userId,
        email,
        display_name: displayName,
        role,
      });
      if (adminInsertErr) {
        return res.status(400).json({ error: adminInsertErr.message });
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
        return res.status(400).json({ error: profileErr.message });
      }
    }

    return res.json({
      email,
      tempPassword: createdNewUser ? tempPassword : '',
      userId,
      createdNewUser,
      message: createdNewUser
        ? `A confirmation email with the invite link has been sent to ${email}.`
        : `${email} already has an account and was added as an admin.`,
    });
  } catch (error) {
    console.error('Create admin user via API error', error);
    return res.status(500).json({ error: 'Failed to create admin user.' });
  }
});

const requiredShippingFields = [
  'name',
  'addressLine1',
  'city',
  'province',
  'postalCode',
  'country',
  'email',
];

const buildSuccessUrl = (isJersey) =>
  `${PUBLIC_SITE_URL}${isJersey ? '/jerseys' : '/merch'}?checkout_success=true&session_id={CHECKOUT_SESSION_ID}`;
const buildCancelUrl = (isJersey) =>
  `${PUBLIC_SITE_URL}${isJersey ? '/jerseys' : '/merch'}?checkout_canceled=true`;

const sendAdminEmail = async ({ order, items, session }) => {
  if (!ADMIN_EMAILS.length || !transporter) {
    return;
  }

  const totalCents =
    order?.total_amount ||
    (items || []).reduce((sum, item) => sum + (item.unit_price_cents || 0) * (item.quantity || 0), 0);
  const summaryItems = (items || [])
    .map((item) =>
      `${item.product_name} ${item.variant ? `(${item.variant}) ` : ''}x${item.quantity} · ${formatCurrency(
        (item.unit_price_cents || 0) / 100
      )}`
    )
    .join('\n');
  const bodyLines = [
    `Order ${order.id}`,
    `Paid ${formatCurrency((totalCents || 0) / 100)} via Stripe (${session.payment_intent || session.id})`,
    `Shipping: ${order.shipping_name} (${order.shipping_email})`,
    `Est. Ready Date: ${order.estimated_ready_date}`,
    'Items:',
    summaryItems,
  ];
  if (order.jersey_design_url) bodyLines.push(`Design: ${order.jersey_design_url}`);
  if (order.jersey_team_name) bodyLines.push(`Team: ${order.jersey_team_name}`);

  await transporter.sendMail({
    from: SMTP_FROM,
    to: ADMIN_EMAILS,
    subject: `New merch order ${order.id}`,
    text: bodyLines.join('\n'),
  });
};

app.post('/api/merch/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!supabaseAdmin || !stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook is not configured.');
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Webhook signature validation failed', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    if (orderId) {
      const { data: existingOrder } = await supabaseAdmin
        .from('merch_orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle();

      if (existingOrder) {
        await supabaseAdmin
          .from('merch_orders')
          .update({
            status: 'paid',
            stripe_payment_reference: session.payment_intent || null,
            paid_at: new Date().toISOString(),
          })
          .eq('id', orderId);

        const { data: items } = await supabaseAdmin.from('merch_order_items').select('*').eq('order_id', orderId);

        try {
          await supabaseAdmin.from('notifications').insert({
            role: 'ADMIN_FULL',
            type: 'merch-order',
            title: `New merch order ${orderId}`,
            body: `${existingOrder.shipping_name} paid ${formatCurrency((existingOrder.total_amount || 0) / 100)}`,
            metadata: { orderId },
            link: '/admin',
          });
        } catch (error) {
          console.warn('Unable to insert notification', error);
        }

        try {
          await sendAdminEmail({ order: existingOrder, items: items || [], session });
        } catch (error) {
          console.warn('Failed to send admin email', error);
        }
      }
    }
  }

  return res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));

app.post('/api/merch/create-checkout-session', async (req, res) => {
  if (!supabaseAdmin || !stripe) {
    return res.status(503).json({ error: 'Stripe checkout is not configured.' });
  }

  const { cart, shipping, userId, jersey } = req.body || {};
  if (!Array.isArray(cart) || !cart.length) {
    return res.status(400).json({ error: 'Cart is empty or missing.' });
  }
  if (!shipping || typeof shipping !== 'object') {
    return res.status(400).json({ error: 'Shipping information is required.' });
  }

  const missingField = requiredShippingFields.find((field) => !shipping[field]?.trim());
  if (missingField) {
    return res.status(400).json({ error: `Missing shipping field ${missingField}.` });
  }

  const normalizedCart = cart
    .map((item) => ({
      productId: String(item.productId || ''),
      quantity: Math.max(0, Number(item.quantity) || 0),
      name: String(item.name || 'Product'),
      variant: item.variant ? String(item.variant) : null,
      category: String(item.category || 'Accessories'),
      imageUrl: item.imageUrl ? String(item.imageUrl) : null,
    }))
    .filter((item) => item.productId && item.quantity > 0);

  if (!normalizedCart.length) {
    return res.status(400).json({ error: 'Cart items are invalid.' });
  }

  const productIds = Array.from(new Set(normalizedCart.map((item) => item.productId)));
  const { data: storedProducts, error: fetchError } = await supabaseAdmin
    .from('merch_products')
    .select('*')
    .in('id', productIds);
  if (fetchError) {
    console.error('Failed to load merch products', fetchError.message);
    return res.status(500).json({ error: 'Unable to validate merch inventory.' });
  }

  const productMap = new Map((storedProducts || []).map((product) => [product.id, product]));
  const requiredQuantities = new Map();
  normalizedCart.forEach((item) => {
    const current = requiredQuantities.get(item.productId) || 0;
    requiredQuantities.set(item.productId, current + item.quantity);
  });

  for (const [productId, needed] of requiredQuantities.entries()) {
    const product = productMap.get(productId);
    if (!product) {
      return res.status(400).json({ error: `Product ${productId} is not configured.` });
    }
    const available = Number(product.available_quantity ?? product.availableQuantity ?? 0);
    if (available < needed) {
      return res.status(400).json({ error: `Not enough inventory for ${product.name}.` });
    }
  }

  const pricedCart = normalizedCart.map((item) => {
    const product = productMap.get(item.productId);
    const unitPriceCents = resolveProductUnitPriceCents(product);
    return {
      ...item,
      unitPriceCents,
      name: String(product?.name || item.name || 'Product'),
      category: String(product?.category || item.category || 'Accessories'),
      imageUrl: String(product?.image_url || product?.imageUrl || item.imageUrl || ''),
    };
  });

  if (pricedCart.some((item) => item.unitPriceCents <= 0)) {
    return res.status(400).json({ error: 'One or more products have invalid pricing.' });
  }

  const totalAmount = pricedCart.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (totalAmount <= 0) {
    return res.status(400).json({ error: 'Invalid cart pricing.' });
  }

  const leadTimeDays = Math.max(
    DEFAULT_LEAD_DAYS,
    ...(storedProducts || []).map((product) =>
      Number(product.lead_time_days ?? product.leadTimeDays ?? DEFAULT_LEAD_DAYS)
    )
  );
  const orderId = randomUUID();
  const estimatedReadyDate = new Date(Date.now() + leadTimeDays * DAY_IN_MS).toISOString();

  try {
    const { error: orderError } = await supabaseAdmin.from('merch_orders').insert({
      id: orderId,
      user_id: userId || null,
      status: 'pending',
      total_amount: totalAmount,
      stripe_payment_reference: null,
      stripe_checkout_session_id: null,
      shipping_name: shipping.name,
      shipping_line1: shipping.addressLine1,
      shipping_line2: shipping.addressLine2 || null,
      shipping_city: shipping.city,
      shipping_province: shipping.province,
      shipping_postal: shipping.postalCode,
      shipping_country: shipping.country,
      shipping_email: shipping.email,
      shipping_phone: shipping.phone || null,
      lead_time_days: leadTimeDays,
      estimated_ready_date: estimatedReadyDate,
      jersey_team_name: jersey?.teamName || null,
      jersey_contact_name: jersey?.contactName || null,
      jersey_notes: jersey?.notes || null,
      jersey_sizes: jersey ? JSON.stringify(jersey.sizeBreakdown || {}) : null,
      jersey_design_url: jersey?.designUrl || null,
    });
    if (orderError) throw orderError;
  } catch (error) {
    console.error('Unable to create merch order', error);
    return res.status(500).json({ error: 'Unable to create order record.' });
  }

  try {
    await supabaseAdmin.from('merch_order_items').insert(
      pricedCart.map((item) => ({
        order_id: orderId,
        product_id: item.productId,
        quantity: item.quantity,
        unit_price_cents: item.unitPriceCents,
        variant: item.variant,
        product_name: item.name,
        category: item.category,
        image_url: item.imageUrl,
      }))
    );
  } catch (error) {
    console.error('Unable to insert order items', error);
  }

  await Promise.all(
    Array.from(requiredQuantities.entries()).map(([productId, needed]) => {
      const product = productMap.get(productId);
      if (!product) return Promise.resolve();
      const available = Number(product.available_quantity ?? product.availableQuantity ?? 0);
      const remaining = available - needed;
      return supabaseAdmin
        .from('merch_products')
        .update({ available_quantity: Math.max(remaining, 0) })
        .eq('id', productId);
    })
  );

  const metadata = {
    order_id: orderId,
    lead_time_days: String(leadTimeDays),
    ...(jersey?.teamName ? { jersey_team_name: jersey.teamName } : {}),
    ...(jersey?.contactName ? { jersey_contact_name: jersey.contactName } : {}),
    ...(jersey?.designUrl ? { jersey_design_url: jersey.designUrl } : {}),
  };

  const lineItems = pricedCart.map((item) => ({
    price_data: {
      currency: CURRENCY,
      unit_amount: item.unitPriceCents,
      product_data: {
        name: item.name,
        description: item.variant ? `${item.category} • ${item.variant}` : item.category,
        images: item.imageUrl ? [item.imageUrl] : undefined,
      },
    },
    quantity: item.quantity,
  }));

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: buildSuccessUrl(!!jersey),
      cancel_url: buildCancelUrl(!!jersey),
      metadata,
      customer_email: shipping.email,
      shipping_address_collection: {
        allowed_countries: ALLOWED_COUNTRIES.length ? ALLOWED_COUNTRIES : ['CA', 'US'],
      },
    });

    await supabaseAdmin
      .from('merch_orders')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', orderId);

    return res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Unable to create Stripe session', error);
    return res.status(500).json({ error: 'Unable to initialize Stripe checkout.' });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`csight-api listening on http://localhost:${PORT}`);
  });
}

export default app;
