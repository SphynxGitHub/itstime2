const twilio = require('twilio');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ 
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.' 
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const now = new Date().toISOString();

    // 1. Fetch active due messages
    const { data: messages, error: fetchError } = await supabase
      .from('scheduled_messages')
      .select('*, patients(*)')
      .eq('status', 'active')
      .lte('next_run_at', now);

    if (fetchError) {
      return res.status(500).json({ error: `Supabase query failed: ${fetchError.message}` });
    }

    if (!messages || messages.length === 0) {
      return res.status(200).json({ success: true, processed: 0, message: 'No messages due.' });
    }

    let processedCount = 0;
    let skippedCount = 0;

    for (const msg of messages) {
      const patient = msg.patients;
      if (!patient || !patient.phone) continue;

      // Fetch practice gateway configuration
      const { data: practice } = await supabase
        .from('practices')
        .select('*')
        .eq('user_id', patient.user_id)
        .maybeSingle();

      const providerType = practice?.provider_type || 'system';
      const planTier = practice?.plan_tier || 'trial';
      const sentCount = practice?.sms_sent_this_month || 0;
      const trialLimit = practice?.sms_limit || 100;
      const toPhone = patient.phone;
      const messageBody = msg.message_body;

      // The built-in 'system' gateway isn't launched yet — skip rather than
      // silently falling through to a shared system Twilio number.
      const supportedByocProviders = ['twilio', 'quo', 'telnyx', 'ringcentral', 'zoom', 'vonage'];
      if (!supportedByocProviders.includes(providerType)) {
        console.log(`Skipping message ${msg.id}: practice ${practice?.id} has no BYOC gateway configured`);
        skippedCount++;
        continue;
      }

      // -----------------------------------------------------------------
      // SUBSCRIPTION GATING (same rules as send-sms.js). A message that's
      // skipped here is left 'active' so the cron picks it back up on the
      // next run once the practice trial/subscription allows it again —
      // it is NOT canceled or marked completed just because it was skipped.
      // -----------------------------------------------------------------
      if (planTier === 'trial' && sentCount >= trialLimit) {
        console.log(`Skipping message ${msg.id}: trial limit reached for practice ${practice?.id}`);
        skippedCount++;
        continue;
      }
      if (planTier !== 'trial' && planTier !== 'active') {
        console.log(`Skipping message ${msg.id}: practice ${practice?.id} subscription is ${planTier}`);
        skippedCount++;
        continue;
      }

      // -----------------------------------------------------------------
      // GATEWAY ROUTING LOGIC
      // -----------------------------------------------------------------

      let dispatchFailed = false;

      if (providerType === 'quo') {
        // --- QUO (OPENPHONE) API ROUTE ---
        const quoApiKey = practice?.provider_api_key;
        const quoPhoneNumber = practice?.provider_phone_number;

        if (!quoApiKey || !quoPhoneNumber) {
          console.error(`Missing Quo API Key or Phone for practice associated with patient ${patient.id}`);
          continue;
        }

        const quoRes = await fetch('https://api.openphone.com/v1/messages', {
          method: 'POST',
          headers: {
            'Authorization': quoApiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: messageBody,
            from: quoPhoneNumber,
            to: [toPhone]
          })
        });

        if (!quoRes.ok) {
          const quoError = await quoRes.text();
          console.error(`Quo Dispatch Error for patient ${patient.id}:`, quoError);
          continue;
        }

      } else if (providerType === 'telnyx') {
        // --- TELNYX API ROUTE ---
        const telnyxApiKey = practice?.provider_api_key;
        const telnyxPhoneNumber = practice?.provider_phone_number;

        if (!telnyxApiKey || !telnyxPhoneNumber) {
          console.error(`Missing Telnyx API Key or Phone for practice associated with patient ${patient.id}`);
          continue;
        }

        const telnyxRes = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${telnyxApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: messageBody,
            from: telnyxPhoneNumber,
            to: toPhone
          })
        });

        if (!telnyxRes.ok) {
          const telnyxError = await telnyxRes.text();
          console.error(`Telnyx Dispatch Error for patient ${patient.id}:`, telnyxError);
          continue;
        }

      } else if (providerType === 'ringcentral') {
        // --- RINGCENTRAL API ROUTE ---
        const rcJwt = practice?.provider_api_key;
        const rcPhoneNumber = practice?.provider_phone_number;
        const rcClientId = process.env.RC_CLIENT_ID;
        const rcClientSecret = process.env.RC_CLIENT_SECRET;

        if (!rcJwt || !rcPhoneNumber || !rcClientId || !rcClientSecret) {
          console.error(`Missing RingCentral credentials for patient ${patient.id}`);
          continue;
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
          console.error(`RingCentral Auth Error for patient ${patient.id}:`, rcTokenData.error_description || rcTokenData.error);
          continue;
        }

        const rcRes = await fetch('https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${rcTokenData.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: { phoneNumber: rcPhoneNumber },
            to: [{ phoneNumber: toPhone }],
            text: messageBody
          })
        });

        if (!rcRes.ok) {
          const rcError = await rcRes.text();
          console.error(`RingCentral Dispatch Error for patient ${patient.id}:`, rcError);
          continue;
        }

      } else if (providerType === 'zoom') {
        // --- ZOOM PHONE API ROUTE (see send-sms.js for the caveat about
        // Zoom's SMS API limitations with automated/server-to-server sending) ---
        const zoomSidParts = (practice?.provider_account_sid || '').split(':');
        const zoomAccountId = zoomSidParts[0];
        const zoomClientId = zoomSidParts[1];
        const zoomClientSecret = practice?.provider_api_key;
        const zoomPhoneNumber = practice?.provider_phone_number;

        if (!zoomAccountId || !zoomClientId || !zoomClientSecret || !zoomPhoneNumber) {
          console.error(`Missing Zoom Phone credentials for patient ${patient.id}`);
          continue;
        }

        const zoomTokenRes = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${zoomAccountId}`, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${zoomClientId}:${zoomClientSecret}`).toString('base64')
          }
        });

        const zoomTokenData = await zoomTokenRes.json();
        if (!zoomTokenRes.ok) {
          console.error(`Zoom Auth Error for patient ${patient.id}:`, zoomTokenData.reason || zoomTokenData.error);
          continue;
        }

        const zoomRes = await fetch('https://api.zoom.us/v2/phone/sms/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${zoomTokenData.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sender: zoomPhoneNumber,
            to_members: [{ phone_number: toPhone }],
            message: messageBody
          })
        });

        if (!zoomRes.ok) {
          const zoomError = await zoomRes.text();
          console.error(`Zoom Dispatch Error for patient ${patient.id}:`, zoomError);
          continue;
        }

      } else if (providerType === 'vonage') {
        // --- VONAGE API ROUTE ---
        const vonageApiKey = practice?.provider_account_sid;
        const vonageApiSecret = practice?.provider_api_key;
        const vonageSender = practice?.provider_phone_number;

        if (!vonageApiKey || !vonageApiSecret || !vonageSender) {
          console.error(`Missing Vonage credentials for patient ${patient.id}`);
          continue;
        }

        const vonageRes = await fetch('https://api.nexmo.com/v1/messages', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${vonageApiKey}:${vonageApiSecret}`).toString('base64'),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            to: toPhone,
            from: vonageSender,
            channel: 'sms',
            message_type: 'text',
            text: messageBody
          })
        });

        if (!vonageRes.ok) {
          const vonageError = await vonageRes.text();
          console.error(`Vonage Dispatch Error for patient ${patient.id}:`, vonageError);
          continue;
        }

      } else {
        // --- TWILIO ROUTE (SYSTEM BUILT-IN OR BYOC TWILIO) ---
        const accountSid = practice?.provider_account_sid || process.env.TWILIO_ACCOUNT_SID;
        const authToken = practice?.provider_api_key || process.env.TWILIO_AUTH_TOKEN;
        const sendingNumber = practice?.provider_phone_number || process.env.TWILIO_PHONE_NUMBER;

        if (!accountSid || !authToken) {
          console.error(`Missing Twilio credentials for patient ${patient.id}`);
          continue;
        }

        const client = twilio(accountSid, authToken);
        await client.messages.create({
          body: messageBody,
          from: sendingNumber,
          to: toPhone
        });
      }

      processedCount++;

      // Increment practice usage counter (drives the trial cap + display)
      if (practice) {
        await supabase
          .from('practices')
          .update({ sms_sent_this_month: sentCount + 1 })
          .eq('id', practice.id);
      }

      // Report metered usage to Stripe — only for paid accounts on the
      // built-in 'system' gateway, same rule as send-sms.js. Uses the
      // current Billing Meters API (see send-sms.js for details on why).
      if (planTier === 'active' && providerType === 'system' && practice?.stripe_customer_id) {
        try {
          await stripe.billing.meterEvents.create({
            event_name: process.env.STRIPE_SMS_METER_EVENT_NAME || 'sms_sent',
            payload: {
              stripe_customer_id: practice.stripe_customer_id,
              value: '1'
            }
          });
        } catch (usageErr) {
          console.error(`Failed to report Stripe meter event for practice ${practice.id}:`, usageErr.message);
        }
      }

      // Schedule updates
      if (msg.schedule_type === 'one_time') {
        await supabase
          .from('scheduled_messages')
          .update({ status: 'completed' })
          .eq('id', msg.id);
      } else if (msg.schedule_type === 'multi_date') {
        const remainingDates = (msg.pending_dates || []).slice(1);
        if (remainingDates.length > 0) {
          await supabase
            .from('scheduled_messages')
            .update({
              next_run_at: remainingDates[0],
              pending_dates: remainingDates
            })
            .eq('id', msg.id);
        } else {
          await supabase
            .from('scheduled_messages')
            .update({ status: 'completed', pending_dates: [] })
            .eq('id', msg.id);
        }
      } else {
        let newRecurRemaining = msg.recurrences_remaining;
        let nextStatus = 'active';

        if (msg.recurrence_type === 'fixed_count' && newRecurRemaining !== null) {
          newRecurRemaining -= 1;
          if (newRecurRemaining <= 0) nextStatus = 'completed';
        }

        const nextDate = calculateNextRunDate(msg.next_run_at, msg.schedule_type);

        await supabase
          .from('scheduled_messages')
          .update({
            next_run_at: nextDate.toISOString(),
            recurrences_remaining: newRecurRemaining,
            status: nextStatus
          })
          .eq('id', msg.id);
      }
    }

    return res.status(200).json({ success: true, processed: processedCount, skipped: skippedCount });
  } catch (err) {
    console.error('Cron Execution Exception:', err);
    return res.status(500).json({ error: err.message || 'Serverless Execution Exception' });
  }
};

function calculateNextRunDate(currentRunIso, type) {
  const d = new Date(currentRunIso);
  if (type === 'daily') d.setDate(d.getDate() + 1);
  if (type === 'weekly') d.setDate(d.getDate() + 7);
  if (type === 'monthly') d.setMonth(d.getMonth() + 1);
  return d;
}
