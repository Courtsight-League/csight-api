# csight-api

Express backend for Courtsight.

Deployment notes:

- Deploy this as its own Vercel project with the root directory set to `csight-api`
- Vercel Express detection uses the root-level `server.mjs`
- Set a custom domain such as `https://api.courtsight.ca` and point the frontend `VITE_API_BASE_URL` at it

Required production env vars:

- `PUBLIC_SITE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Conditionally required env vars:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `ADMIN_NOTIFICATION_EMAILS`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`
