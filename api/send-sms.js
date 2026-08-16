export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });

  // Credentials are read ONLY from Vercel Environment Variables
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromPhone) {
    return res.status(500).json({ error: 'Server error: Missing Twilio environment variables in Vercel.' });
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const params = new URLSearchParams({
      To: phone,
      From: fromPhone,
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