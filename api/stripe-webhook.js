import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { buffer } from 'micro';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false }, // Disables body parsing so Stripe can verify raw signature
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 1. Initial Checkout Completed -> Activate Subscription & Link Stripe IDs
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const planTier = session.metadata.planTier || 'trial';

    const limits = { trial: 100, starter: 1000, pro: 5000 };

    await supabase.from('customers').update({
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      plan_tier: planTier,
      sms_limit: limits[planTier] || 100,
      auto_upgrade_enabled: session.metadata.autoUpgrade === 'true',
    }).eq('user_id', userId);
  }

  // 2. Monthly Renewal -> Reset SMS count to 0
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    await supabase.from('customers').update({
      sms_sent_this_month: 0,
    }).eq('stripe_customer_id', invoice.customer);
  }

  res.status(200).json({ received: true });
}
