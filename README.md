# Habaneros Warehouse Ordering

A mobile-first manager ordering and warehouse fulfillment application backed by Supabase. Products, categories, locations, users, inventory, orders, statuses, notes, and movement history are saved in the shared warehouse database and are available across devices.

## Supabase project

This build is configured for the **Habaneros Warehouse** project:

```env
NEXT_PUBLIC_SUPABASE_URL=https://ggmnyitasbsndytpbmpl.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_mXRcKC7W76xLwZAuQXLx7w_pRoQ8FVG
```

These are public browser values. Never add a secret or service-role key to this project.

The migration in `supabase/migrations/20260811000100_initial_warehouse_schema.sql` has already been applied to the connected project. It provides hashed PIN login, multi-device sessions, role checks, transactional inventory changes, audit records, and database functions for every application action.

## Required Auth setting

In the Supabase dashboard, open **Authentication -> Providers -> Anonymous** and enable anonymous sign-ins. The browser obtains an anonymous Supabase Auth identity before the database verifies the warehouse PIN.

Supabase recommends CAPTCHA or Cloudflare Turnstile and reviewing anonymous sign-in rate limits before public deployment. The warehouse PIN function also limits failed attempts per anonymous session.

## Initial access codes

- Manager: `1234` (Test Manager, Riverside)
- Fulfillment: `5678`
- Administrator: `9876` (Isaac)

Use **Users & Codes** while signed in as the administrator to replace these test codes, add managers or fulfillment users, assign manager locations, or disable access. PINs are stored only as one-way hashes and cannot be viewed after saving.

## Run locally

Requires Node.js 22.13 or newer.

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. A phone cannot open a computer's `localhost`; cross-device access requires deployment or a local-network development address. Once both devices can open the website, they use the same Supabase data.

## Validation

```powershell
npm.cmd test
npm.cmd run lint
```

## Inventory behavior

- Submitting an order reserves stock atomically.
- Delivering an order reduces On Hand and Reserved.
- Cancelling an order releases Reserved stock.
- Receiving and adjustments immediately update inventory.
- Adjustments cannot reduce On Hand below Reserved.
- Every stock change creates an inventory movement record.

## Security model

Each browser creates its own anonymous Supabase Auth session. A valid PIN maps that session to an application user through `app_user_sessions`, allowing the same manager or fulfiller to work on multiple devices. All data tables have RLS enabled and direct browser table access is revoked. The browser can execute only the warehouse RPC functions, and every privileged function validates the mapped application role before reading or changing data.
