import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Every subscription now has exactly two line items:
//  1. STRIPE_PLATFORM_PRICE_ID  - flat $4/mo recurring price. Required for
//     everyone, BYOC or not, since it's the fee for using the app itself.
//  2. STRIPE_SMS_METERED_PRICE_ID - a metered/usage-based price. Stripe only
//     bills for units actually reported via usage records, and send-sms.js /
//     cron-dispatcher.js only report usage for accounts on the built-in
//     ('system') gateway — so BYOC accounts accrue $0 on this line item.
//
// NOTE: metered prices must NOT include a `quantity` in the Checkout line
// item — Stripe computes that from usage records after the fact.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId } = req.body;

  if (!process.env.STRIPE_PLATFORM_PRICE_ID || !process.env.STRIPE_SMS_METERED_PRICE_ID) {
    return res.status(500).json({
      error: 'Missing STRIPE_PLATFORM_PRICE_ID or STRIPE_SMS_METERED_PRICE_ID in Vercel Environment Variables.'
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        { price: process.env.STRIPE_PLATFORM_PRICE_ID, quantity: 1 },
        { price: process.env.STRIPE_SMS_METERED_PRICE_ID },
      ],
      metadata: {
        userId: userId,
      },
      success_url: `https://app.itstime2.net/dashboard?payment=success`,
      cancel_url: `https://itstime2.net/pricing`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
