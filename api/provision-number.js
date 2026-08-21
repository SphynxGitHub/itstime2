import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, areaCode, action, phoneNumber } = req.body;

  try {
    // 1. SEARCH AVAILABLE NUMBERS BY AREA CODE
    if (action === 'search') {
      const available = await client.availablePhoneNumbers('US')
        .local.list({ areaCode: parseInt(areaCode, 10), limit: 5 });
      
      const numbers = available.map(n => n.phoneNumber);
      return res.status(200).json({ numbers });
    }

    // 2. PURCHASE & ASSIGN NUMBER TO PRACTICE
    if (action === 'buy') {
      const purchasedNumber = await client.incomingPhoneNumbers.create({
        phoneNumber: phoneNumber,
        friendlyName: `Practice ID: ${userId}`
      });

      // Save number to practice profile in Supabase
      await supabase
        .from('practices')
        .update({
          provider_type: 'twilio',
          provider_phone_number: purchasedNumber.phoneNumber,
          provider_sid: purchasedNumber.sid
        })
        .eq('user_id', userId);

      return res.status(200).json({ success: true, phoneNumber: purchasedNumber.phoneNumber });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
