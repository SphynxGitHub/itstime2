export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });

  // Sanitize phone number to E.164 (+1XXXXXXXXXX) format
  let cleanDigits = phone.replace(/\D/g, '');
  let formattedPhone = phone;

  if (cleanDigits.length === 10) {
    formattedPhone = `+1${cleanDigits}`;
  } else if (cleanDigits.length === 11 && cleanDigits.startsWith('1')) {
    formattedPhone = `+${cleanDigits}`;
  } else if (!phone.startsWith('+')) {
    formattedPhone = `+${cleanDigits}`;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || !messagingServiceSid) {
    return res.status(500).json({ error: 'Server error: Missing Twilio environment variables in Vercel.' });
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const params = new URLSearchParams({
      To: formattedPhone,
      MessagingServiceSid: messagingServiceSid, // Connects directly to your approved A2P campaign
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
    if (!response.ok) throw new Error(data.message || 'Twilio send failed');

    return res.status(200).json({ success: true, sid: data.sid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
