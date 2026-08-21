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
        } else if (msg.schedule_type === 'multi_date' && Array.isArray(msg.pending_dates)) {
          const remaining = msg.pending_dates.filter(d => new Date(d) > new Date());
          updatePayload = remaining.length > 0 
            ? { next_run_at: remaining[0], pending_dates: remaining }
            : { status: 'completed' };
        } else {
          // RECURRING LOGIC (Daily, Weekly, Monthly)
          let hasCountLimit = msg.recurrence_type === 'fixed_count' && msg.recurrences_remaining !== null;
          let newRemaining = hasCountLimit ? msg.recurrences_remaining - 1 : null;
      
          if (hasCountLimit && newRemaining <= 0) {
            updatePayload = { status: 'completed', recurrences_remaining: 0 };
          } else {
            const next = new Date(msg.next_run_at);
            if (msg.schedule_type === 'daily') next.setDate(next.getDate() + 1);
            if (msg.schedule_type === 'weekly') next.setDate(next.getDate() + 7);
            if (msg.schedule_type === 'monthly') next.setMonth(next.getMonth() + 1);
      
            updatePayload = {
              next_run_at: next.toISOString(),
              recurrences_remaining: newRemaining
            };
          }
        }
      
        await supabase.from('scheduled_messages').update(updatePayload).eq('id', msg.id);
      }
      results.push({ id: msg.id, success: sendRes.ok, detail: sendData });
    }

    return res.status(200).json({ processed: results.length, results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
