const twilio = require('twilio');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, phone, message } = req.body;

  if (!userId || !phone || !message) {
    return res.status(400).json({ error: 'Missing required fields: userId, phone, and message are required.' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ 
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.' 
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Fetch practice gateway configuration for this user
    const { data: practice, error: practiceError } = await supabase
      .from('practices')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (practiceError) {
      return res.status(500).json({ error: `Failed to load practice profile: ${practiceError.message}` });
    }

    const providerType = practice?.provider_type || 'system';
    const planTier = practice?.plan_tier || 'trial';
    const sentCount = practice?.sms_sent_this_month || 0;
    const trialLimit = practice?.sms_limit || 100;

    // -----------------------------------------------------------------
    // SUBSCRIPTION GATING
    // Trial: capped at trialLimit (default 100) regardless of gateway.
    // Active: no cap — 'system' gateway usage is billed as overage instead
    //         (see the usage-record reporting below).
    // Anything else (canceled, etc.): blocked until they resubscribe.
    // -----------------------------------------------------------------
    if (planTier === 'trial') {
      if (sentCount >= trialLimit) {
        return res.status(403).json({
          error: `Your free trial (${trialLimit} texts) is used up. Subscribe for $4/mo to keep sending.`
        });
      }
    } else if (planTier !== 'active') {
      return res.status(403).json({
        error: 'Your subscription is not active. Please update your billing to continue sending.'
      });
    }

    // -----------------------------------------------------------------
    // GATEWAY ROUTING LOGIC
    // -----------------------------------------------------------------

    if (providerType === 'quo') {
      // --- QUO (OPENPHONE) API ROUTE ---
      const quoApiKey = practice?.provider_api_key;
      const quoPhoneNumber = practice?.provider_phone_number;

      if (!quoApiKey || !quoPhoneNumber) {
        return res.status(400).json({ 
          error: 'Quo Gateway selected, but API Key or Phone Number is missing in settings.' 
        });
      }

      const quoRes = await fetch('https://api.openphone.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': quoApiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: message,
          from: quoPhoneNumber,
          to: [phone]
        })
      });

      if (!quoRes.ok) {
        const quoError = await quoRes.text();
        return res.status(500).json({ error: `Quo Dispatch Error: ${quoError}` });
      }

    } else if (providerType === 'telnyx') {
      // --- TELNYX API ROUTE ---
      const telnyxApiKey = practice?.provider_api_key;
      const telnyxPhoneNumber = practice?.provider_phone_number;

      if (!telnyxApiKey || !telnyxPhoneNumber) {
        return res.status(400).json({ 
          error: 'Telnyx Gateway selected, but API Key or Phone Number is missing in settings.' 
        });
      }

      const telnyxRes = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${telnyxApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: message,
          from: telnyxPhoneNumber,
          to: phone
        })
      });

      if (!telnyxRes.ok) {
        const telnyxError = await telnyxRes.text();
        return res.status(500).json({ error: `Telnyx Dispatch Error: ${telnyxError}` });
      }

    } else {
      // --- TWILIO ROUTE (SYSTEM BUILT-IN OR BYOC TWILIO) ---
      const accountSid = practice?.provider_account_sid || process.env.TWILIO_ACCOUNT_SID;
      const authToken = practice?.provider_api_key || process.env.TWILIO_AUTH_TOKEN;
      const sendingNumber = practice?.provider_phone_number || process.env.TWILIO_PHONE_NUMBER;

      if (!accountSid || !authToken || !sendingNumber) {
        return res.status(400).json({ 
          error: 'Twilio Gateway credentials missing in practice settings or server environment.' 
        });
      }

      const client = twilio(accountSid, authToken);
      await client.messages.create({
        body: message,
        from: sendingNumber,
        to: phone
      });
    }

    // 2. Increment monthly usage counter (drives the trial cap and the
    //    "X sent this period" display for everyone, regardless of gateway)
    if (practice) {
      await supabase
        .from('practices')
        .update({ sms_sent_this_month: sentCount + 1 })
        .eq('id', practice.id);
    }

    // 3. Report metered usage to Stripe — ONLY for paid accounts on the
    //    built-in 'system' gateway. BYOC accounts (their own Twilio/Quo/
    //    Telnyx credentials) never generate a usage record, so they're
    //    never charged beyond the flat $4/mo platform fee.
    if (planTier === 'active' && providerType === 'system' && practice.stripe_metered_subscription_item_id) {
      try {
        await stripe.subscriptionItems.createUsageRecord(
          practice.stripe_metered_subscription_item_id,
          { quantity: 1, timestamp: Math.floor(Date.now() / 1000), action: 'increment' }
        );
      } catch (usageErr) {
        // The text already sent successfully — don't fail the request just
        // because billing couldn't be recorded. Log it so it's visible.
        console.error('Failed to report Stripe usage record:', usageErr.message);
      }
    }

    return res.status(200).json({ success: true, message: 'SMS delivered successfully.' });

  } catch (err) {
    console.error('Send SMS Error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
