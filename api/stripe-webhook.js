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

  // 1. Checkout completed -> subscription is now active.
  //    NOTE: this previously wrote to a `customers` table that nothing else
  //    in the app reads from or writes to — that meant a completed checkout
  //    never actually activated anything. Fixed to write to `practices`,
  //    which is what send-sms.js, cron-dispatcher.js, and the app UI all use.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;

    // Retrieve the full subscription so we can find the metered line item's
    // subscription_item id — usage records get reported against that id,
    // not the subscription itself.
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    const meteredItem = subscription.items.data.find(
      (item) => item.price.id === process.env.STRIPE_SMS_METERED_PRICE_ID
    );

    await supabase.from('practices').update({
      stripe_customer_id: session.customer,
      stripe_subscription_id: session.subscription,
      stripe_metered_subscription_item_id: meteredItem ? meteredItem.id : null,
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
    await supabase.from('practices').update({
      sms_sent_this_month: 0,
    }).eq('stripe_customer_id', invoice.customer);
  }

  // 3. Subscription canceled or payment ultimately failed -> block sending
  //    until they resubscribe. Without this, a canceled account would stay
  //    marked 'active' forever since nothing else updates plan_tier back.
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await supabase.from('practices').update({
      plan_tier: 'canceled',
    }).eq('stripe_customer_id', subscription.customer);
  }

  res.status(200).json({ received: true });
}
