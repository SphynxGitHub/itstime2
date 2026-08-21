import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, legalName, ein, businessType, address, city, state, postalCode } = req.body;

  try {
    // 1. Create a Customer Profile / Secondary Brand in Twilio
    const brand = await client.trusthub.v1.customerProfiles.create({
      friendlyName: legalName,
      email: req.body.email || 'compliance@itstime2.net',
      policySid: 'RNdfdd54153922372719522f6e9198651a' // Standard A2P Brand Policy SID
    });

    // 2. Save Brand SID and mark status as 'pending' in Supabase
    await supabase
      .from('practices')
      .update({
        legal_business_name: legalName,
        ein_tax_id: ein,
        business_type: businessType,
        business_address: `${address}, ${city}, ${state} ${postalCode}`,
        a2p_brand_sid: brand.sid,
        a2p_status: 'pending'
      })
      .eq('user_id', userId);

    return res.status(200).json({ success: true, message: 'A2P Registration submitted for vetting.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
