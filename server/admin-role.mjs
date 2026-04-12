#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing Supabase service credentials. Set VITE_SUPABASE_URL and VITE_SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.ADMIN_ROLE_PORT || 3500;

app.post('/admin-role', async (req, res) => {
  const { userId, email } = req.body || {};
  if (!userId && !email) {
    return res.status(400).json({ message: 'Provide userId or email.' });
  }

  try {
    let row = null;
    if (userId) {
      const { data, error } = await supabaseAdmin
        .from('admin_users')
        .select('id,role,email')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    if (!row && email) {
      const { data, error } = await supabaseAdmin
        .from('admin_users')
        .select('id,role,email')
        .ilike('email', email)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    if (!row) {
      return res.json({ role: null });
    }

    // No extra updates required; the admin row's id already matches the auth user.

    return res.json({ role: row.role });
  } catch (err) {
    console.error('Admin role lookup error', err);
    return res.status(500).json({ message: 'Unable to resolve admin role.' });
  }
});

app.listen(PORT, () => {
  console.log(`Admin role proxy listening on http://localhost:${PORT}`);
});
