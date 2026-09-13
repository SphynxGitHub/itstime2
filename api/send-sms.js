const webpush = require('web-push');
const twilio = require('twilio');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Configure VAPID Keys for Web Push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@itstime2.net',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

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
    // STEP A: WEB PUSH DISPATCH ATTEMPT (Push-First)
    // -----------------------------------------------------------------
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      const { data: pushSub } = await supabase
        .from('push_subscriptions')
        .select('subscription')
        .eq('user_id', userId)
        .maybeSingle();

      if (pushSub && pushSub.subscription) {
        try {
          const payload = JSON.stringify({
            title: "It's Time 2 Alert",
            body: message,
            url: '/app'
          });

          await webpush.sendNotification(pushSub.subscription, payload);

          // Return immediately on successful push — bypasses SMS gateways & saves costs
          return res.status(200).json({ 
            success: true, 
            deliveryMethod: 'push', 
            message: 'Push notification delivered successfully.' 
          });
        } catch (pushErr) {
          console.warn(`Web Push failed for user ${userId}, falling back to SMS:`, pushErr.message);
          // If subscription expired/invalid (410 or 404), clean it up from DB
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            await supabase.from('push_subscriptions').delete().eq('user_id', userId);
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // STEP B: GATEWAY ROUTING LOGIC (SMS Fallback)
    // -----------------------------------------------------------------
    const supportedByocProviders = ['twilio', 'quo', 'telnyx', 'ringcentral', 'zoom', 'vonage'];
    if (!supportedByocProviders.includes(providerType)) {
      return res.status(400).json({
        error: 'No SMS gateway is configured yet. Please connect a bring-your-own-carrier provider in Billing settings.'
      });
    }

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

    } else if (providerType === 'ringcentral') {
      // --- RINGCENTRAL API ROUTE ---
      const rcJwt = practice?.provider_api_key;
      const rcPhoneNumber = practice?.provider_phone_number;
      const rcClientId = process.env.RC_CLIENT_ID;
      const rcClientSecret = process.env.RC_CLIENT_SECRET;

      if (!rcJwt || !rcPhoneNumber) {
        return res.status(400).json({
          error: 'RingCentral Gateway selected, but JWT or Phone Number is missing in settings.'
        });
      }
      if (!rcClientId || !rcClientSecret) {
        return res.status(500).json({
          error: 'Missing RC_CLIENT_ID or RC_CLIENT_SECRET in Vercel Environment Variables.'
        });
      }

      const rcTokenRes = await fetch('https://platform.ringcentral.com/restapi/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${rcClientId}:${rcClientSecret}`).toString('base64')
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: rcJwt
        })
      });

      const rcTokenData = await rcTokenRes.json();
      if (!rcTokenRes.ok) {
        return res.status(500).json({ error: `RingCentral Auth Error: ${rcTokenData.error_description || rcTokenData.error}` });
      }

      const rcRes = await fetch('https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${rcTokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: { phoneNumber: rcPhoneNumber },
          to: [{ phoneNumber: phone }],
          text: message
        })
      });

      if (!rcRes.ok) {
        const rcError = await rcRes.text();
        return res.status(500).json({ error: `RingCentral Dispatch Error: ${rcError}` });
      }

    } else if (providerType === 'zoom') {
      // --- ZOOM PHONE API ROUTE ---
      const zoomSidParts = (practice?.provider_account_sid || '').split(':');
      const zoomAccountId = zoomSidParts[0];
      const zoomClientId = zoomSidParts[1];
      const zoomClientSecret = practice?.provider_api_key;
      const zoomPhoneNumber = practice?.provider_phone_number;

      if (!zoomAccountId || !zoomClientId || !zoomClientSecret || !zoomPhoneNumber) {
        return res.status(400).json({
          error: 'Zoom Phone Gateway selected, but Account ID, Client ID, Client Secret, or Phone Number is missing in settings.'
        });
      }

      const zoomTokenRes = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${zoomAccountId}`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64')
        }
      });

      const zoomTokenData = await zoomTokenRes.json();
      if (!zoomTokenRes.ok) {
        return res.status(500).json({ error: `Zoom Auth Error: ${zoomTokenData.reason || zoomTokenData.error}` });
      }

      const zoomRes = await fetch('https://api.zoom.us/v2/phone/sms/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${zoomTokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sender: zoomPhoneNumber,
          to_members: [{ phone_number: phone }],
          message: message
        })
      });

      if (!zoomRes.ok) {
        const zoomError = await zoomRes.text();
        return res.status(500).json({ error: `Zoom Dispatch Error: ${zoomError}` });
      }

    } else if (providerType === 'vonage') {
      // --- VONAGE API ROUTE ---
      const vonageApiKey = practice?.provider_account_sid;
      const vonageApiSecret = practice?.provider_api_key;
      const vonageSender = practice?.provider_phone_number;

      if (!vonageApiKey || !vonageApiSecret || !vonageSender) {
        return res.status(400).json({
          error: 'Vonage Gateway selected, but API Key, API Secret, or Sender Number is missing in settings.'
        });
      }

      const vonageRes = await fetch('https://api.nexmo.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${vonageApiKey}:${vonageApiSecret}`).toString('base64'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: phone,
          from: vonageSender,
          channel: 'sms',
          message_type: 'text',
          text: message
        })
      });

      if (!vonageRes.ok) {
        const vonageError = await vonageRes.text();
        return res.status(500).json({ error: `Vonage Dispatch Error: ${vonageError}` });
      }

    } else {
      // --- TWILIO ROUTE ---
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

    // Increment usage counter
    if (practice) {
      await supabase
        .from('practices')
        .update({ sms_sent_this_month: sentCount + 1 })
        .eq('id', practice.id);
    }

    // Report metered usage to Stripe for built-in gateway
    if (planTier === 'active' && providerType === 'system' && practice.stripe_customer_id) {
      try {
        await stripe.billing.meterEvents.create({
          event_name: process.env.STRIPE_SMS_METER_EVENT_NAME || 'sms_sent',
          payload: {
            stripe_customer_id: practice.stripe_customer_id,
            value: '1'
          }
        });
      } catch (usageErr) {
        console.error('Failed to report Stripe meter event:', usageErr.message);
      }
    }

    return res.status(200).json({ success: true, deliveryMethod: 'sms', message: 'SMS delivered successfully.' });

  } catch (err) {
    console.error('Send SMS Error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
