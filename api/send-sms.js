import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });

  // Sanitize phone number to E.164 (+1XXXXXXXXXX) format
  let cleanDigits = phone.replace(/\D/g, '');
  let formattedPhone = phone;
  if (cleanDigits.length === 10) formattedPhone = `+1${cleanDigits}`;
  else if (cleanDigits.length === 11 && cleanDigits.startsWith('1')) formattedPhone = `+${cleanDigits}`;

  try {
    // 1. Fetch Practice Billing & Gateway Settings
    let { data: practice } = await supabase
      .from('practices')
      .select('*')
      .eq('user_id', userId)
      .single();

    // Auto-create practice record if missing
    if (!practice) {
      const { data: newPractice } = await supabase
        .from('practices')
        .insert([{ user_id: userId, plan_tier: 'trial', sms_limit: 100, sms_sent_this_month: 0 }])
        .select()
        .single();
      practice = newPractice;
    }

    // 2. Check Monthly SMS Quotas
    if (practice.sms_sent_this_month >= practice.sms_limit) {
      if (!practice.auto_upgrade_enabled) {
        return res.status(403).json({ 
          error: 'LIMIT_REACHED', 
          message: 'Monthly SMS quota reached. Enable Auto-Upgrade or upgrade your plan to continue.' 
        });
      }
    }

    const provider = practice.provider_type || 'system';
    let messageSid = null;

    // --- OPTION A: BYOC TWILIO ---
    if (provider === 'twilio' && practice.provider_account_sid && practice.provider_api_key) {
      const auth = Buffer.from(`${practice.provider_account_sid}:${practice.provider_api_key}`).toString('base64');
      const params = new URLSearchParams({ To: formattedPhone, From: practice.provider_phone_number, Body: message });

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${practice.provider_account_sid}/Messages.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Custom Twilio send failed');
      messageSid = data.sid;
    } 

    // --- OPTION B: BYOC QUO ---
    else if (provider === 'quo' && practice.provider_api_key) {
      const response = await fetch('https://api.quo.com/v1/messages', {
        method: 'POST',
        headers: { 'Authorization': practice.provider_api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message, from: practice.provider_phone_number, to: [formattedPhone] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Quo send failed');
      messageSid = data.id || 'quo_sent';
    }

    // --- OPTION C: DEFAULT MASTER SYSTEM TWILIO ACCOUNT ---
    else {
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const params = new URLSearchParams({ To: formattedPhone, MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, Body: message });

      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Master Twilio send failed');
      messageSid = data.sid;
    }

    // 3. Increment Practice's Monthly Usage Count
    await supabase
      .from('practices')
      .update({ sms_sent_this_month: (practice.sms_sent_this_month || 0) + 1 })
      .eq('user_id', userId);

    return res.status(200).json({ success: true, sid: messageSid });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
