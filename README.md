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
- Adjustments cannot reduce On Hand below Reserved.
- Every stock change and reversal creates a balancing inventory movement record, preventing repeated corrections from duplicating the net inventory effect.

## Fulfillment history and product images

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
