import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });

  // 1. Sanitize phone number to E.164 (+1XXXXXXXXXX) format
  let cleanDigits = phone.replace(/\D/g, '');
  let formattedPhone = phone;

  if (cleanDigits.length === 10) {
    formattedPhone = `+1${cleanDigits}`;
  } else if (cleanDigits.length === 11 && cleanDigits.startsWith('1')) {
    formattedPhone = `+${cleanDigits}`;
  } else if (!phone.startsWith('+')) {
    formattedPhone = `+${cleanDigits}`;
  }

  try {
    // 2. Fetch Customer's BYOC Settings and Usage Limits from Supabase
    const { data: customer, error: custError } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (custError || !customer) {
      return res.status(404).json({ error: 'Customer account not found.' });
    }

    // 3. Usage Quota Check
    if (customer.sms_sent_this_month >= customer.sms_limit) {
      if (!customer.auto_upgrade_enabled) {
        return res.status(403).json({ 
          error: 'LIMIT_REACHED', 
          message: 'Monthly SMS quota reached. Enable Auto-Upgrade or upgrade your plan to continue sending messages.' 
        });
      }
    }

    const provider = customer.provider_type || 'system';
    let dispatchSuccess = false;
    let messageSid = null;

    // --- OPTION A: CUSTOM TWILIO (BYOC) ---
    if (provider === 'twilio' && customer.provider_account_sid && customer.provider_api_key) {
      const auth = Buffer.from(`${customer.provider_account_sid}:${customer.provider_api_key}`).toString('base64');
      const params = new URLSearchParams({
        To: formattedPhone,
        From: customer.provider_phone_number,
        Body: message
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${customer.provider_account_sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString()
        }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Custom Twilio dispatch failed');
      
      dispatchSuccess = true;
      messageSid = data.sid;
    } 

    // --- OPTION B: CUSTOM QUO (Formerly OpenPhone) (BYOC) ---
    else if (provider === 'quo' && customer.provider_api_key) {
      const response = await fetch('https://api.quo.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': customer.provider_api_key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: message,
          from: customer.provider_phone_number,
          to: [formattedPhone]
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Quo API dispatch failed');

      dispatchSuccess = true;
      messageSid = data.id || 'quo_dispatched';
    }

    // --- OPTION C: DEFAULT MASTER SYSTEM TWILIO ACCOUNT ---
    else {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

      if (!accountSid || !authToken || !messagingServiceSid) {
        return res.status(500).json({ error: 'Server error: Missing Master Twilio variables in Vercel.' });
      }

      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const params = new URLSearchParams({
        To: formattedPhone,
        MessagingServiceSid: messagingServiceSid,
        Body: message
      });

      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString()
        }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Master Twilio send failed');

      dispatchSuccess = true;
      messageSid = data.sid;
    }

    // 4. Increment usage counter in Supabase regardless of gateway used
    if (dispatchSuccess) {
      await supabase
        .from('customers')
        .update({ sms_sent_this_month: (customer.sms_sent_this_month || 0) + 1 })
        .eq('user_id', userId);
    }

    return res.status(200).json({ success: true, sid: messageSid, providerUsed: provider });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
