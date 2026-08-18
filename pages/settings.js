import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient'; // Adjust path to your Supabase client

export default function BillingSettings({ user }) {
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [autoUpgrade, setAutoUpgrade] = useState(false);

  useEffect(() => {
    fetchCustomerData();
  }, [user]);

  async function fetchCustomerData() {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (data) {
      setCustomer(data);
      setAutoUpgrade(data.auto_upgrade_enabled);
    }
    setLoading(false);
  }

  async function handleToggleAutoUpgrade(e) {
    const newValue = e.target.checked;
    setAutoUpgrade(newValue);

    await supabase
      .from('customers')
      .update({ auto_upgrade_enabled: newValue })
      .eq('user_id', user.id);
  }

  async function handleSelectPlan(planTier) {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        planTier: planTier,
        autoUpgrade: autoUpgrade,
      }),
    });

    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  if (loading) return <div>Loading billing info...</div>;

  const usagePercent = Math.min(
    100,
    Math.round(((customer?.sms_sent_this_month || 0) / (customer?.sms_limit || 100)) * 100)
  );

  return (
    <div style={{ maxWidth: '600px', padding: '24px', border: '1px solid #e2e8f0', borderRadius: '12px' }}>
      <h2>Billing & Usage</h2>
      <p><strong>Current Plan:</strong> {customer?.plan_tier?.toUpperCase() || 'TRIAL'}</p>

      {/* Usage Bar */}
      <div style={{ margin: '20px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span>SMS Sent This Month</span>
          <span><strong>{customer?.sms_sent_this_month || 0}</strong> / {customer?.sms_limit || 100}</span>
        </div>
        <div style={{ width: '100%', background: '#e2e8f0', height: '12px', borderRadius: '6px', overflow: 'hidden' }}>
          <div style={{ width: `${usagePercent}%`, background: usagePercent > 90 ? '#ef4444' : '#3b82f6', height: '100%' }} />
        </div>
      </div>

      {/* Auto-Upgrade Toggle */}
      <div style={{ padding: '16px', background: '#f8fafc', borderRadius: '8px', marginBottom: '24px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoUpgrade}
            onChange={handleToggleAutoUpgrade}
            style={{ width: '18px', height: '18px' }}
          />
          <div>
            <strong>Enable Auto-Upgrade</strong>
            <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
              Automatically move to the next tier when your SMS limit is reached to prevent service interruption.
            </p>
          </div>
        </label>
      </div>

      {/* Upgrade Options */}
      <h3>Change Plan</h3>
      <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
        <button onClick={() => handleSelectPlan('starter')} style={{ padding: '10px 16px', borderRadius: '6px', cursor: 'pointer' }}>
          Upgrade to Starter ($29/mo)
        </button>
        <button onClick={() => handleSelectPlan('pro')} style={{ padding: '10px 16px', borderRadius: '6px', cursor: 'pointer' }}>
          Upgrade to Pro ($79/mo)
        </button>
      </div>
    </div>
  );
}
