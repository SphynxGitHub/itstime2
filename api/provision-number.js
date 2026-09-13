import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

// Lazily constructed — a missing env var shouldn't crash the whole module
// before Vercel can even route the request.
let client = null;
function getTwilioClient() {
  if (!client) client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client;
}

let supabase = null;
function getSupabase() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return supabase;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, areaCode, action, phoneNumber } = req.body;

  try {
    // 1. SEARCH AVAILABLE NUMBERS BY AREA CODE
    if (action === 'search') {
      const available = await getTwilioClient().availablePhoneNumbers('US')
        .local.list({ areaCode: parseInt(areaCode, 10), limit: 5 });
      
      const numbers = available.map(n => n.phoneNumber);
      return res.status(200).json({ numbers });
    }

    // 2. PURCHASE & ASSIGN NUMBER TO PRACTICE
    if (action === 'buy') {
      const purchasedNumber = await getTwilioClient().incomingPhoneNumbers.create({
        phoneNumber: phoneNumber,
        friendlyName: `Practice ID: ${userId}`
      });

      // NOTE: this number is purchased under YOUR master Twilio account
      // (process.env.TWILIO_ACCOUNT_SID above), not the customer's own
      // credentials — so provider_type stays 'system'. It was previously
      // being set to 'twilio', which would have wrongly classified this
      // practice as BYOC and skipped pay-as-you-go metered billing even
      // though they're still using your system Twilio account for every
      // message.
      await getSupabase()
        .from('practices')
        .update({
          provider_type: 'system',
          provider_phone_number: purchasedNumber.phoneNumber
        })
        .eq('user_id', userId);

      return res.status(200).json({ success: true, phoneNumber: purchasedNumber.phoneNumber });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
