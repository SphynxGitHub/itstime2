/* ==========================================================================
   IT'S TIME 2 — APPLICATION CONTROLLER (app.js)
   ========================================================================== */

const SUPABASE_URL = 'https://yktwthagtgdzzkaypgqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_onP87pGhzbxdWjnDoOnJAA_XCAiOJFx';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const ONE_HOUR_MS = 60 * 60 * 1000;

let currentUserId = null;
let editingCustId = null;
let editingTmplId = null;
let editingSchedId = null;
let activeModalCust = null;
let currentProfileCustId = null;
let customerStore = [];
let templateStore = [];
let scheduleStore = [];
let customDatesList = [];

// --- VISIBILITY TOGGLE (LUCIDE) ---
function toggleVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  
  const icon = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    if (icon) icon.setAttribute('data-lucide', 'eye');
  }
  if (window.lucide) lucide.createIcons();
}

// --- PHONE FORMATTING HELPERS ---
function formatToE164(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.trim().startsWith('+')) return `+1${digits}`;
  return `+1${digits}`;
}

function formatForDisplay(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

function toDatetimeLocal(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const offset = date.getTimezoneOffset() * 60000;
  return (new Date(date.getTime() - offset)).toISOString().slice(0, 16);
}

// --- ACTIVITY TRACKER & AUTO-LOGOUT ---
function recordActivity() { 
  localStorage.setItem('lastActivityTimestamp', Date.now().toString()); 
}

function checkInactivity() {
  const last = localStorage.getItem('lastActivityTimestamp');
  if (last && Date.now() - parseInt(last, 10) > ONE_HOUR_MS) { 
    logout(true); 
    return true; 
  }
  return false;
}
['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => window.addEventListener(evt, recordActivity));

// --- NAVIGATION CONTROLLER ---
function switchTab(tabName) {
  cancelSchedEdit();
  ['customers', 'profile', 'templates', 'history', 'billing'].forEach(t => {
    const el = document.getElementById(`view-${t}`);
    if (el) el.classList.add('hidden');
    const nav = document.getElementById(`nav-${t}`);
    if (nav) nav.classList.remove('active');
  });

  const activeEl = document.getElementById(`view-${tabName}`);
  if (activeEl) activeEl.classList.remove('hidden');
  const activeNav = document.getElementById(`nav-${tabName}`);
  if (activeNav) activeNav.classList.add('active');

  if (tabName === 'customers') fetchPatients();
  if (tabName === 'templates') fetchTemplates();
  if (tabName === 'history') fetchHistory();
  if (tabName === 'billing') fetchBillingDetails();
}

// --- SESSION & ROUTING INITIALIZATION ---
window.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();
  if (checkInactivity()) return;
  
  const { data: { session } } = await supabaseClient.auth.getSession();
  
  if (session) {
    recordActivity();
    currentUserId = session.user.id;
    showApp(session.user.email);
  } else {
    showLoginForm();
  }
});

function showLoginForm() {
  const authSec = document.getElementById('auth-section');
  const dash = document.getElementById('dashboard');
  if (authSec) authSec.classList.remove('hidden');
  if (dash) dash.classList.add('hidden');
}

function showApp(email) {
  const userEmail = document.getElementById('user-email');
  const authSec = document.getElementById('auth-section');
  const dash = document.getElementById('dashboard');

  if (userEmail) userEmail.innerText = email;
  if (authSec) authSec.classList.add('hidden');
  if (dash) dash.classList.remove('hidden');

  fetchPatients();
  fetchTemplatesQuietly();
  fetchBillingDetails();
}

// --- AUTHENTICATION ---
async function signUp() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  if (!email || !password) return alert('Enter email and password.');
  const { error } = await supabaseClient.auth.signUp({ email, password });
  if (error) alert(error.message);
  else alert('Success! You can now log in.');
}

async function login() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) alert(error.message);
  else { 
    recordActivity(); 
    currentUserId = data.user.id;
    showApp(data.user.email); 
  }
}

async function logout(wasExpired = false) {
  await supabaseClient.auth.signOut();
  localStorage.removeItem('lastActivityTimestamp');
  currentUserId = null;
  
  if (wasExpired) alert('Logged out automatically due to 1 hour of inactivity.');
  window.location.href = '/';
}

async function resetPassword() {
  const email = document.getElementById('email').value;
  if (!email) return alert('Enter email address.');
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
  if (error) alert(error.message);
  else alert('Reset link sent!');
}

// --- ACTIVITY LOGGING HELPER ---
async function logActivity(action, details) {
  await supabaseClient.from('activity_history').insert([{ action, details }]);
}

// --- MODULE 1: PATIENTS DIRECTORY ---
async function fetchPatients() {
  const tbody = document.getElementById('customer-list-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
  
  const { data, error } = await supabaseClient
    .from('patients')
    .select('*')
    .eq('user_id', currentUserId)
    .order('created_at', { ascending: false });

  if (error) return tbody.innerHTML = '<tr><td colspan="4">Error loading contacts.</td></tr>';
  customerStore = data || [];
  if (customerStore.length === 0) return tbody.innerHTML = '<tr><td colspan="4">No contacts found. Add one above!</td></tr>';
  
  tbody.innerHTML = '';
  customerStore.forEach(c => {
    tbody.innerHTML += `
      <tr>
        <td><strong>${c.first_name || ''} ${c.last_name || ''}</strong></td>
        <td>${c.email || ''}</td>
        <td>${formatForDisplay(c.phone)}</td>
        <td>
          <button class="action-btn info" onclick="openPatientProfile('${c.id}')">Profile & Schedules</button>
          <button class="action-btn info" onclick="openSendModal('${c.id}')">Send Msg</button>
          <button class="action-btn warning" onclick="startCustEdit('${c.id}')">Edit</button>
          <button class="action-btn danger" onclick="deletePatient('${c.id}')">Delete</button>
        </td>
      </tr>`;
  });
}

async function savePatient() {
  const first_name = document.getElementById('cust-first-name').value;
  const last_name = document.getElementById('cust-last-name').value;
  const email = document.getElementById('cust-email').value;
  const rawPhone = document.getElementById('cust-phone').value;
  const phone = formatToE164(rawPhone);

  if (!first_name) return alert('First name required.');

  if (editingCustId) {
    const { error } = await supabaseClient
      .from('patients')
      .update({ first_name, last_name, email, phone })
      .eq('id', editingCustId);

    if (error) alert(error.message);
    else {
      await logActivity('Updated Contact', `Updated profile for ${first_name} ${last_name}`);
      cancelCustEdit();
      fetchPatients();
    }
  } else {
    const { error } = await supabaseClient
      .from('patients')
      .insert([{ first_name, last_name, email, phone, user_id: currentUserId }]);

    if (error) alert(error.message);
    else {
      await logActivity('Created Contact', `Added new patient ${first_name} ${last_name}`);
      clearCustForm();
      fetchPatients();
    }
  }
}

function startCustEdit(id) {
  const c = customerStore.find(i => String(i.id) === String(id));
  if (!c) return;
  editingCustId = id;
  document.getElementById('cust-first-name').value = c.first_name || '';
  document.getElementById('cust-last-name').value = c.last_name || '';
  document.getElementById('cust-email').value = c.email || '';
  document.getElementById('cust-phone').value = formatForDisplay(c.phone) || '';
  document.getElementById('cust-form-title').innerText = 'Edit Contact';
  document.getElementById('cust-save-btn').innerText = 'Save Changes';
  document.getElementById('cust-cancel-btn').classList.remove('hidden');
}

function cancelCustEdit() {
  editingCustId = null;
  clearCustForm();
  document.getElementById('cust-form-title').innerText = 'Add Contact';
  document.getElementById('cust-save-btn').innerText = 'Add Contact';
  document.getElementById('cust-cancel-btn').classList.add('hidden');
}

function clearCustForm() {
  document.getElementById('cust-first-name').value = '';
  document.getElementById('cust-last-name').value = '';
  document.getElementById('cust-email').value = '';
  document.getElementById('cust-phone').value = '';
}

async function deletePatient(id) {
  const c = customerStore.find(i => String(i.id) === String(id));
  if (!confirm('Delete this contact?')) return;
  
  const { error } = await supabaseClient
    .from('patients')
    .delete()
    .eq('id', id);

  if (error) alert(error.message);
  else {
    await logActivity('Deleted Contact', `Removed contact ${c ? c.first_name : id}`);
    fetchPatients();
  }
}

// --- MODULE 2: FULL-PAGE PATIENT PROFILE & SCHEDULING ---
async function openPatientProfile(custId) {
  currentProfileCustId = custId;
  const cust = customerStore.find(c => String(c.id) === String(custId));
  if (!cust) return alert('Contact not found.');

  ['customers', 'templates', 'history', 'billing'].forEach(t => {
    const el = document.getElementById(`view-${t}`);
    if (el) el.classList.add('hidden');
  });
  document.getElementById('view-profile').classList.remove('hidden');

  document.getElementById('profile-title').innerText = `${cust.first_name || ''} ${cust.last_name || ''}`;
  document.getElementById('profile-subtitle').innerText = `Email: ${cust.email || 'N/A'} | Phone: ${formatForDisplay(cust.phone) || 'N/A'}`;

  await fetchTemplatesQuietly();
  const sel = document.getElementById('sched-template-select');
  sel.innerHTML = '<option value="">-- Select Template (Optional) --</option>';
  templateStore.forEach(t => { sel.innerHTML += `<option value="${t.id}">${t.title}</option>`; });

  cancelSchedEdit();
  loadPatientSchedules(custId);
  loadPatientHistory(cust.phone);
}

function applySchedTemplateToPreview() {
  const selectedId = document.getElementById('sched-template-select').value;
  const cust = customerStore.find(c => String(c.id) === String(currentProfileCustId));
  if (!selectedId || !cust) return;

  const tmpl = templateStore.find(t => String(t.id) === String(selectedId));
  if (!tmpl) return;

  let text = tmpl.body;
  text = text.replace(/\{first_name\}/g, cust.first_name || '');
  text = text.replace(/\{last_name\}/g, cust.last_name || '');
  text = text.replace(/\{email\}/g, cust.email || '');
  text = text.replace(/\{phone\}/g, formatForDisplay(cust.phone) || '');

  document.getElementById('sched-message-body').value = text;
}

function toggleScheduleFormOptions() {
  toggleCustomDatePicker();
  toggleRecurrenceInput();
}

function toggleCustomDatePicker() {
  const type = document.getElementById('sched-type').value;
  const singleContainer = document.getElementById('single-date-container');
  const multiContainer = document.getElementById('multi-date-container');

  if (type === 'multi_date') {
    if (singleContainer) singleContainer.classList.add('hidden');
    if (multiContainer) multiContainer.classList.remove('hidden');
  } else {
    if (singleContainer) singleContainer.classList.remove('hidden');
    if (multiContainer) multiContainer.classList.add('hidden');
  }
}

function toggleRecurrenceInput() {
  const type = document.getElementById('sched-type').value;
  const recurrenceTypeSelect = document.getElementById('sched-recurrence-type');
  const limitContainer = document.getElementById('recurrence-limit-container');
  const countWrapper = document.getElementById('recurrence-count-wrapper');

  if (!limitContainer || !countWrapper || !recurrenceTypeSelect) return;

  const recurrenceType = recurrenceTypeSelect.value;

  if (type === 'one_time' || type === 'multi_date') {
    limitContainer.classList.add('hidden');
    countWrapper.classList.add('hidden');
    return;
  }

  limitContainer.classList.remove('hidden');

  if (recurrenceType === 'fixed_count') {
    countWrapper.classList.remove('hidden');
  } else {
    countWrapper.classList.add('hidden');
  }
}

function addCustomDateToList() {
  const val = document.getElementById('multi-date-input').value;
  if (!val) return alert('Select a date and time first.');

  const iso = new Date(val).toISOString();
  if (customDatesList.includes(iso)) return alert('That timestamp is already in your list.');

  customDatesList.push(iso);
  customDatesList.sort();
  document.getElementById('multi-date-input').value = '';
  renderCustomDatesList();
}

function removeCustomDateFromList(index) {
  customDatesList.splice(index, 1);
  renderCustomDatesList();
}

function renderCustomDatesList() {
  const ul = document.getElementById('custom-dates-list');
  if (!ul) return;

  if (customDatesList.length === 0) {
    return ul.innerHTML = '<li style="color: #94a3b8; list-style: none; margin-left: -15px;">No dates added yet.</li>';
  }

  ul.innerHTML = '';
  customDatesList.forEach((iso, idx) => {
    const display = new Date(iso).toLocaleString();
    ul.innerHTML += `
      <li style="margin-bottom: 4px;">
        <strong>${display}</strong>
        <button type="button" onclick="removeCustomDateFromList(${idx})" class="action-btn danger" style="padding: 1px 6px; font-size: 10px; margin-left: 10px;">Remove</button>
      </li>`;
  });
}

async function loadPatientSchedules(custId) {
  const tbody = document.getElementById('sched-list-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5">Loading schedules...</td></tr>';

  const { data, error } = await supabaseClient
    .from('scheduled_messages')
    .select('*')
    .eq('patient_id', String(custId))
    .neq('status', 'completed') 
    .order('next_run_at', { ascending: true });

  if (error || !data || data.length === 0) {
    scheduleStore = [];
    return tbody.innerHTML = '<tr><td colspan="5">No active scheduled messages found. Create one above!</td></tr>';
  }

  scheduleStore = data;
  tbody.innerHTML = '';
  data.forEach(s => {
    const isPaused = s.status === 'paused';
    const nextRun = new Date(s.next_run_at).toLocaleString();
    
    let displayType = s.schedule_type.toUpperCase();
    if (s.schedule_type === 'multi_date') {
      displayType = `MULTI-DATE (${s.pending_dates ? s.pending_dates.length : 0} left)`;
    } else if (s.recurrence_type === 'fixed_count' && s.recurrences_remaining !== null) {
      displayType += ` (${s.recurrences_remaining} left)`;
    }
    
    tbody.innerHTML += `
      <tr>
        <td><strong>${displayType}</strong></td>
        <td>${nextRun}</td>
        <td><span style="color:${isPaused ? '#e53e3e' : '#00B04F'}; font-weight:bold;">${s.status}</span></td>
        <td>${s.message_body || ''}</td>
        <td>
          <button class="action-btn warning" onclick="startSchedEdit('${s.id}')">Edit</button>
          <button class="action-btn ${isPaused ? 'info' : 'secondary'}" onclick="toggleScheduleStatus('${s.id}', '${s.status}')">${isPaused ? 'Start' : 'Pause'}</button>
          <button class="action-btn danger" onclick="deleteSchedule('${s.id}')">Delete</button>
        </td>
      </tr>`;
  });
}

function startSchedEdit(schedId) {
  const s = scheduleStore.find(item => String(item.id) === String(schedId));
  if (!s) return;

  editingSchedId = schedId;
  document.getElementById('sched-message-body').value = s.message_body || '';
  document.getElementById('sched-type').value = s.schedule_type || 'one_time';
  document.getElementById('sched-recurrence-type').value = s.recurrence_type || 'indefinite';
  document.getElementById('sched-recurrence-count').value = s.recurrences_remaining || '';

  if (s.schedule_type === 'multi_date') {
    customDatesList = Array.isArray(s.pending_dates) ? [...s.pending_dates] : [];
    renderCustomDatesList();
  } else {
    customDatesList = [];
    document.getElementById('sched-datetime').value = toDatetimeLocal(s.next_run_at);
  }

  toggleScheduleFormOptions();

  document.getElementById('sched-form-title').innerText = 'Edit Scheduled Message';
  document.getElementById('sched-save-btn').innerText = 'Update Schedule';
  document.getElementById('sched-cancel-btn').classList.remove('hidden');
}

function cancelSchedEdit() {
  editingSchedId = null;
  customDatesList = [];
  
  const msgInput = document.getElementById('sched-message-body');
  const dtInput = document.getElementById('sched-datetime');
  const tmplSelect = document.getElementById('sched-template-select');
  const typeSelect = document.getElementById('sched-type');
  const recTypeSelect = document.getElementById('sched-recurrence-type');
  const recCountInput = document.getElementById('sched-recurrence-count');

  if (msgInput) msgInput.value = '';
  if (dtInput) dtInput.value = '';
  if (tmplSelect) tmplSelect.value = '';
  if (typeSelect) typeSelect.value = 'one_time';
  if (recTypeSelect) recTypeSelect.value = 'indefinite';
  if (recCountInput) recCountInput.value = '';
  
  toggleScheduleFormOptions();
  renderCustomDatesList();

  const title = document.getElementById('sched-form-title');
  const saveBtn = document.getElementById('sched-save-btn');
  const cancelBtn = document.getElementById('sched-cancel-btn');

  if (title) title.innerText = 'Schedule Recurring or One-Time SMS';
  if (saveBtn) saveBtn.innerText = 'Schedule Message';
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

async function saveSchedule() {
  const message_body = document.getElementById('sched-message-body').value;
  const schedule_type = document.getElementById('sched-type').value;
  const recurrence_type = document.getElementById('sched-recurrence-type').value;
  const countInput = document.getElementById('sched-recurrence-count').value;

  if (!message_body) return alert('Please enter message text.');

  let next_run_at = null;
  let pending_dates = [];
  let recurrences_remaining = null;

  if (schedule_type === 'multi_date') {
    if (customDatesList.length === 0) return alert('Please add at least one date to your list.');
    next_run_at = customDatesList[0];
    pending_dates = [...customDatesList];
  } else {
    const rawDatetime = document.getElementById('sched-datetime').value;
    if (!rawDatetime) return alert('Please select a dispatch date/time.');
    next_run_at = new Date(rawDatetime).toISOString();
  }

  if (schedule_type !== 'one_time' && schedule_type !== 'multi_date') {
    if (recurrence_type === 'fixed_count') {
      if (!countInput || parseInt(countInput, 10) < 1) return alert('Enter a valid number of recurrences.');
      recurrences_remaining = parseInt(countInput, 10);
    }
  }

  const payload = {
    patient_id: String(currentProfileCustId),
    message_body,
    schedule_type,
    recurrence_type: schedule_type === 'one_time' || schedule_type === 'multi_date' ? 'indefinite' : recurrence_type,
    recurrences_remaining,
    next_run_at,
    pending_dates,
    status: 'active'
  };

  if (editingSchedId) {
    const { error } = await supabaseClient.from('scheduled_messages').update(payload).eq('id', editingSchedId);
    if (error) alert(error.message);
    else {
      alert('Schedule updated successfully!');
      cancelSchedEdit();
      loadPatientSchedules(currentProfileCustId);
    }
  } else {
    const { error } = await supabaseClient.from('scheduled_messages').insert([payload]);
    if (error) alert(error.message);
    else {
      alert('Message schedule created successfully!');
      cancelSchedEdit();
      loadPatientSchedules(currentProfileCustId);
    }
  }
}

async function toggleScheduleStatus(schedId, currentStatus) {
  const newStatus = currentStatus === 'paused' ? 'active' : 'paused';
  await supabaseClient.from('scheduled_messages').update({ status: newStatus }).eq('id', schedId);
  loadPatientSchedules(currentProfileCustId);
}

async function deleteSchedule(schedId) {
  if (!confirm('Cancel and delete this schedule?')) return;
  await supabaseClient.from('scheduled_messages').delete().eq('id', schedId);
  loadPatientSchedules(currentProfileCustId);
}

async function loadPatientHistory(phone) {
  const tbody = document.getElementById('profile-history-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="2">Loading history...</td></tr>';

  const { data } = await supabaseClient
    .from('activity_history')
    .select('*')
    .ilike('details', `%${phone}%`)
    .order('created_at', { ascending: false });

  if (!data || data.length === 0) {
    return tbody.innerHTML = '<tr><td colspan="2">No past history recorded for this contact.</td></tr>';
  }

  tbody.innerHTML = '';
  data.forEach(h => {
    const time = new Date(h.created_at).toLocaleString();
    tbody.innerHTML += `
      <tr>
        <td style="font-size:12px; color:#666; width:180px;">${time}</td>
        <td><strong>${h.action}:</strong> ${h.details}</td>
      </tr>`;
  });
}

// --- MODULE 3: MESSAGE LIBRARY (TEMPLATES) ---
async function fetchTemplatesQuietly() {
  const { data } = await supabaseClient.from('reminder_templates').select('*').order('title', { ascending: true });
  templateStore = data || [];
}

async function fetchTemplates() {
  const tbody = document.getElementById('template-list-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3">Loading...</td></tr>';
  const { data, error } = await supabaseClient.from('reminder_templates').select('*').order('created_at', { ascending: false });
  if (error) return tbody.innerHTML = '<tr><td colspan="3">Error loading templates.</td></tr>';
  templateStore = data || [];
  if (templateStore.length === 0) return tbody.innerHTML = '<tr><td colspan="3">No templates found. Create your first one above!</td></tr>';
  tbody.innerHTML = '';
  templateStore.forEach(t => {
    tbody.innerHTML += `
      <tr>
        <td><strong>${t.title}</strong></td>
        <td>${t.body}</td>
        <td>
          <button class="action-btn warning" onclick="startTmplEdit('${t.id}')">Edit</button>
          <button class="action-btn danger" onclick="deleteTemplate('${t.id}')">Delete</button>
        </td>
      </tr>`;
  });
}

async function saveTemplate() {
  const title = document.getElementById('tmpl-title').value;
  const body = document.getElementById('tmpl-body').value;
  if (!title || !body) return alert('Title and body are required.');

  if (editingTmplId) {
    const { error } = await supabaseClient.from('reminder_templates').update({ title, body }).eq('id', editingTmplId);
    if (error) alert(error.message);
    else {
      await logActivity('Updated Template', `Modified template "${title}"`);
      cancelTmplEdit();
      fetchTemplates();
    }
  } else {
    const { error } = await supabaseClient.from('reminder_templates').insert([{ title, body }]);
    if (error) alert(error.message);
    else {
      await logActivity('Created Template', `Saved new template "${title}"`);
      clearTmplForm();
      fetchTemplates();
    }
  }
}

function startTmplEdit(id) {
  const t = templateStore.find(i => String(i.id) === String(id));
  if (!t) return;
  editingTmplId = id;
  document.getElementById('tmpl-title').value = t.title || '';
  document.getElementById('tmpl-body').value = t.body || '';
  document.getElementById('tmpl-form-title').innerText = 'Edit Template';
  document.getElementById('tmpl-save-btn').innerText = 'Save Changes';
  document.getElementById('tmpl-cancel-btn').classList.remove('hidden');
}

function cancelTmplEdit() {
  editingTmplId = null;
  clearTmplForm();
  document.getElementById('tmpl-form-title').innerText = 'Add Reminder Template';
  document.getElementById('tmpl-save-btn').innerText = 'Save Template';
  document.getElementById('tmpl-cancel-btn').classList.add('hidden');
}

function clearTmplForm() {
  document.getElementById('tmpl-title').value = '';
  document.getElementById('tmpl-body').value = '';
}

async function deleteTemplate(id) {
  const t = templateStore.find(i => String(i.id) === String(id));
  if (!confirm('Delete this template?')) return;
  const { error } = await supabaseClient.from('reminder_templates').delete().eq('id', id);
  if (error) alert(error.message);
  else {
    await logActivity('Deleted Template', `Removed template "${t ? t.title : id}"`);
    fetchTemplates();
  }
}

// --- MODULE 4: SEND IMMEDIATE SMS MODAL ---
async function openSendModal(custId) {
  activeModalCust = customerStore.find(c => String(c.id) === String(custId));
  if (!activeModalCust) return alert('Contact not found.');

  document.getElementById('modal-cust-name').innerText = `${activeModalCust.first_name || ''} ${activeModalCust.last_name || ''}`;
  document.getElementById('modal-cust-phone').innerText = formatForDisplay(activeModalCust.phone) || 'No Phone Number';
  document.getElementById('modal-message-preview').value = '';

  await fetchTemplatesQuietly();
  const select = document.getElementById('modal-template-select');
  select.innerHTML = '<option value="">-- Choose a Template --</option>';

  if (templateStore.length === 0) {
    select.innerHTML = '<option value="">No saved templates available</option>';
  } else {
    templateStore.forEach(t => {
      select.innerHTML += `<option value="${t.id}">${t.title}</option>`;
    });
  }

  document.getElementById('send-modal').classList.remove('hidden');
}

function applyTemplateToPreview() {
  const selectedId = document.getElementById('modal-template-select').value;
  if (!selectedId || !activeModalCust) {
    document.getElementById('modal-message-preview').value = '';
    return;
  }

  const tmpl = templateStore.find(t => String(t.id) === String(selectedId));
  if (!tmpl) return;

  let text = tmpl.body;
  text = text.replace(/\{first_name\}/g, activeModalCust.first_name || '');
  text = text.replace(/\{last_name\}/g, activeModalCust.last_name || '');
  text = text.replace(/\{email\}/g, activeModalCust.email || '');
  text = text.replace(/\{phone\}/g, formatForDisplay(activeModalCust.phone) || '');

  document.getElementById('modal-message-preview').value = text;
}

async function executeSendMessage() {
  const messageText = document.getElementById('modal-message-preview').value;
  if (!messageText) return alert('Message body cannot be empty.');
  if (!activeModalCust || !activeModalCust.phone) return alert('Contact has no phone number listed.');
  if (!currentUserId) return alert('User session expired. Please log in again.');

  const custName = `${activeModalCust.first_name || ''} ${activeModalCust.last_name || ''}`;
  
  try {
    const res = await fetch('/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUserId,
        phone: activeModalCust.phone,
        message: messageText
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || 'Failed to send SMS');

    await logActivity('Sent SMS', `Sent to ${custName} (${activeModalCust.phone}): "${messageText}"`);

    alert(`SMS successfully delivered to ${custName}!`);
    closeSendModal();
  } catch (err) {
    alert('SMS Send Error: ' + err.message);
  }
}

function closeSendModal() {
  activeModalCust = null;
  document.getElementById('send-modal').classList.add('hidden');
}

// --- MODULE 5: ACTIVITY HISTORY ---
async function fetchHistory() {
  const tbody = document.getElementById('history-list-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3">Loading...</td></tr>';
  const { data, error } = await supabaseClient.from('activity_history').select('*').order('created_at', { ascending: false });
  if (error) return tbody.innerHTML = '<tr><td colspan="3">Error loading activity logs.</td></tr>';
  if (!data || data.length === 0) return tbody.innerHTML = '<tr><td colspan="3">No history recorded yet.</td></tr>';
  tbody.innerHTML = '';
  data.forEach(h => {
    const time = new Date(h.created_at).toLocaleString();
    tbody.innerHTML += `
      <tr>
        <td style="font-size:12px; color:#666;">${time}</td>
        <td><strong>${h.action}</strong></td>
        <td>${h.details || ''}</td>
      </tr>`;
  });
}

// --- MODULE 6: BILLING & SUBSCRIPTION CONTROLLER ---
async function fetchBillingDetails() {
  if (!currentUserId) return;

  const { data: customer, error } = await supabaseClient
    .from('practices')
    .select('*')
    .eq('user_id', currentUserId)
    .maybeSingle();

  if (error || !customer) return;

  const planTier = customer.plan_tier || 'trial';
  const sentCount = customer.sms_sent_this_month || 0;
  const limitCount = customer.sms_limit || 100;

  // 1. Populate Usage & Plan Badge
  const badge = document.getElementById('billing-plan-badge');
  const sentEl = document.getElementById('billing-sms-sent');
  const limitEl = document.getElementById('billing-sms-limit');
  const autoUpgradeEl = document.getElementById('billing-auto-upgrade');

  if (badge) badge.innerText = planTier.toUpperCase();
  if (sentEl) sentEl.innerText = sentCount;
  if (limitEl) limitEl.innerText = limitCount;
  if (autoUpgradeEl) autoUpgradeEl.checked = customer.auto_upgrade_enabled || false;

  const percent = Math.min(100, Math.round((sentCount / limitCount) * 100));
  const bar = document.getElementById('billing-progress-bar');
  if (bar) {
    bar.style.width = `${percent}%`;
    bar.style.backgroundColor = percent > 90 ? '#E51A24' : '#00B04F';
  }

  // 2. Load Saved BYOC Gateway Settings
  const provSelect = document.getElementById('provider-select');
  const provKey = document.getElementById('provider-key');
  const provSid = document.getElementById('provider-sid');
  const provPhone = document.getElementById('provider-phone');

  if (provSelect && customer.provider_type) provSelect.value = customer.provider_type;
  if (provKey) provKey.value = customer.provider_api_key || '';
  if (provSid) provSid.value = customer.provider_account_sid || '';
  if (provPhone) provPhone.value = customer.provider_phone_number || '';

  // Load A2P status badge if present
  const a2pBadge = document.getElementById('a2p-status-badge');
  if (a2pBadge && customer.a2p_status) {
    a2pBadge.innerText = customer.a2p_status.toUpperCase();
    a2pBadge.style.background = customer.a2p_status === 'approved' ? '#dcfce7' : '#fef3c7';
    a2pBadge.style.color = customer.a2p_status === 'approved' ? '#15803d' : '#b45309';
  }

  toggleProviderFields();

  // 3. Trigger Trial Modal Check
  if (planTier === 'trial') {
    const modalSent = document.getElementById('trial-modal-sent');
    const modalLimit = document.getElementById('trial-modal-limit');
    if (modalSent) modalSent.innerText = sentCount;
    if (modalLimit) modalLimit.innerText = limitCount;
    
    if (!sessionStorage.getItem('trialModalShown')) {
      const trialModal = document.getElementById('trial-modal');
      if (trialModal) trialModal.classList.remove('hidden');
      sessionStorage.setItem('trialModalShown', 'true');
    }
  }
}

function closeTrialModal() {
  const modal = document.getElementById('trial-modal');
  if (modal) modal.classList.add('hidden');
}

async function toggleAutoUpgrade(isEnabled) {
  if (!currentUserId) return;
  const { error } = await supabaseClient
    .from('practices')
    .update({ auto_upgrade_enabled: isEnabled })
    .eq('user_id', currentUserId);

  if (error) {
    alert('Failed to update auto-upgrade setting.');
    const el = document.getElementById('billing-auto-upgrade');
    if (el) el.checked = !isEnabled;
  }
}

async function triggerCheckout(planTier) {
  if (!currentUserId) return alert('Please log in first.');
  const autoUpgradeEl = document.getElementById('billing-auto-upgrade');
  const autoUpgrade = autoUpgradeEl ? autoUpgradeEl.checked : false;

  try {
    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUserId,
        planTier: planTier,
        autoUpgrade: autoUpgrade
      })
    });

    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Checkout initiation failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error initiating payment session.');
  }
}

// --- MODULE 7: BYOC GATEWAY & PROVISIONING CONTROLLER ---
function toggleProviderFields() {
  const providerEl = document.getElementById('provider-select');
  if (!providerEl) return;

  const provider = providerEl.value;
  const credsDiv = document.getElementById('provider-credentials');
  const sidInput = document.getElementById('provider-sid');
  const instructionsDiv = document.getElementById('provider-instructions');

  if (provider === 'system') {
    if (credsDiv) credsDiv.classList.add('hidden');
    if (instructionsDiv) {
      instructionsDiv.innerHTML = '<p style="color: #64748b;"><strong>Built-in Gateway Selected:</strong> Outbound messages dispatch automatically via our system master Twilio account. No extra setup required.</p>';
    }
    return;
  }

  if (credsDiv) credsDiv.classList.remove('hidden');

  if (provider === 'twilio') {
    if (sidInput) sidInput.classList.remove('hidden');
    const keyInput = document.getElementById('provider-key');
    if (keyInput) keyInput.placeholder = 'Auth Token (or API Secret)';
    if (instructionsDiv) {
      instructionsDiv.innerHTML = `
        <strong>Twilio Setup Guide:</strong>
        <ol style="margin-top: 6px; padding-left: 20px; line-height: 1.5;">
          <li>Log in to your <strong>Twilio Console</strong>.</li>
          <li>Copy your <strong>Account SID</strong> and <strong>Auth Token</strong>.</li>
          <li>Enter your verified Twilio phone number in E.164 format (+1XXXXXXXXXX).</li>
        </ol>
      `;
    }
  } else if (provider === 'quo') {
    if (sidInput) sidInput.classList.add('hidden');
    const keyInput = document.getElementById('provider-key');
    if (keyInput) keyInput.placeholder = 'Quo API Key';
    if (instructionsDiv) {
      instructionsDiv.innerHTML = `
        <strong>Quo (formerly OpenPhone) Setup Guide:</strong>
        <ol style="margin-top: 6px; padding-left: 20px; line-height: 1.5;">
          <li>Log in to your <strong>Quo Workspace</strong> (Admin role required).</li>
          <li>Navigate to <strong>Settings → API</strong> and click <strong>Generate API Key</strong>.</li>
          <li>Paste the key above along with your Quo phone number.</li>
        </ol>
      `;
    }
  } else if (provider === 'telnyx') {
    if (sidInput) sidInput.classList.add('hidden');
    const keyInput = document.getElementById('provider-key');
    if (keyInput) keyInput.placeholder = 'Telnyx V2 API Key';
    if (instructionsDiv) {
      instructionsDiv.innerHTML = `
        <strong>Telnyx Setup Guide:</strong>
        <ol style="margin-top: 6px; padding-left: 20px; line-height: 1.5;">
          <li>Log in to the <strong>Telnyx Portal</strong>.</li>
          <li>Go to <strong>API Keys</strong> and generate a V2 API Key.</li>
          <li>Enter your Telnyx phone number assigned to an active Messaging Profile.</li>
        </ol>
      `;
    }
  }
}

async function saveProviderSettings() {
  if (!currentUserId) return alert('User session expired. Please log in again.');

  const provider_type = document.getElementById('provider-select').value;
  const provider_api_key = document.getElementById('provider-key').value.trim();
  const provider_account_sid = document.getElementById('provider-sid').value.trim();
  const provider_phone_number = document.getElementById('provider-phone').value.trim();

  const { error } = await supabaseClient
    .from('practices')
    .update({
      provider_type,
      provider_api_key,
      provider_account_sid,
      provider_phone_number
    })
    .eq('user_id', currentUserId);

  if (error) {
    alert('Error saving provider settings: ' + error.message);
  } else {
    alert('SMS Gateway settings saved successfully!');
    await logActivity('Updated Gateway', `Switched gateway mode to: ${provider_type.toUpperCase()}`);
    await fetchBillingDetails();
  }
}

// --- MODULE 8: A2P ISV & NUMBER PROVISIONING HANDLERS ---
async function searchAvailableNumbers() {
  const areaCodeInput = document.getElementById('area-code-input');
  if (!areaCodeInput) return;
  
  const areaCode = areaCodeInput.value;
  if (!areaCode || areaCode.length !== 3) return alert('Enter a valid 3-digit area code.');

  try {
    const res = await fetch('/api/provision-number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'search', areaCode })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Search failed');

    const select = document.getElementById('available-numbers-select');
    if (!select) return;

    select.innerHTML = '';
    data.numbers.forEach(num => {
      select.innerHTML += `<option value="${num}">${formatForDisplay(num)}</option>`;
    });

    const resContainer = document.getElementById('number-results-container');
    if (resContainer) resContainer.classList.remove('hidden');
  } catch (err) {
    alert('Number Search Error: ' + err.message);
  }
}

async function buySelectedNumber() {
  const select = document.getElementById('available-numbers-select');
  if (!select) return;

  const phoneNumber = select.value;
  if (!confirm(`Provision ${formatForDisplay(phoneNumber)} as your practice sending number?`)) return;

  try {
    const res = await fetch('/api/provision-number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, action: 'buy', phoneNumber })
    });

    const data = await res.json();
    if (res.ok) {
      alert(`Success! Dedicated number ${formatForDisplay(data.phoneNumber)} is active for your practice.`);
      fetchBillingDetails();
    } else {
      throw new Error(data.error || 'Provisioning failed');
    }
  } catch (err) {
    alert('Provisioning Error: ' + err.message);
  }
}

async function submitA2PRegistration(event) {
  if (event) event.preventDefault();
  
  const payload = {
    userId: currentUserId,
    legalName: document.getElementById('a2p-legal-name').value,
    ein: document.getElementById('a2p-ein').value,
    businessType: document.getElementById('a2p-type').value,
    address: document.getElementById('a2p-address').value,
    city: document.getElementById('a2p-city').value,
    state: document.getElementById('a2p-state').value,
    postalCode: document.getElementById('a2p-zip').value
  };

  try {
    const res = await fetch('/api/register-a2p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');

    alert('Registration details submitted! Carrier verification takes 2-5 business days.');
    fetchBillingDetails();
  } catch (err) {
    alert('A2P Submission Error: ' + err.message);
  }
}
