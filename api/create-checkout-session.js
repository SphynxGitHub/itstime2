import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, planTier, autoUpgrade } = req.body;

  const priceMap = {
    trial: process.env.STRIPE_TRIAL_PRICE_ID,
    starter: process.env.STRIPE_STARTER_PRICE_ID,
    pro: process.env.STRIPE_PRO_PRICE_ID,
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceMap[planTier], quantity: 1 }],
      metadata: {
        userId: userId,
        planTier: planTier,
        autoUpgrade: autoUpgrade ? 'true' : 'false',
      },
      success_url: `https://app.itstime2.net/dashboard?payment=success`,
      cancel_url: `https://itstime2.net/pricing`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
