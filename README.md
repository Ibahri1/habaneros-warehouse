# Habaneros Warehouse Ordering

A mobile-first manager ordering and warehouse fulfillment application backed by Supabase. Products, categories, locations, users, inventory, orders, statuses, notes, and movement history are saved in the shared warehouse database and are available across devices.

## Supabase project

This build is configured for the **Habaneros Warehouse** project:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
```

These are public browser values. Never add a secret or service-role key to this project.

The migrations in `supabase/migrations` provide hashed PIN login, multi-device sessions, role checks, transactional inventory changes, audit records, and database functions for every application action.

## Required upgrade SQL

Run `supabase/migrations/20260812062754_permanent_deletes_images_item_locations.sql` once in the Supabase SQL Editor before publishing this frontend update. It:

- snapshots manager, location, product, SKU, unit-size, and item-location values on orders;
- changes historical foreign keys to `ON DELETE SET NULL` while keeping snapshot text readable;
- adds administrator-only permanent user, product, and location deletion RPCs;
- adds the optional product `item_location` column;
- creates the public `product-images` Storage bucket with a 6 MB image limit;
- grants product-image writes to fulfillment/admin users and image deletion to admins only; and
- updates the app-data and order-submission RPCs to return/store the new fields.

The migration does not delete existing data. A product with inventory reserved by an active order cannot be deleted until that order is delivered or cancelled. Product image files are deleted through the Supabase Storage API after the database deletion succeeds.

Run `supabase/migrations/20260812065358_queue_hidden_delivered_orders.sql` after the migration above. It adds the nullable queue-hidden timestamp/audit user fields and two role-protected RPCs. Fulfillment and administrator users can move delivered orders out of the active queue individually or in bulk without deleting order history.

Run `supabase/migrations/20260812074819_reopen_finalized_orders_and_queue_removal.sql` after the queue-hidden migration. It extends queue removal and Order History to manually removed Cancelled orders, and replaces the order-status RPC so Delivered or Cancelled orders can be corrected safely. The existing RPC name is retained for deployment compatibility.

Run `supabase/migrations/20260813003347_multi_location_managers_bulk_inventory.sql` next. It adds persistent **All locations** access, returns every manager assignment to the employee editor, keeps existing single-location assignments, and adds a role-protected transactional bulk inventory adjustment RPC. Managers marked All locations automatically receive every current and future active location.

## Required Auth setting

In the Supabase dashboard, open **Authentication -> Providers -> Anonymous** and enable anonymous sign-ins. The browser obtains an anonymous Supabase Auth identity before the database verifies the warehouse PIN.

Supabase recommends CAPTCHA or Cloudflare Turnstile and reviewing anonymous sign-in rate limits before public deployment. The warehouse PIN function also limits failed attempts per anonymous session.

## Initial access codes

- Manager: `1234` (Test Manager, Riverside)
- Fulfillment: `5678`
- Administrator: `9876` (Isaac)

Use **Employees & Codes** while signed in as the administrator to replace test codes, add managers or fulfillment users, assign manager locations, reset codes, or permanently delete employees. PINs are stored only as one-way hashes and cannot be viewed after saving.

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
- Reopening a Delivered order restores both On Hand and Reserved.
- Reopening a Cancelled order restores Reserved only when enough stock is still Available; otherwise the correction fails without changing anything.
- Moving between Delivered and Cancelled first reverses the old inventory effect and then applies the new effect in the same transaction.
- Inventory adjustments immediately update inventory.
- One inventory adjustment can apply the same quantity and shared reason to several selected products. The bulk operation is all-or-nothing and writes a separate movement for each product.
- Adjustments cannot reduce On Hand below Reserved.
- Every stock change and reversal creates a balancing inventory movement record, preventing repeated corrections from duplicating the net inventory effect.

## Fulfillment history and product images

- Fulfillment-role navigation is intentionally limited to **Order Queue** and **Order History**; administrators retain the full warehouse toolset.
- **Print picking list** consolidates active queue items by product, totals requested quantities, and includes SKU, category, item location, unit size, and contributing order numbers. Delivered and Cancelled orders are excluded from quantities that still need picking.
- Delivered orders remain in **Order Queue** for 30 days, then appear under **Order History**.
- Fulfillment/admin users can manually move Delivered or Cancelled orders to **Order History**. The order and its items are never deleted.
- Changing a hidden Delivered or Cancelled order to another status clears its queue-hidden fields and returns it to the active queue.
- Product images can be dragged into the product editor or selected from a device camera roll/files app. Images persist in Supabase Storage, not browser storage.
- Selected product images can be repositioned, zoomed, and rotated in a 5:3 crop editor. Applying the crop creates a compact 1200×720 WebP and the Product Preview tab shows the actual catalog-card treatment before saving.
- The optional **Item Location** appears in product administration and fulfillment picking details.
- Deleted users, products, and locations disappear from active screens while old orders retain their saved names and item details.
- The supplied Habanero's Mexican Food logo is stored at `public/assets/habaneros-logo.png` and appears in login, navigation, and printed picking slips.
- Light and dark themes follow the Habaneros Scheduler visual style. The theme choice is stored only as a device preference.

## Security model

Each browser creates its own anonymous Supabase Auth session. A valid PIN maps that session to an application user through `app_user_sessions`, allowing the same manager or fulfiller to work on multiple devices. All data tables have RLS enabled and direct browser table access is revoked. The browser can execute only the warehouse RPC functions, and every privileged function validates the mapped application role before reading or changing data.

## Reorder Reports setup (administrator only)

The `20260919044053_reorder_reports.sql` migration adds nullable per-product reorder thresholds, secure report settings/history, idempotent scheduled claims, recipient delivery records, and administrator-checked RPCs. Apply migrations in timestamp order; this migration must run after `20260919011330_single_product_inventory_adjustment.sql`.

```powershell
supabase.cmd login
supabase.cmd link --project-ref YOUR_PROJECT_REF
supabase.cmd db push
```

The Edge Function generates the PDF server-side and sends one Gmail SMTP message per recipient. Create a local file named `supabase-reorder-secrets.env` (it is ignored by Git), add the following values, and never put them in `.env`, frontend code, GitHub, logs, or screenshots:

```env
WAREHOUSE_GMAIL_USER=your-workspace-account@example.com
WAREHOUSE_GMAIL_APP_PASSWORD=your-16-character-app-password
REORDER_SCHEDULER_SECRET=generate-a-long-random-value
```

Gmail app passwords require 2-Step Verification. Then set and deploy:

```powershell
supabase.cmd secrets set --env-file .\supabase-reorder-secrets.env
supabase.cmd functions deploy reorder-reports --no-verify-jwt --use-api
Remove-Item -LiteralPath .\supabase-reorder-secrets.env
```

`--no-verify-jwt` is intentional: manual calls perform the existing database-backed administrator PIN/role check, while scheduled calls require `REORDER_SCHEDULER_SECRET`. The service-role key remains an automatic Edge Function secret and is never sent to the browser.

In Supabase SQL Editor, store the public function URL and the same scheduler secret in Vault, then create the five-minute dispatcher. The database function sends only during the selected weekday's 2:00–2:09 PM Pacific window, handles daylight-saving time through `America/Los_Angeles`, claims one run per local date, and never backfills missed runs.

```sql
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('THE_SAME_LONG_RANDOM_VALUE', 'reorder_scheduler_secret');

select cron.schedule(
  'warehouse-reorder-reports',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/reorder-reports',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-reorder-scheduler-secret',(select decrypted_secret from vault.decrypted_secrets where name='reorder_scheduler_secret')
    ),
    body := '{"action":"scheduled"}'::jsonb
  );
  $job$
);
```

Use **Reorder Reports → Test Gmail connection** first; it authenticates to SMTP without sending. Then add an email address you are authorized to test, save settings, choose **Generate & Email Now**, inspect the exact PDF snapshot, and use **Confirm & Send**. No email is sent while previewing. SMTP acceptance is recorded per recipient, but acceptance does not guarantee inbox delivery; check Gmail sent mail, recipient spam/quarantine, and the page's report history. Do not run a live test until the mailbox owner has authorized it.

Automatic scheduling starts disabled with no weekdays and no recipients. Set product thresholds individually; blank means excluded, `0` includes only products with zero available, and products qualify when `Available <= threshold`. Inactive or archived products are excluded. Empty reports send a short no-items email without an attachment.

Supabase/Gmail limits and outbound-SMTP availability depend on the current plan and account. Validate the deployed function's execution limits and Gmail Workspace sending limits before production; GitHub Pages only hosts the static frontend and cannot run SMTP or scheduled work. Pushing this repository does not apply migrations, deploy functions, set secrets, or create the cron job.
