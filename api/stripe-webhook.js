import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

// Both lazily constructed — a missing env var here shouldn't crash the
// whole module before Vercel can even route the request (which produces
// Vercel's generic non-JSON "A server error has occurred" page instead of
// anything useful).
let stripe = null;
function getStripe() {
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

let supabase = null;
function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

export const config = {
  api: { bodyParser: false }, // Disables body parsing so Stripe can verify raw signature
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 1. Checkout completed -> subscription is now active.
  //    NOTE: this previously wrote to a `customers` table that nothing else
  //    in the app reads from or writes to — that meant a completed checkout
  //    never actually activated anything. Fixed to write to `practices`,
  //    which is what send-sms.js, cron-dispatcher.js, and the app UI all use.
  //
  //    Usage-based billing now reports against stripe_customer_id via
  //    Stripe's Billing Meters API (see send-sms.js), not a specific
  //    subscription item — the old subscription-item lookup that used to
  //    live here has been removed since it relied on the now-removed
  //    legacy usage records API.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;

    await getSupabase().from('practices').update({
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      plan_tier: 'active',
      subscribed_at: new Date().toISOString(),
    }).eq('user_id', userId);
  }

  // 2. Monthly renewal invoice paid -> reset the usage counter shown in the
  //    UI. This is purely a display counter now (System-gateway overage is
  //    billed automatically via Stripe's metered usage records, not by this
  //    counter), but it's still useful to show "X sent this billing period."
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    await getSupabase().from('practices').update({
      sms_sent_this_month: 0,
    }).eq('stripe_customer_id', invoice.customer);
  }

  // 3. Subscription canceled or payment ultimately failed -> block sending
  //    until they resubscribe. Without this, a canceled account would stay
  //    marked 'active' forever since nothing else updates plan_tier back.
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await getSupabase().from('practices').update({
      plan_tier: 'canceled',
    }).eq('stripe_customer_id', subscription.customer);
  }

  res.status(200).json({ received: true });
}
