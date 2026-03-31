#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';

dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SITE_URL = (process.env.VITE_SITE_URL || 'http://localhost:5173').replace(/\/$/, '');
const ADMIN_EMAILS = (process.env.ADMIN_NOTIFICATION_EMAILS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const CURRENCY = (process.env.STRIPE_CURRENCY || 'cad').toLowerCase();
const ALLOWED_COUNTRIES = (process.env.STRIPE_SHIPPING_COUNTRIES || 'CA,US')
  .split(',')
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);
const MERCH_PORT = Number(process.env.MERCH_API_PORT) || 4001;
const DEFAULT_LEAD_DAYS = 14;
const DAY_IN_MS = 1000 * 60 * 60 * 24;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'Courtsight Orders <orders@courtsight.ca>';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
  console.error('Missing required environment variables for the merch server.');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

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
app.use(cors());

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
  `${SITE_URL}${isJersey ? '/jerseys' : '/merch'}?checkout_success=true&session_id={CHECKOUT_SESSION_ID}`;
const buildCancelUrl = (isJersey) => `${SITE_URL}${isJersey ? '/jerseys' : '/merch'}?checkout_canceled=true`;

const sendAdminEmail = async ({ order, items, session }) => {
  if (!ADMIN_EMAILS.length) {
    console.warn('No admin emails configured; skipping notification email.');
    return;
  }
  if (!transporter) {
    console.warn('SMTP transporter not configured; admin notification email skipped.');
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
  if (order.jersey_design_url) {
    bodyLines.push(`Design: ${order.jersey_design_url}`);
  }
  if (order.jersey_team_name) {
    bodyLines.push(`Team: ${order.jersey_team_name}`);
  }
  const body = bodyLines.join('\n');
  await transporter.sendMail({
    from: SMTP_FROM,
    to: ADMIN_EMAILS,
    subject: `New merch order ${order.id}`,
    text: body,
  });
};

const createCheckoutSessionRoute = async (req, res) => {
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
      unitPriceCents: Math.max(0, Number(item.unitPriceCents) || 0),
      name: String(item.name || 'Product'),
      variant: item.variant ? String(item.variant) : null,
      category: String(item.category || 'Accessories'),
      imageUrl: item.imageUrl ? String(item.imageUrl) : null,
    }))
    .filter((item) => item.productId && item.quantity > 0 && item.unitPriceCents > 0);
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
  const totalAmount = normalizedCart.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
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
  } catch (orderInsertError) {
    console.error('Unable to create merch order', orderInsertError);
    return res.status(500).json({ error: 'Unable to create order record.' });
  }

  try {
    await supabaseAdmin.from('merch_order_items').insert(
      normalizedCart.map((item) => ({
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
  } catch (itemInsertError) {
    console.error('Unable to insert order items', itemInsertError);
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
    shipping_name: shipping.name,
    shipping_email: shipping.email,
    shipping_city: shipping.city,
    ...(shipping.phone ? { shipping_phone: shipping.phone } : {}),
    ...(jersey?.teamName ? { jersey_team_name: jersey.teamName } : {}),
    ...(jersey?.contactName ? { jersey_contact_name: jersey.contactName } : {}),
    ...(jersey?.designUrl ? { jersey_design_url: jersey.designUrl } : {}),
  };

  const lineItems = normalizedCart.map((item) => ({
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
  } catch (stripeError) {
    console.error('Unable to create Stripe session', stripeError);
    return res.status(500).json({ error: 'Unable to initialize Stripe checkout.' });
  }
};

const webhookHandler = async (event) => {
  if (event.type !== 'checkout.session.completed') {
    return;
  }
  const session = event.data.object;
  const orderId = session.metadata?.order_id;
  if (!orderId) {
    console.warn('Stripe session missing order id metadata');
    return;
  }
  const { data: existingOrder } = await supabaseAdmin
    .from('merch_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (!existingOrder) {
    console.warn('Order not found for webhook', orderId);
    return;
  }
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
  } catch (notifyError) {
    console.warn('Unable to insert notification', notifyError);
  }
  try {
    await sendAdminEmail({ order: existingOrder, items: items || [], session });
  } catch (emailError) {
    console.warn('Failed to send admin email', emailError);
  }
};

app.post('/api/merch/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature validation failed', err);
    return res.status(400).send(`Webhook Error: ${(err).message}`);
  }
  await webhookHandler(event);
  return res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));
app.post('/api/merch/create-checkout-session', createCheckoutSessionRoute);

app.listen(MERCH_PORT, () => {
  console.log(`Merch payment server listening on http://localhost:${MERCH_PORT}`);
});
