import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Optional: Verify Vercel Cron Secret to protect the endpoint
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date().toISOString();

    // 1. Fetch due scheduled messages
    const { data: dueMessages, error } = await supabase
      .from('scheduled_messages')
      .select('*, patients(*)')
      .eq('status', 'active')
      .lte('next_run_at', now);

    if (error) throw error;
    if (!dueMessages || dueMessages.length === 0) {
      return res.status(200).json({ message: 'No pending messages due.' });
    }

    const results = [];

    // 2. Dispatch each due message
    for (const msg of dueMessages) {
      const patient = msg.patients;
      if (!patient || !patient.phone) continue;

      // Trigger your existing SMS dispatcher logic
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.host}`;
      const sendRes = await fetch(`${appUrl}/api/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: patient.user_id,
          phone: patient.phone,
          message: msg.message_body
        })
      });

      const sendData = await sendRes.json();

      // 3. Update next run date or mark complete based on frequency
      if (sendRes.ok) {
        let updatePayload = {};

        if (msg.schedule_type === 'one_time') {
          updatePayload = { status: 'completed' };
        } else if (msg.schedule_type === 'daily') {
          const next = new Date(msg.next_run_at);
          next.setDate(next.getDate() + 1);
          updatePayload = { next_run_at: next.toISOString() };
        } else if (msg.schedule_type === 'weekly') {
          const next = new Date(msg.next_run_at);
          next.setDate(next.getDate() + 7);
          updatePayload = { next_run_at: next.toISOString() };
        } else if (msg.schedule_type === 'multi_date' && Array.isArray(msg.pending_dates)) {
          const remaining = msg.pending_dates.filter(d => new Date(d) > new Date());
          if (remaining.length > 0) {
            updatePayload = { next_run_at: remaining[0], pending_dates: remaining };
          } else {
            updatePayload = { status: 'completed' };
          }
        }

        await supabase
          .from('scheduled_messages')
          .update(updatePayload)
          .eq('id', msg.id);
      }

      results.push({ id: msg.id, success: sendRes.ok, detail: sendData });
    }

    return res.status(200).json({ processed: results.length, results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
