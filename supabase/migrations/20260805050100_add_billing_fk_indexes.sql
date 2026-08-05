-- Add missing indexes on billing foreign keys.
-- These speed up ON DELETE CASCADE / SET NULL when auth.users rows are removed,
-- and also help any user_id-based audit lookups.
-- Refs: Supabase advisor "FK missing index" warning. Safe to deploy with traffic.

-- provider_subscriptions.user_id  -> auth.users(id) ON DELETE CASCADE
CREATE INDEX IF NOT EXISTS provider_subscriptions_user_id_idx
  ON public.provider_subscriptions (user_id);

-- billing_events.user_id  -> auth.users(id) ON DELETE SET NULL
-- billing_events grows unbounded (one row per webhook event), so this is the
-- highest-priority index of the three.
CREATE INDEX IF NOT EXISTS billing_events_user_id_idx
  ON public.billing_events (user_id);

-- billing_checkout_attempts.user_id -> auth.users(id) ON DELETE CASCADE
-- A partial unique index already exists for status IN ('creating','open') but
-- it cannot serve cascading deletes that affect all statuses. Add a plain
-- btree index on user_id.
CREATE INDEX IF NOT EXISTS billing_checkout_attempts_user_id_idx
  ON public.billing_checkout_attempts (user_id);
