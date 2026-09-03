const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // Guarantee JSON responses even on crashes
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

    for (const msg of messages) {
      const patient = msg.patients;
      if (!patient || !patient.phone) continue;

      // Check practice gateway setup
      const { data: practice } = await supabase
        .from('practices')
        .select('*')
        .eq('user_id', patient.user_id)
        .maybeSingle();

      const accountSid = practice?.provider_account_sid || process.env.TWILIO_ACCOUNT_SID;
      const authToken = practice?.provider_api_key || process.env.TWILIO_AUTH_TOKEN;
      const sendingNumber = practice?.provider_phone_number || process.env.TWILIO_PHONE_NUMBER;

      if (!accountSid || !authToken) {
        console.error(`Missing Twilio keys for practice associated with patient ${patient.id}`);
        continue;
      }

      const client = twilio(accountSid, authToken);

      // Send SMS
      await client.messages.create({
        body: msg.message_body,
        from: sendingNumber,
        to: patient.phone
      });

      processedCount++;

      // Increment practice usage count
      if (practice) {
        await supabase
          .from('practices')
          .update({ sms_sent_this_month: (practice.sms_sent_this_month || 0) + 1 })
          .eq('id', practice.id);
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

    return res.status(200).json({ success: true, processed: processedCount });
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
