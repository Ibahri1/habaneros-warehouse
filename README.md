# Habaneros Warehouse Ordering

A mobile-first browser application for store ordering and warehouse fulfillment. It has no prices, checkout, payments, tax, or store-level inventory. The repository contains only the website, Supabase migration, and setup placeholders; it is not connected or deployed.

## Architecture and PIN security

Managers and warehouse staff use 4-digit database-managed codes. The browser first obtains a Supabase anonymous Auth session (no email/password), then sends the code to `api.login_with_pin`. Postgres verifies a `pgcrypto` one-way hash and binds that anonymous `auth.uid()` to the matching `app_users` row. RLS then limits managers to their own orders and grants fulfillment/admin capabilities by database role.

PINs are never returned by the API and cannot be viewed after creation. Admins reset them by replacing the hash. The publishable key is safe for browser use with RLS; never put a secret/service-role key in this project. Enable CAPTCHA/Turnstile and review the anonymous sign-in rate limit before production use.

## 1. Create Supabase manually

1. Create a new project at Supabase and save its project URL and publishable key.
2. In **Authentication → Providers → Anonymous**, enable anonymous sign-ins.
3. In **Database → Extensions**, confirm `pgcrypto` is available (the migration also enables it).
4. Do not add a service-role key to the browser environment.

## 2. Run the migration manually

Open **SQL Editor**, paste the complete contents of `supabase/migrations/20260811000100_initial_warehouse_schema.sql`, and run it once. The migration creates tables, indexes, transaction-safe inventory RPCs, RLS policies, grants, and audit logs.

If your project restricts Data API schemas, expose both `public` and `api` under **Settings → API → Exposed schemas**. Keep `private` unexposed.

## 3. Add the first administrator code

Run this in the Supabase SQL Editor, replacing the name and PIN. This is intentionally manual and does not create demo credentials:

```sql
insert into public.app_users (display_name, role, pin_hash)
values ('Your Name', 'admin', crypt('9876', gen_salt('bf', 12)));
```

After signing in once, the browser session is bound to that user. To intentionally reset a user for a new device and choose a new PIN:

```sql
update public.app_users
set auth_user_id = null,
    pin_hash = crypt('NEW4', gen_salt('bf', 12)),
    updated_at = now()
where id = 'USER_UUID';
```

Use the admin website thereafter to add active locations first, then managers (a manager requires a location), categories, products, and inventory.

## 4. Configure the website

Copy `.env.example` to `.env.local` and fill in only these public values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
```

The checked-in interface contains removable local sample state for visual/workflow testing. The production data adapter is in `lib/supabase.ts`; connect each screen action to the provided tables/RPCs after applying your project values. Do not ship the local sample arrays in `app/warehouse-app.tsx` once real data loading is enabled.

## 5. Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the printed local URL in any normal mobile or desktop browser. For the local visual workflow, any 4 digits log in; a code beginning with `9` opens the admin side. This local-only behavior is clearly isolated in the `login()` function and must be replaced with `loginWithPin()` before production. It does not block real Supabase setup.

Run validation with:

```bash
npm test
npm run lint
```

## Inventory behavior

- `warehouse_inventory.available` is generated as `on_hand - reserved`.
- `api.submit_warehouse_order` locks inventory rows and reserves requested quantities atomically.
- `api.set_order_status` delivers or cancels an order atomically. Delivery reduces On Hand and Reserved; cancellation releases Reserved.
- `api.change_inventory` requires a non-empty reason and logs every receipt/adjustment.
- Database constraints prevent negative stock and Reserved greater than On Hand.
- All received, adjusted, reserved, delivered, cancelled, and shortage actions are modeled in the movement log.

## Later: your own GitHub repository

When ready, create an empty GitHub repository yourself. This local folder is already initialized for source control by the website scaffold, but has no remote. Then run:

```bash
git add .
git commit -m "Initial Habaneros warehouse ordering website"
git branch -M main
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

No GitHub repository or remote was created by this build.

## Later: deploy and connect a domain

Choose a web host that supports this Vinext/Vite build, import your repository, add the two public environment variables, and run `npm run build`. After the first hosted build works, add your domain in that host’s dashboard and copy its DNS records to your domain provider. Configure HTTPS and test manager/admin RLS with real accounts before opening access.

No Supabase project, deployment, hosting configuration, DNS record, or custom domain was created by this build.
