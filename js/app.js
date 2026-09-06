/* =========================================================
   app.js — application controller: auth flow, navigation,
   rendering, and all interaction wiring.
   ========================================================= */
(() => {
'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const M = Model;

// ---------------------------------------------------------
// Global state
// ---------------------------------------------------------
const S = {
  period: 'month',
  customRange: null,
  nav: 'home',
  summaryIdx: 0,
  txnFilter: { kind: 'all', method: 'all', categoryId: null, sort: 'newest' },
  subpageStack: [],
  autoLockTimer: null,
  pinBuffer: '',
  pinStage: 'create', // create -> confirm
  pinFirstEntry: '',
  aiHistory: [],
  aiBusy: false,
};

function D() { return Store.data(); }
function prefs() { return Store.getPrefs(); }
function curSym() { return prefs().currency || '₹'; }
function fmt(n) { return M.currencyFmt(n, curSym()); }

// ---------------------------------------------------------
// Toast / success / modal helpers
// ---------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function showSuccess(text) {
  $('#success-text').textContent = text;
  $('#success-overlay').classList.add('show');
  setTimeout(() => $('#success-overlay').classList.remove('show'), 1100);
}
// ===========================================================
// BACK-NAVIGATION GUARD
// Every overlay/subpage push exactly one history entry when it
// opens, and consumes it (history.back()) when it closes — unless
// the close was itself triggered by a popstate (physical/browser
// back), in which case the browser already consumed it. This makes
// the device/browser back button close the topmost open thing
// instead of exiting the app, without ever requiring more than one
// back press to undo one open.
// ===========================================================
let _inPopHandler = false;
function pushBackGuard() { history.pushState({ vaultUi: true }, '', location.href); }
function consumeBackGuard() { if (!_inPopHandler) history.back(); }

window.addEventListener('popstate', () => {
  _inPopHandler = true;
  if ($('#modal').classList.contains('open')) { closeModal(); }
  else if (!$('#ai-overlay').classList.contains('hidden')) { closeAssistant(); }
  else if ($('#txn-sheet').classList.contains('open')) { closeTxnSheet(); }
  else if ($('#drawer').classList.contains('open')) { closeDrawer(); }
  else if (!$('#search-overlay').classList.contains('hidden')) { closeSearchOverlay(); }
  else if (!$('#notif-overlay').classList.contains('hidden')) { closeNotifOverlay(); }
  else if (!$('#calendar-overlay').classList.contains('hidden')) { closeCalendarOverlay(); }
  else if (S.subpageStack.length) { S.subpageStack = []; goNav(S.nav); }
  _inPopHandler = false;
});

function openModal(html, opts) {
  $('#modal-body').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
  $('#modal-overlay').classList.add('show');
  $('#modal').classList.add('open');
  if (!opts || !opts.keepOnOverlayClick) {
    $('#modal-overlay').onclick = closeModal;
  }
  pushBackGuard();
}
function closeModal() {
  $('#modal').classList.remove('open');
  $('#modal-overlay').classList.remove('show');
  setTimeout(() => $('#modal-overlay').classList.add('hidden'), 200);
  consumeBackGuard();
}
function confirmDialog(title, msg, okLabel, onOk, danger) {
  openModal(`
    <h3>${title}</h3>
    <p class="muted">${msg}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cd-cancel">Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cd-ok">${okLabel}</button>
    </div>`);
  $('#cd-cancel').onclick = closeModal;
  $('#cd-ok').onclick = () => { closeModal(); onOk(); };
}

// ---------------------------------------------------------
// Theme
// ---------------------------------------------------------
function applyTheme() {
  const p = prefs();
  const t = p.theme || 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  if (p.bgColor) document.documentElement.style.setProperty('--bg', p.bgColor);
  else document.documentElement.style.removeProperty('--bg');
}

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  applyTheme();
  wireGlobalUI();
  wireAuthScreens();
  await Store.refreshSession();
  Store.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { hideAllAuthScreens(); showAuth(); }
    else if (event === 'SIGNED_IN' && $('#view-auth') && !$('#view-auth').classList.contains('hidden')) {
      // e.g. a Google OAuth redirect resolving after the initial page load
      routeFromAuthState();
    }
  });
  await routeFromAuthState();
}

async function routeFromAuthState() {
  hideAllAuthScreens();
  const session = Store.session();
  if (!session) { showAuth(); return; }
  const household = await Store.loadHousehold();
  if (!household) { showHouseholdSetup(); return; }
  if (Store.hasLegacyVault()) { showMigrate(); return; }
  await enterDeviceLockOrApp();
}

async function enterDeviceLockOrApp() {
  const userId = Store.currentUser().id;
  if (Store.hasDeviceLock(userId)) {
    showLock();
  } else {
    showSetupPin();
  }
}

function hideAllAuthScreens() {
  ['view-auth','view-household-setup','view-migrate','view-setup-pin','view-lock'].forEach(id => $('#' + id).classList.add('hidden'));
}

// ===========================================================
// AUTH SCREEN (Supabase sign in / sign up / Google)
// ===========================================================
let authMode = 'signin';
function wireAuthScreens() {
  $('#auth-tab-signin').onclick = () => setAuthMode('signin');
  $('#auth-tab-signup').onclick = () => setAuthMode('signup');
  $('#auth-submit').onclick = submitAuth;
  $('#btn-google-signin').onclick = async () => {
    try { await Store.signInGoogle(); } catch (e) { showAuthError(e.message); }
  };
  $('#auth-forgot').onclick = async () => {
    const email = $('#auth-email').value.trim();
    if (!email) { showAuthError('Enter your email above first, then tap "Forgot password?".'); return; }
    try { await Store.resetPassword(email); toast('Password reset email sent.'); }
    catch (e) { showAuthError(e.message); }
  };

  // household setup
  $('#hh-tab-create').onclick = () => setHhMode('create');
  $('#hh-tab-join').onclick = () => setHhMode('join');
  $('#hh-create-btn').onclick = async () => {
    const name = $('#hh-name').value.trim() || 'My Household';
    $('#hh-create-btn').disabled = true;
    try {
      await Store.createHouseholdFlow(name, 0, 'bank', !Store.hasLegacyVault());
      await afterHouseholdReady();
    } catch (e) { showHhError(e.message); $('#hh-create-btn').disabled = false; }
  };
  $('#hh-join-btn').onclick = async () => {
    const code = $('#hh-code').value.trim();
    if (!code) { showHhError('Enter the join code.'); return; }
    $('#hh-join-btn').disabled = true;
    try {
      await Store.joinHouseholdFlow(code);
      await afterHouseholdReady();
    } catch (e) { showHhError('Invalid join code.'); $('#hh-join-btn').disabled = false; }
  };
  $('#hh-signout').onclick = async () => { await Store.signOut(); hideAllAuthScreens(); showAuth(); };

  // migration
  buildKeypad('#keypad-migrate', handleMigrateKey);
  $('#migrate-skip').onclick = async () => { Store.wipeLegacyVault(); hideAllAuthScreens(); await enterDeviceLockOrApp(); };

  // device pin setup
  buildKeypad('#keypad-devpin', handleDevPinSetupKey);
  $('#devpin-skip').onclick = async () => { hideAllAuthScreens(); await finishBootIntoApp(); };
}

function setAuthMode(mode) {
  authMode = mode;
  $('#auth-tab-signin').classList.toggle('active', mode === 'signin');
  $('#auth-tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-submit').textContent = mode === 'signin' ? 'Sign In' : 'Create Account';
  $('#auth-hint').textContent = mode === 'signup' ? 'Password must be at least 6 characters.' : '';
  $('#auth-error').classList.add('hidden');
}
function showAuthError(msg) { const e = $('#auth-error'); e.textContent = msg; e.classList.remove('hidden'); }
function showHhError(msg) { const e = $('#hh-error'); e.textContent = msg; e.classList.remove('hidden'); }

function showAuth() {
  $('#view-auth').classList.remove('hidden');
  setAuthMode('signin');
}

async function submitAuth() {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  $('#auth-error').classList.add('hidden');
  if (!email || !password) { showAuthError('Enter both email and password.'); return; }
  $('#auth-submit').disabled = true;
  try {
    if (authMode === 'signup') {
      const d = await Store.signUpEmail(email, password);
      if (d.session) { await routeFromAuthState(); }
      else { toast('Check your email to confirm your account, then sign in.'); setAuthMode('signin'); }
    } else {
      await Store.signInEmail(email, password);
      await routeFromAuthState();
    }
  } catch (e) { showAuthError(e.message); }
  $('#auth-submit').disabled = false;
}

// ===========================================================
// HOUSEHOLD SETUP
// ===========================================================
let hhMode = 'create';
function setHhMode(mode) {
  hhMode = mode;
  $('#hh-tab-create').classList.toggle('active', mode === 'create');
  $('#hh-tab-join').classList.toggle('active', mode === 'join');
  $('#hh-step-create').classList.toggle('hidden', mode !== 'create');
  $('#hh-step-join').classList.toggle('hidden', mode !== 'join');
  $('#hh-error').classList.add('hidden');
}
function showHouseholdSetup() {
  $('#view-household-setup').classList.remove('hidden');
  setHhMode('create');
}
async function afterHouseholdReady() {
  hideAllAuthScreens();
  if (Store.hasLegacyVault()) { showMigrate(); return; }
  await enterDeviceLockOrApp();
}

// ===========================================================
// MIGRATION (import old local-only vault)
// ===========================================================
function showMigrate() {
  $('#view-migrate').classList.remove('hidden');
  S.pinBuffer = '';
  renderPinDots('#pin-dots-migrate', 0, 6);
}
async function handleMigrateKey(k) {
  if (k === '⌫') { S.pinBuffer = S.pinBuffer.slice(0, -1); }
  else if (S.pinBuffer.length < 6) { S.pinBuffer += k; }
  renderPinDots('#pin-dots-migrate', S.pinBuffer.length, 6);
  if (S.pinBuffer.length === 6) {
    try {
      const oldData = await Store.unlockLegacyVault(S.pinBuffer);
      $('#migrate-error').classList.add('hidden');
      toast('Importing your data…');
      await Store.bulkImport(oldData);
      Store.wipeLegacyVault();
      showSuccess('✓ Import Complete\nYour data is now in the cloud');
      hideAllAuthScreens();
      await enterDeviceLockOrApp();
    } catch (e) {
      $('#migrate-error').textContent = 'Incorrect PIN for the old local data.'; $('#migrate-error').classList.remove('hidden');
      setTimeout(() => { S.pinBuffer = ''; renderPinDots('#pin-dots-migrate', 0, 6); }, 350);
    }
  }
}

// ===========================================================
// DEVICE PIN — one-time setup screen + change flow helpers
// ===========================================================
function buildKeypad(sel, handler) {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  $(sel).innerHTML = keys.map(k => k === '' ? `<button class="key-blank"></button>` : `<button data-k="${k}">${k}</button>`).join('');
  $all('button', $(sel)).forEach(b => { if (!b.classList.contains('key-blank')) b.onclick = () => handler(b.dataset.k); });
}
function renderPinDots(sel, filled, total) {
  $(sel).innerHTML = Array.from({ length: total }).map((_, i) => `<div class="pin-dot ${i < filled ? 'filled' : ''}"></div>`).join('');
}

function showSetupPin() {
  $('#view-setup-pin').classList.remove('hidden');
  S.pinBuffer = ''; S.pinFirstEntry = ''; S.pinStage = 'create';
  $('#devpin-label').textContent = 'Create a 6-digit PIN';
  $('#devpin-confirm-wrap').classList.add('hidden');
  renderPinDots('#pin-dots-devcreate', 0, 6);
  renderPinDots('#pin-dots-devconfirm', 0, 6);
}
async function handleDevPinSetupKey(k) {
  const isConfirm = S.pinStage === 'confirm';
  const dotsSel = isConfirm ? '#pin-dots-devconfirm' : '#pin-dots-devcreate';
  if (k === '⌫') { S.pinBuffer = S.pinBuffer.slice(0, -1); }
  else if (S.pinBuffer.length < 6) { S.pinBuffer += k; }
  renderPinDots(dotsSel, S.pinBuffer.length, 6);
  if (S.pinBuffer.length === 6) {
    if (!isConfirm) {
      S.pinFirstEntry = S.pinBuffer; S.pinBuffer = ''; S.pinStage = 'confirm';
      $('#devpin-label').textContent = 'Confirm your PIN';
      $('#devpin-confirm-wrap').classList.remove('hidden');
      renderPinDots('#pin-dots-devconfirm', 0, 6);
    } else if (S.pinBuffer === S.pinFirstEntry) {
      await Store.setDeviceLock(Store.currentUser().id, S.pinBuffer);
      hideAllAuthScreens();
      await finishBootIntoApp();
    } else {
      const err = $('#devpin-error');
      err.textContent = "PINs don't match. Try again."; err.classList.remove('hidden');
      S.pinStage = 'create'; S.pinBuffer = ''; S.pinFirstEntry = '';
      $('#devpin-label').textContent = 'Create a 6-digit PIN';
      $('#devpin-confirm-wrap').classList.add('hidden');
      renderPinDots('#pin-dots-devcreate', 0, 6);
    }
  }
}

// ===========================================================
// LOCK FLOW (local device PIN, gates an already-authenticated session)
// ===========================================================
async function showLock() {
  $('#view-lock').classList.remove('hidden');
  S.pinBuffer = '';
  renderPinDots('#pin-dots-unlock', 0, 6);
  buildKeypad('#keypad-lock', handleLockKey);
  const p = prefs();
  $('#lock-subtitle').textContent = p.name ? `Enter your PIN to unlock, ${p.name}` : 'Enter your PIN to unlock';
  const userId = Store.currentUser().id;
  const bioBtn = $('#btn-biometric-unlock');
  if (Store.biometricEnabled(userId) && VaultWebAuthn.isSupported()) {
    bioBtn.classList.remove('hidden');
    bioBtn.onclick = async () => {
      try {
        const ok = await Store.verifyBiometric(userId);
        if (!ok) throw new Error('failed');
        $('#view-lock').classList.add('hidden');
        await finishBootIntoApp();
      } catch (e) { toast('Biometric unlock failed. Use your PIN.'); }
    };
  } else {
    bioBtn.classList.add('hidden');
  }
  $('#btn-forgot-pin').onclick = forgotPinFlow;
}

async function handleLockKey(k) {
  if (k === '⌫') { S.pinBuffer = S.pinBuffer.slice(0, -1); }
  else if (S.pinBuffer.length < 6) { S.pinBuffer += k; }
  renderPinDots('#pin-dots-unlock', S.pinBuffer.length, 6);
  if (S.pinBuffer.length === 6) {
    const ok = await Store.verifyDeviceLock(Store.currentUser().id, S.pinBuffer);
    if (ok) {
      $('#lock-error').classList.add('hidden');
      $('#view-lock').classList.add('hidden');
      await finishBootIntoApp();
    } else {
      $('#lock-error').classList.remove('hidden');
      $all('.pin-dot', $('#pin-dots-unlock')).forEach(d => d.classList.add('err'));
      setTimeout(() => { S.pinBuffer = ''; renderPinDots('#pin-dots-unlock', 0, 6); }, 350);
    }
  }
}

function forgotPinFlow() {
  openModal(`
    <h3>Forgot your device PIN?</h3>
    <p class="muted">No problem — your data lives safely in the cloud, not behind this PIN. Sign out here and sign back in with your email/password or Google account, then set a new device PIN.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="forgot-cancel">Cancel</button>
      <button class="btn btn-danger" id="forgot-ok">Sign In Again</button>
    </div>`);
  $('#forgot-cancel').onclick = closeModal;
  $('#forgot-ok').onclick = async () => {
    closeModal();
    Store.clearDeviceLock(Store.currentUser().id);
    await Store.signOut();
    hideAllAuthScreens();
    showAuth();
  };
}

// ===========================================================
// ENTER APP / AUTO-LOCK
// ===========================================================
async function finishBootIntoApp() {
  toast('Loading your household…');
  await Store.loadAllData();
  Store.startRealtime((table) => { refreshNotifDot(); refreshCurrentView(); });
  enterApp();
}

function enterApp() {
  $('#app-shell').classList.remove('hidden');
  runRecurringEngine();
  renderDrawerHead();
  goNav('home');
  resetAutoLockTimer();
  ['click','keydown','touchstart','mousemove'].forEach(evt => document.addEventListener(evt, resetAutoLockTimer, { passive: true }));
}

function resetAutoLockTimer() {
  clearTimeout(S.autoLockTimer);
  const mins = prefs().autoLockMinutes;
  if (!mins || mins <= 0) return;
  S.autoLockTimer = setTimeout(doLock, mins * 60 * 1000);
}

function doLock() {
  Store.stopRealtime();
  $('#app-shell').classList.add('hidden');
  closeAllOverlays();
  showLock();
}

function closeAllOverlays() {
  // Each close*() call consumes exactly one pushed history entry, so only
  // call it for things that are actually open — otherwise this would
  // consume phantom entries and desync the back-navigation guard.
  if ($('#drawer').classList.contains('open')) closeDrawer();
  if (!$('#search-overlay').classList.contains('hidden')) closeSearchOverlay();
  if (!$('#notif-overlay').classList.contains('hidden')) closeNotifOverlay();
  if (!$('#calendar-overlay').classList.contains('hidden')) closeCalendarOverlay();
  if (!$('#ai-overlay').classList.contains('hidden')) closeAssistant();
  if ($('#txn-sheet').classList.contains('open')) closeTxnSheet();
  if ($('#modal').classList.contains('open')) closeModal();
}

// ===========================================================
// GLOBAL UI WIRING (topbar, drawer, nav, sheets)
// ===========================================================
function wireGlobalUI() {
  $('#btn-menu').onclick = () => { $('#drawer').classList.add('open'); $('#drawer-overlay').classList.remove('hidden'); setTimeout(() => $('#drawer-overlay').classList.add('show'), 10); pushBackGuard(); };
  $('#drawer-overlay').onclick = closeDrawer;
  $('.drawer-head').onclick = () => { closeDrawer(); goNav('home'); };
  $all('.drawer-item[data-nav]').forEach(b => b.onclick = () => { closeDrawer(); goNav(b.dataset.nav); });
  $all('.drawer-item[data-drawer]').forEach(b => b.onclick = () => { closeDrawer(); openDrawerPage(b.dataset.drawer); });
  $('#btn-lock-now').onclick = () => { closeDrawer(); doLock(); };
  $('#btn-sign-out').onclick = () => { closeDrawer(); confirmDialog('Sign Out?', 'You will need to sign in again with your email/password or Google account to see your household\'s data.', 'Sign Out', async () => {
    Store.stopRealtime();
    await Store.signOut();
    location.reload();
  }, true); };

  $all('.nav-btn').forEach(b => b.onclick = () => goNav(b.dataset.nav));
  $('#btn-add-fab').onclick = () => openTxnSheet({});

  $('#btn-search').onclick = openSearch;
  $('#btn-search-close').onclick = closeSearchOverlay;
  $('#search-input').oninput = () => renderSearchResults($('#search-input').value.trim().toLowerCase());

  $('#btn-notifications').onclick = openNotifications;
  $('#btn-notif-close').onclick = closeNotifOverlay;

  $('#btn-calendar').onclick = openCalendarOverlay;
  $('#btn-calendar-close').onclick = closeCalendarOverlay;

  $('#btn-settings-quick').onclick = () => goNav('more');

  $('#txn-sheet-overlay').onclick = closeTxnSheet;
  $('#btn-manage-categories').onclick = () => openDrawerPage('categories');

  $('#btn-ai-fab').onclick = openAssistant;
  $('#btn-ai-close').onclick = closeAssistant;
  $('#ai-overlay').onclick = (e) => { if (e.target.id === 'ai-overlay') closeAssistant(); };
  $('#ai-send').onclick = sendAssistantMessage;
  $('#ai-input').onkeydown = (e) => { if (e.key === 'Enter') sendAssistantMessage(); };

  $all('.tab-btn', $('#analytics-tabs')).forEach(b => b.onclick = () => {
    $all('.tab-btn', $('#analytics-tabs')).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $all('.analytics-pane').forEach(p => p.classList.add('hidden'));
    $('#analytics-' + b.dataset.tab).classList.remove('hidden');
    renderAnalyticsTab(b.dataset.tab);
  });
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer-overlay').classList.remove('show');
  setTimeout(() => $('#drawer-overlay').classList.add('hidden'), 250);
  consumeBackGuard();
}

function renderDrawerHead() {
  const p = prefs();
  const h = Store.household();
  $('#drawer-name').textContent = p.name ? `Hi, ${p.name}` : (Store.currentUser() ? Store.currentUser().email : 'Hi there');
  const sub = $('.drawer-sub');
  if (sub) sub.textContent = h ? h.name : 'Your Household';
}

function goNav(name) {
  // Switching bottom-nav tabs abandons any open subpage stack outright —
  // without this, a stale renderFn from a different tab could resurface
  // via the on-screen Back button later (the "wrong page" bug).
  if (S.subpageStack.length) { S.subpageStack = []; consumeBackGuard(); }
  S.nav = name;
  $all('.view').forEach(v => v.classList.add('hidden'));
  $all('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  const titles = { home: 'Dashboard', transactions: 'Transactions', analytics: 'Analytics', more: 'More' };
  const bar = $('#topbar-title');
  bar.textContent = titles[name] || 'Vault';
  bar.onclick = null; bar.classList.remove('topbar-title-clickable'); // only renderHomeTopbar() re-arms this, for 'home' only
  if (name === 'home') { $('#view-home').classList.remove('hidden'); renderHome(); }
  else if (name === 'transactions') { $('#view-transactions').classList.remove('hidden'); renderTransactionsView(); }
  else if (name === 'analytics') { $('#view-analytics').classList.remove('hidden'); renderAnalyticsTab('charts'); }
  else if (name === 'more') { $('#view-more').classList.remove('hidden'); renderMore(); }
}

// ===========================================================
// SUBPAGE NAVIGATION (category detail, account detail, editors)
// ===========================================================
function openSubpage(title, renderFn) {
  if (S.subpageStack.length === 0) pushBackGuard(); // one guard per subpage *session*, not per level
  S.subpageStack.push(renderFn);
  $all('.view').forEach(v => v.classList.add('hidden'));
  $('#view-subpage').classList.remove('hidden');
  $('#topbar-title').textContent = title;
  $('#topbar-title').onclick = null; $('#topbar-title').classList.remove('topbar-title-clickable'); // don't inherit Dashboard's household-switcher tap target
  $('#subpage-content').innerHTML = `<div class="subpage-back" id="subpage-back-btn">← Back</div><div id="subpage-inner"></div>`;
  $('#subpage-back-btn').onclick = subpageBack;
  renderFn($('#subpage-inner'));
}
function subpageBack() {
  S.subpageStack.pop();
  if (S.subpageStack.length) {
    const prev = S.subpageStack[S.subpageStack.length - 1];
    $('#subpage-content').innerHTML = `<div class="subpage-back" id="subpage-back-btn">← Back</div><div id="subpage-inner"></div>`;
    $('#subpage-back-btn').onclick = subpageBack;
    prev($('#subpage-inner'));
  } else {
    goNav(S.nav === 'home' ? 'home' : S.nav);
    consumeBackGuard(); // leaving subpage mode entirely: consume the one guard we pushed on entry
  }
}

// ===========================================================
// TIME FILTER
// ===========================================================
const PERIODS = [
  { id: 'today', label: 'Today' }, { id: 'week', label: 'This Week' }, { id: 'month', label: 'This Month' },
  { id: 'lastmonth', label: 'Last Month' }, { id: 'year', label: 'This Year' }, { id: 'all', label: 'All Time' },
  { id: 'custom', label: 'Custom' },
];
function renderTimeFilterRow() {
  $('#time-filter-row').innerHTML = PERIODS.map(p =>
    `<button class="chip ${S.period === p.id ? 'active' : ''}" data-p="${p.id}">${p.label}</button>`).join('');
  $all('.chip', $('#time-filter-row')).forEach(c => c.onclick = () => {
    if (c.dataset.p === 'custom') { openCalendarOverlay(); return; }
    S.period = c.dataset.p; renderHome();
  });
}
function currentRange() { return M.rangeForPeriod(S.period, S.customRange); }

function openCalendarOverlay() {
  $('#calendar-overlay').classList.remove('hidden');
  pushBackGuard();
  $('#calendar-body').innerHTML = `
    <p class="muted">Pick a custom date range for the dashboard.</p>
    <label class="field-label">From</label>
    <input type="date" class="input" id="cal-from" value="${(S.customRange && S.customRange.from) || M.todayStr()}">
    <label class="field-label">To</label>
    <input type="date" class="input" id="cal-to" value="${(S.customRange && S.customRange.to) || M.todayStr()}">
    <button class="btn btn-primary btn-block" id="cal-apply" style="margin-top:20px;">Apply</button>
    <div class="section-head"><h2>Quick Select</h2></div>
    <div class="filter-chip-row">${PERIODS.filter(p => p.id !== 'custom').map(p => `<button class="chip" data-p="${p.id}">${p.label}</button>`).join('')}</div>
  `;
  $('#cal-apply').onclick = () => {
    S.customRange = { from: $('#cal-from').value, to: $('#cal-to').value };
    S.period = 'custom';
    closeCalendarOverlay();
    renderHome();
  };
  $all('.chip', $('#calendar-body')).forEach(c => c.onclick = () => {
    S.period = c.dataset.p; closeCalendarOverlay(); renderHome();
  });
}
function closeCalendarOverlay() { $('#calendar-overlay').classList.add('hidden'); consumeBackGuard(); }

// ===========================================================
// HOME VIEW
// ===========================================================
function renderHome() {
  renderHomeTopbar();
  renderTimeFilterRow();
  renderSummaryScroller();
  renderCategoryGrid();
  renderHomeCharts();
}

// Lets you jump to another household's dashboard (including ones where
// you're just a member, seeing whatever that owner has shared with you)
// right from the Dashboard itself — only shown when you actually belong to
// more than one, so a single-household user sees the plain "Dashboard" title.
async function renderHomeTopbar() {
  const bar = $('#topbar-title');
  try {
    const list = await Store.listMyHouseholds();
    if (S.nav !== 'home') return; // user already navigated away while this was loading
    const h = Store.household();
    if (list.length > 1 && h) {
      bar.innerHTML = `Dashboard <span class="topbar-house-switch">· ${h.name} ▾</span>`;
      bar.onclick = () => openHouseholdsList();
      bar.classList.add('topbar-title-clickable');
    } else {
      bar.textContent = 'Dashboard';
      bar.onclick = null;
      bar.classList.remove('topbar-title-clickable');
    }
  } catch (e) { /* leave the plain "Dashboard" title on any failure */ }
}

function renderSummaryScroller() {
  const data = D();
  const range = currentRange();
  const allTxns = data.transactions;
  const periodTxns = M.txnsInRange(allTxns, range);
  const balance = M.totalBalance(data.accounts, allTxns); // always current, not period-filtered
  const income = M.sumCredit(periodTxns);
  const expense = M.sumDebit(periodTxns);
  const savings = income - expense;
  const debt = M.creditDebtOutstanding(data.accounts, data.categories, allTxns);

  const cards = [
    { label: 'TOTAL BALANCE', amount: balance, colors: ['#4f5bd5', '#6b74ea'], sub: [['Accounts', data.accounts.filter(a=>!a.archived).length + '']] },
    { label: 'TOTAL INCOME', amount: income, colors: ['#1f9d55', '#3dbf74'], sub: [['Period', periodLabel()]] },
    { label: 'TOTAL EXPENSE', amount: expense, colors: ['#d84f4f', '#e8746f'], sub: [['Period', periodLabel()]] },
    { label: 'TOTAL SAVINGS', amount: savings, colors: ['#3573d4', '#5b93ea'], sub: [['Income − Expense', '']] },
    { label: 'CREDIT / DEBT', amount: debt, colors: ['#8b5fd1', '#a67fe8'], sub: [['Outstanding', '']] },
  ];

  $('#summary-scroller').innerHTML = cards.map((c, i) => `
    <div class="summary-card" style="background:linear-gradient(135deg, ${c.colors[0]}, ${c.colors[1]})" data-idx="${i}">
      ${i === 0 ? `<button class="sc-eye" id="sc-eye-btn">👁</button>` : ''}
      <div class="sc-label">${c.label}</div>
      <div class="sc-amount num-anim" data-raw="${c.amount}">${fmt(c.amount)}</div>
      <div class="sc-sub">${c.sub.map(s => `<span>${s[0]} ${s[1]}</span>`).join('')}</div>
    </div>`).join('');

  $('#summary-dots').innerHTML = cards.map((_, i) => `<span class="${i === S.summaryIdx ? 'active' : ''}"></span>`).join('');

  const scroller = $('#summary-scroller');
  scroller.onscroll = () => {
    const idx = Math.round(scroller.scrollLeft / (scroller.firstElementChild.getBoundingClientRect().width + 12));
    if (idx !== S.summaryIdx) { S.summaryIdx = idx; $all('#summary-dots span').forEach((d, i) => d.classList.toggle('active', i === idx)); }
  };
  scroller.scrollLeft = 0;

  let hidden = false;
  const eyeBtn = $('#sc-eye-btn');
  if (eyeBtn) eyeBtn.onclick = (e) => {
    e.stopPropagation();
    hidden = !hidden;
    $all('.summary-card .sc-amount').forEach(el => { el.textContent = hidden ? '••••••' : fmt(parseFloat(el.dataset.raw)); });
  };
}

function periodLabel() { const p = PERIODS.find(p => p.id === S.period); return p ? p.label : ''; }

const CATEGORY_TYPE_SECTIONS = [
  { type: 'income', label: 'Income' },
  { type: 'expense', label: 'Expense' },
  { type: 'borrow', label: 'Money Borrowed' },
  { type: 'lend', label: 'Money Lent' },
  { type: 'financial', label: 'Savings, Investments & Other' },
];
const CAT_TYPE_TO_TXN_TYPE = { income: 'credit', expense: 'debit', borrow: 'borrow', lend: 'lend', financial: 'debit' };

function catCardHtml(c, data, range) {
  const total = M.categoryTotal(c.id, data.transactions, range);
  const budget = data.budgets.find(b => b.categoryId === c.id);
  let badge = '';
  if (budget && c.type === 'expense') {
    const spent = M.budgetSpent(c.id, data.transactions);
    const pct = budget.amount > 0 ? spent / budget.amount : 0;
    if (pct >= 1) badge = '🔴'; else if (pct >= 0.85) badge = '⚠️';
  }
  return `
    <div class="cat-card ${c.color}" data-cat="${c.id}">
      ${badge ? `<span class="cat-badge">${badge}</span>` : ''}
      <div class="cat-ico">${c.icon}</div>
      <div>
        <div class="cat-name">${c.name}</div>
        <div class="cat-amt">${fmt(total)}</div>
      </div>
      <div class="cat-actions">
        <button class="cat-btn" data-act="minus" data-cat="${c.id}">−</button>
        <button class="cat-btn" data-act="plus" data-cat="${c.id}">+</button>
      </div>
    </div>`;
}

function renderCategoryGrid() {
  const data = D();
  const range = currentRange();
  const cats = data.categories.filter(c => !c.archived).sort((a, b) => a.order - b.order);
  const grid = $('#category-grid');

  let html = '';
  CATEGORY_TYPE_SECTIONS.forEach(section => {
    const list = cats.filter(c => c.type === section.type);
    if (!list.length) return;
    html += `<div class="sep-title">${section.label}</div><div class="category-grid">${list.map(c => catCardHtml(c, data, range)).join('')}</div>`;
  });
  html += `<div class="category-grid"><div class="cat-card add-card" id="cat-add-card">+</div></div>`;
  grid.innerHTML = html;

  $all('.cat-card[data-cat]', grid).forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.cat-btn')) return;
      card.classList.add('selected');
      setTimeout(() => openCategoryDetail(card.dataset.cat), 90);
    });
  });
  $all('.cat-btn[data-act="plus"]', grid).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const cat = data.categories.find(c => c.id === b.dataset.cat);
    openTxnSheet({ type: CAT_TYPE_TO_TXN_TYPE[cat.type] || 'debit', categoryId: cat.id });
  });
  $all('.cat-btn[data-act="minus"]', grid).forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    openReduceSheet(b.dataset.cat);
  });
  $('#cat-add-card').onclick = () => openCategoryEditor(null);
}

function renderHomeCharts() {
  const data = D();
  const range = currentRange();
  const dist = M.expenseByCategory(data.categories, data.transactions, range).slice(0, 8);
  $('#chart-donut-card').innerHTML = Charts.donut(dist.map(d => ({ label: d.category.name, value: d.amount, color: swatchColor(d.category.color) })), { centerLabel: fmt(dist.reduce((s,d)=>s+d.amount,0)) });

  const series = M.monthlySeries(data.transactions, 6);
  $('#chart-bar-card').innerHTML = Charts.lineTrend(series.map(s => ({ label: s.label.split(' ')[0], expense: s.expense })));
  $('#chart-compare-card').innerHTML = Charts.barCompare(series.map(s => ({ label: s.label.split(' ')[0], income: s.income, expense: s.expense })));
}

function swatchColor(cls) {
  const map = { 'pal-0':'#d97a3c','pal-1':'#2f9e5c','pal-2':'#3d6fd1','pal-3':'#8a51c9','pal-4':'#c98f1f','pal-5':'#cf4d4d','pal-6':'#1a9a89','pal-7':'#5757c9','pal-8':'#c94d8d','pal-9':'#7a9a2b' };
  return map[cls] || '#4f5bd5';
}

// ===========================================================
// ADD / REDUCE TRANSACTION SHEET
// ===========================================================
function openTxnSheet(opts) {
  opts = opts || {};
  const data = D();
  const editing = opts.txnId ? data.transactions.find(t => t.id === opts.txnId) : null;
  const type = editing ? editing.type : (opts.type || 'debit');
  const isReversal = !!opts.isReversal;

  $('#txn-sheet-overlay').classList.remove('hidden');
  setTimeout(() => { $('#txn-sheet-overlay').classList.add('show'); $('#txn-sheet').classList.add('open'); }, 10);
  pushBackGuard();

  const cats = data.categories.filter(c => !c.archived);
  const accts = data.accounts.filter(a => !a.archived);
  const upiOptions = data.upiIds.map(u => `<option value="${u.upiId}">${u.upiId} (${u.provider || 'UPI'})</option>`).join('');

  $('#txn-sheet-body').innerHTML = `
    <div class="staggered">
      <h3 style="margin:6px 0 2px;">${editing ? 'Edit Transaction' : (isReversal ? 'Remove / Reverse Transaction' : 'Add Transaction')}</h3>
      <div class="type-toggle type-toggle-4">
        <button type="button" class="type-btn income ${type === 'credit' ? 'active' : ''}" data-type="credit">🟢 Income</button>
        <button type="button" class="type-btn expense ${type === 'debit' ? 'active' : ''}" data-type="debit">🔴 Expense</button>
        <button type="button" class="type-btn borrow ${type === 'borrow' ? 'active' : ''}" data-type="borrow">🔵 Borrowed</button>
        <button type="button" class="type-btn lend ${type === 'lend' ? 'active' : ''}" data-type="lend">🟣 Lent</button>
      </div>

      <label class="field-label">Amount</label>
      <div class="amount-input-wrap"><span class="currency-prefix">${curSym()}</span>
        <input class="input amount-input" id="tf-amount" inputmode="decimal" placeholder="0" value="${editing ? editing.amount : (opts.amount || '')}"></div>

      <label class="field-label">Category</label>
      <select class="input" id="tf-category"></select>

      <div class="field-row-2">
        <div>
          <label class="field-label">Payment Method</label>
          <select class="input" id="tf-method">${M.PAYMENT_METHODS.map(m => `<option ${editing && editing.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        </div>
        <div>
          <label class="field-label">Account</label>
          <select class="input" id="tf-account">${accts.map(a => `<option value="${a.id}" ${editing && editing.accountId === a.id ? 'selected' : (opts.accountId===a.id?'selected':'')}>${a.name}</option>`).join('')}</select>
        </div>
      </div>

      <div class="field-row-2">
        <div>
          <label class="field-label">Date</label>
          <input type="date" class="input" id="tf-date" value="${editing ? editing.date : M.todayStr()}">
        </div>
        <div>
          <label class="field-label">Time (optional)</label>
          <input type="time" class="input" id="tf-time" value="${editing ? (editing.time||'') : M.nowTime()}">
        </div>
      </div>

      <div id="tf-upi-wrap" class="hidden">
        <label class="field-label">UPI ID</label>
        <input class="input" id="tf-upi" list="tf-upi-list" placeholder="username@upi" value="${editing ? (editing.upiId||'') : ''}">
        <datalist id="tf-upi-list">${upiOptions}</datalist>
      </div>

      <label class="field-label">Description</label>
      <input class="input" id="tf-desc" placeholder="What was this transaction for?" value="${editing ? (editing.description||'') : (opts.description||'')}">

      <p class="error-text hidden" id="tf-error"></p>
      <button class="btn btn-primary btn-block" id="tf-save" style="margin-top:20px;">${editing ? 'Save Changes' : 'Save Transaction'}</button>
    </div>`;

  function populateCategories(t) {
    let filtered = cats.filter(c => {
      if (t === 'credit') return c.type === 'income';
      if (t === 'borrow') return c.type === 'borrow';
      if (t === 'lend') return c.type === 'lend';
      return c.type === 'expense' || c.type === 'financial'; // debit: expense + legacy financial categories
    });
    // A reversal (or an edit whose category type doesn't match the "opposite" filter,
    // e.g. reversing a Borrowed-category entry) must still be able to target its own
    // category, even if that category's type wouldn't normally show under this toggle.
    const forcedId = opts.categoryId || (editing && editing.categoryId);
    if (forcedId && !filtered.some(c => c.id === forcedId)) {
      const forced = cats.find(c => c.id === forcedId);
      if (forced) filtered = [forced, ...filtered];
    }
    $('#tf-category').innerHTML = filtered.length ? filtered.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('')
      : `<option value="">No categories yet — add one first</option>`;
    if (opts.categoryId) $('#tf-category').value = opts.categoryId;
    else if (editing) $('#tf-category').value = editing.categoryId;
  }
  let curType = type;
  populateCategories(curType);

  $all('.type-btn', $('#txn-sheet-body')).forEach(b => b.onclick = () => {
    $all('.type-btn', $('#txn-sheet-body')).forEach(x => x.classList.remove('active'));
    b.classList.add('active'); curType = b.dataset.type; populateCategories(curType);
  });

  function syncUpiVisibility() {
    $('#tf-upi-wrap').classList.toggle('hidden', $('#tf-method').value !== 'UPI');
  }
  $('#tf-method').onchange = syncUpiVisibility; syncUpiVisibility();

  $('#tf-save').onclick = () => saveTxnFromSheet({ editing, curType: () => curType, isReversal });
}

function openReduceSheet(categoryId) {
  const data = D();
  const cat = data.categories.find(c => c.id === categoryId);
  openModal(`
    <h3>Remove / Reverse — ${cat.name}</h3>
    <p class="muted">This won't just subtract a number — it records a proper reversing transaction so your history stays accurate (audit trail).</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="rr-cancel">Cancel</button>
      <button class="btn btn-primary" id="rr-continue">Continue</button>
    </div>`);
  $('#rr-cancel').onclick = closeModal;
  $('#rr-continue').onclick = () => {
    closeModal();
    // Reversal = an offsetting entry of the opposite cash direction, in the same category.
    const reverseMap = { income: 'debit', borrow: 'debit', expense: 'credit', financial: 'credit', lend: 'credit' };
    const reverseType = reverseMap[cat.type] || 'credit';
    openTxnSheet({ type: reverseType, categoryId: cat.id, description: 'Reversal / refund', isReversal: true });
  };
}

async function saveTxnFromSheet(ctx) {
  const amount = parseFloat($('#tf-amount').value);
  const categoryId = $('#tf-category').value;
  const method = $('#tf-method').value;
  const accountId = $('#tf-account').value;
  const date = $('#tf-date').value;
  const time = $('#tf-time').value;
  const description = $('#tf-desc').value.trim();
  const upiId = $('#tf-upi') ? $('#tf-upi').value.trim() : '';
  const err = $('#tf-error');
  err.classList.add('hidden');

  if (isNaN(amount) || $('#tf-amount').value === '') { return showErr('Please enter an amount.'); }
  if (amount <= 0) { return showErr('Please enter an amount greater than zero.'); }
  if (!categoryId) { return showErr('Please select a category.'); }
  if (!method) { return showErr('Please select a payment method.'); }
  if (!accountId) { return showErr('Please select an account.'); }
  if (!date) { return showErr('Please select a date.'); }
  if (method === 'UPI' && upiId && !M.isValidUpi(upiId)) { return showErr('That UPI ID doesn\'t look valid (e.g. name@bank).'); }

  function showErr(msg) { err.textContent = msg; err.classList.remove('hidden'); }

  const data = D();
  const type = ctx.curType();
  $('#tf-save').disabled = true;
  try {
    if (ctx.editing) {
      await Store.updateTransaction(ctx.editing.id, { type, amount, categoryId, paymentMethod: method, accountId, date, time, description, upiId });
    } else {
      await Store.addTransaction({
        type, amount, categoryId, paymentMethod: method, accountId, date, time, description,
        upiId, isReversal: !!ctx.isReversal
      });
    }
    if (method === 'UPI' && upiId && !data.upiIds.some(u => u.upiId === upiId)) {
      await Store.addUpi({ upiId, provider: '', linkedAccountName: '' });
    }
    closeTxnSheet();
    showSuccess(`✓ Transaction ${ctx.editing ? 'Updated' : 'Added'}\n${fmt(amount)} ${(TXN_TYPE_META[type] || TXN_TYPE_META.debit).label}`);
    refreshCurrentView();
  } catch (e) {
    showErr('Could not save: ' + e.message);
  }
  $('#tf-save').disabled = false;
}

function closeTxnSheet() {
  $('#txn-sheet').classList.remove('open');
  $('#txn-sheet-overlay').classList.remove('show');
  setTimeout(() => $('#txn-sheet-overlay').classList.add('hidden'), 300);
  consumeBackGuard();
}

function refreshCurrentView() {
  if (S.subpageStack.length) { S.subpageStack[S.subpageStack.length - 1]($('#subpage-inner')); return; }
  goNav(S.nav);
}

// ===========================================================
// CATEGORY DETAIL
// ===========================================================
// ===========================================================
// REUSABLE: time filter + sort + grouped list, usable inside any
// category/account view — not just the Dashboard. Each caller gets
// its own independent state (closure), so switching time period in
// one category never affects another, or the Dashboard.
// ===========================================================
const SORT_OPTIONS = [
  { id: 'newest', label: 'Newest → Oldest' },
  { id: 'oldest', label: 'Oldest → Newest' },
  { id: 'high', label: 'Highest Amount' },
  { id: 'low', label: 'Lowest Amount' },
];
function sortTxns(list, sortId) {
  const arr = list.slice();
  if (sortId === 'oldest') arr.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  else if (sortId === 'high') arr.sort((a, b) => b.amount - a.amount);
  else if (sortId === 'low') arr.sort((a, b) => a.amount - b.amount);
  else arr.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)); // newest first, default
  return arr;
}
function groupByDateLabel(list) {
  const groups = {};
  const order = [];
  list.forEach(t => {
    const key = groupLabel(t.date);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(t);
  });
  return order.map(key => ({ key, items: groups[key] }));
}
/**
 * Mounts a self-contained time-filter + sort + grouped-list widget into `root`.
 * `getTxns(range)` must return the already category/account/etc-filtered transactions for that range.
 */
function mountFilterableTxnList(root, opts) {
  const state = { period: opts.initialPeriod || 'month', customRange: null, sort: 'newest', method: 'all' };
  const wrapId = 'ftl-' + Math.random().toString(36).slice(2, 9);
  root.insertAdjacentHTML('beforeend', `
    <div class="time-filter-row" id="${wrapId}-time"></div>
    ${opts.showMethodFilter ? `<div class="filter-chip-row" id="${wrapId}-method"></div>` : ''}
    <div class="field-row-2" style="align-items:center;margin:10px 0;">
      <div class="muted" id="${wrapId}-total" style="font-weight:800;font-size:15px;color:var(--text);"></div>
      <select class="input" id="${wrapId}-sort" style="width:auto;justify-self:end;">${SORT_OPTIONS.map(s => `<option value="${s.id}">${s.label}</option>`).join('')}</select>
    </div>
    <div id="${wrapId}-list" class="txn-list"></div>
  `);
  function draw() {
    const range = M.rangeForPeriod(state.period, state.customRange);
    let list = opts.getTxns(range);
    if (opts.showMethodFilter && state.method !== 'all') list = list.filter(t => t.paymentMethod === state.method);
    const inflow = (t) => t.type === 'credit' || t.type === 'borrow';
    const total = list.reduce((s, t) => s + (inflow(t) ? t.amount : -t.amount), 0);
    $('#' + wrapId + '-total', root).textContent = `${list.length} transaction${list.length === 1 ? '' : 's'} · ${fmt(Math.abs(total))}`;
    const sorted = sortTxns(list, state.sort);
    const byAmount = state.sort === 'high' || state.sort === 'low';
    const groups = byAmount ? null : groupByDateLabel(sorted);
    $('#' + wrapId + '-list', root).innerHTML = !sorted.length
      ? `<div class="empty-hint">No transactions in this period.</div>`
      : byAmount
        ? sorted.map(txnRowHtml).join('')
        : groups.map(g => `<div class="sep-title">${g.key}</div>` + g.items.map(txnRowHtml).join('')).join('');
    $all('.txn-row', $('#' + wrapId + '-list', root)).forEach(r => r.onclick = () => openTransactionDetail(r.dataset.id));
  }
  $('#' + wrapId + '-time', root).innerHTML = PERIODS.map(p => `<button class="chip ${state.period === p.id ? 'active' : ''}" data-p="${p.id}">${p.label}</button>`).join('');
  $all('.chip', $('#' + wrapId + '-time', root)).forEach(c => c.onclick = () => {
    if (c.dataset.p === 'custom') { openLocalDateRangePicker((from, to) => { state.period = 'custom'; state.customRange = { from, to }; refreshTimeChips(); draw(); }); return; }
    state.period = c.dataset.p; state.customRange = null; refreshTimeChips(); draw();
  });
  function refreshTimeChips() {
    $all('.chip', $('#' + wrapId + '-time', root)).forEach(c => c.classList.toggle('active', c.dataset.p === state.period));
  }
  if (opts.showMethodFilter) {
    $('#' + wrapId + '-method', root).innerHTML = ['all', ...M.PAYMENT_METHODS].map(m => `<button class="chip ${m === 'all' ? 'active' : ''}" data-m="${m}">${m === 'all' ? 'All Methods' : m}</button>`).join('');
    $all('.chip', $('#' + wrapId + '-method', root)).forEach(c => c.onclick = () => {
      state.method = c.dataset.m;
      $all('.chip', $('#' + wrapId + '-method', root)).forEach(x => x.classList.toggle('active', x === c));
      draw();
    });
  }
  $('#' + wrapId + '-sort', root).onchange = (e) => { state.sort = e.target.value; draw(); };
  draw();
}
function openLocalDateRangePicker(onApply) {
  openModal(`
    <h3>Custom Date Range</h3>
    <label class="field-label">From</label>
    <input type="date" class="input" id="ldp-from" value="${M.todayStr()}">
    <label class="field-label">To</label>
    <input type="date" class="input" id="ldp-to" value="${M.todayStr()}">
    <div class="modal-actions"><button class="btn btn-ghost" id="ldp-cancel">Cancel</button><button class="btn btn-primary" id="ldp-apply">Apply</button></div>`);
  $('#ldp-cancel').onclick = closeModal;
  $('#ldp-apply').onclick = () => { const from = $('#ldp-from').value, to = $('#ldp-to').value; closeModal(); onApply(from, to); };
}

function openCategoryDetail(categoryId) {
  const data = D();
  const cat = data.categories.find(c => c.id === categoryId);
  openSubpage(cat.name, (root) => {
    root.innerHTML = `
      <div class="detail-header" style="background:${swatchColor(cat.color)}">
        <div class="dh-ico">${cat.icon}</div>
        <div class="dh-name">${cat.name}</div>
        <div class="dh-amt" id="cd-header-total"></div>
      </div>`;
    mountFilterableTxnList(root, {
      initialPeriod: S.period,
      showMethodFilter: true,
      getTxns: (range) => M.txnsInRange(D().transactions, range).filter(t => t.categoryId === categoryId),
    });
    // keep the header amount in sync with the all-time total (independent of the list's own period filter)
    $('#cd-header-total', root).textContent = fmt(M.categoryTotal(categoryId, data.transactions, null));
  });
}

// Four transaction types, one source of truth for label/sign/color everywhere.
const TXN_TYPE_META = {
  credit: { label: 'Income', tag: 'INCOME', sign: '+', cls: 'credit' },
  debit: { label: 'Expense', tag: 'EXPENSE', sign: '−', cls: 'debit' },
  borrow: { label: 'Money Borrowed', tag: 'MONEY BORROWED', sign: '+', cls: 'borrow' },
  lend: { label: 'Money Lent', tag: 'MONEY LENT', sign: '−', cls: 'lend' },
};
function txnRowHtml(t) {
  const data = D();
  const cat = data.categories.find(c => c.id === t.categoryId) || { icon: '💠', color: 'pal-7', name: 'Uncategorized' };
  const meta = TXN_TYPE_META[t.type] || TXN_TYPE_META.debit;
  return `<div class="txn-row" data-id="${t.id}">
    <div class="txn-ico ${cat.color}">${cat.icon}</div>
    <div class="txn-mid">
      <div class="txn-title">${t.description || cat.name}</div>
      <div class="txn-sub">${cat.name} · ${t.paymentMethod} · ${M.humanDateShort(t.date)}</div>
    </div>
    <div class="txn-amt ${meta.cls}">${meta.sign}${fmt(t.amount)}</div>
  </div>`;
}

// ===========================================================
// TRANSACTION DETAIL
// ===========================================================
function openTransactionDetail(txnId) {
  const data = D();
  const t = data.transactions.find(x => x.id === txnId);
  if (!t) return;
  openSubpage('Transaction', (root) => {
    const cat = data.categories.find(c => c.id === t.categoryId) || { name: 'Uncategorized' };
    const acct = data.accounts.find(a => a.id === t.accountId) || { name: '—' };
    const meta = TXN_TYPE_META[t.type] || TXN_TYPE_META.debit;
    const tagColors = { credit: ['var(--green)','var(--green-bg)'], debit: ['var(--red)','var(--red-bg)'], borrow: ['var(--blue)','var(--blue-bg)'], lend: ['var(--purple)','var(--purple-bg)'] };
    const [tColor, tBg] = tagColors[t.type] || tagColors.debit;
    root.innerHTML = `
      <div class="txn-detail-amt">
        <div class="tda-num" style="color:${tColor}">${meta.sign}${fmt(t.amount)}</div>
        <div class="tda-tag" style="background:${tBg};color:${tColor}">${meta.tag}${t.isReversal ? ' · REVERSAL' : ''}</div>
      </div>
      <div class="kv-list">
        <div class="kv-row"><span class="kv-k">Category</span><span class="kv-v">${cat.name}</span></div>
        <div class="kv-row"><span class="kv-k">Date</span><span class="kv-v">${M.humanDate(t.date)}</span></div>
        ${t.time ? `<div class="kv-row"><span class="kv-k">Time</span><span class="kv-v">${M.humanTime(t.time)}</span></div>` : ''}
        <div class="kv-row"><span class="kv-k">Payment Method</span><span class="kv-v">${t.paymentMethod}</span></div>
        ${t.upiId ? `<div class="kv-row"><span class="kv-k">UPI ID</span><span class="kv-v">${t.upiId}</span></div>` : ''}
        <div class="kv-row"><span class="kv-k">Account</span><span class="kv-v">${acct.name}</span></div>
        <div class="kv-row"><span class="kv-k">Description</span><span class="kv-v">${t.description || '—'}</span></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-block" id="td-edit">Edit</button>
        <button class="btn btn-danger btn-block" id="td-delete">Delete</button>
      </div>`;
    $('#td-edit', root).onclick = () => openTxnSheet({ txnId: t.id });
    $('#td-delete', root).onclick = () => confirmDialog('Delete Transaction?', 'This cannot be undone. The transaction will be permanently removed from your records.', 'Delete', async () => {
      await Store.deleteTransaction(t.id);
      showSuccess('🗑 Transaction Deleted');
      subpageBack();
    }, true);
  });
}

// ===========================================================
// TRANSACTIONS VIEW (list, grouped, filterable)
// ===========================================================
const TXN_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'credit', label: 'Income' }, { id: 'debit', label: 'Expense' },
  { id: 'borrow', label: 'Borrowed' }, { id: 'lend', label: 'Lent' },
  { id: 'Cash', label: 'Cash' }, { id: 'UPI', label: 'UPI' }, { id: 'Card', label: 'Card' }, { id: 'Bank', label: 'Bank' },
];
function renderTransactionsView() {
  $('#txn-filter-row').innerHTML = TXN_FILTERS.map(f => `<button class="chip ${S.txnFilter.kind===f.id?'active':''}" data-f="${f.id}">${f.label}</button>`).join('');
  $all('.chip', $('#txn-filter-row')).forEach(c => c.onclick = () => { S.txnFilter.kind = c.dataset.f; renderTransactionsView(); });
  if (!$('#txn-sort-row')) {
    $('#txn-filter-row').insertAdjacentHTML('afterend', `<div id="txn-sort-row" style="display:flex;justify-content:flex-end;margin-bottom:4px;"><select class="input" id="txn-sort-select" style="width:auto;">${SORT_OPTIONS.map(s=>`<option value="${s.id}" ${S.txnFilter.sort===s.id?'selected':''}>${s.label}</option>`).join('')}</select></div>`);
    $('#txn-sort-select').onchange = (e) => { S.txnFilter.sort = e.target.value; drawTxnList(); };
  }
  drawTxnList();
}
function matchesFilter(t, kind) {
  if (kind === 'all') return true;
  if (kind === 'credit') return t.type === 'credit';
  if (kind === 'debit') return t.type === 'debit';
  if (kind === 'borrow') return t.type === 'borrow';
  if (kind === 'lend') return t.type === 'lend';
  if (kind === 'Card') return t.paymentMethod === 'Debit Card' || t.paymentMethod === 'Credit Card';
  if (kind === 'Bank') return t.paymentMethod === 'Bank Transfer' || t.paymentMethod === 'Cheque';
  return t.paymentMethod === kind;
}
function drawTxnList() {
  const data = D();
  const filtered = data.transactions.filter(t => matchesFilter(t, S.txnFilter.kind));
  if (!filtered.length) { $('#txn-list').innerHTML = `<div class="empty-hint">No transactions yet. Tap + to add one.</div>`; return; }
  const sortId = S.txnFilter.sort || 'newest';
  const list = sortTxns(filtered, sortId);
  // Date-period grouping only makes sense for date-ordered sorts; an amount sort shows a flat list.
  const byAmount = sortId === 'high' || sortId === 'low';
  $('#txn-list').innerHTML = byAmount
    ? list.map(txnRowHtml).join('')
    : groupByDateLabel(list).map(g => `<div class="sep-title">${g.key}</div>` + g.items.map(txnRowHtml).join('')).join('');
  $all('.txn-row', $('#txn-list')).forEach(r => r.onclick = () => openTransactionDetail(r.dataset.id));
}
function groupLabel(dateStr) {
  const today = M.todayStr();
  const y = M.fmtDate(new Date(Date.now() - 86400000));
  if (dateStr === today) return 'Today';
  if (dateStr === y) return 'Yesterday';
  return M.humanDate(dateStr);
}

// ===========================================================
// SEARCH
// ===========================================================
function openSearch() {
  $('#search-overlay').classList.remove('hidden');
  pushBackGuard();
  $('#search-input').value = ''; $('#search-results').innerHTML = '';
  setTimeout(() => $('#search-input').focus(), 50);
}
function closeSearchOverlay() { $('#search-overlay').classList.add('hidden'); consumeBackGuard(); }
function renderSearchResults(q) {
  if (!q) { $('#search-results').innerHTML = ''; return; }
  const data = D();
  const results = data.transactions.filter(t => {
    const cat = data.categories.find(c => c.id === t.categoryId);
    const hay = [t.description, cat && cat.name, String(t.amount), t.date, t.paymentMethod, t.upiId].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }).sort((a,b)=> (b.date+b.time).localeCompare(a.date+a.time));
  $('#search-results').innerHTML = results.length ? results.map(txnRowHtml).join('') : `<div class="empty-hint">No matches for "${q}".</div>`;
  $all('.txn-row', $('#search-results')).forEach(r => r.onclick = () => { closeSearchOverlay(); openTransactionDetail(r.dataset.id); });
}

// ===========================================================
// NOTIFICATIONS
// ===========================================================
function buildNotifications() {
  const data = D();
  const notes = [];
  data.budgets.forEach(b => {
    const cat = data.categories.find(c => c.id === b.categoryId);
    if (!cat) return;
    const spent = M.budgetSpent(b.categoryId, data.transactions);
    const pct = b.amount > 0 ? spent / b.amount : 0;
    if (pct >= 1) notes.push({ icon: '🔴', title: `${cat.name} budget exceeded`, sub: `Exceeded by ${fmt(spent - b.amount)}` });
    else if (pct >= 0.85) notes.push({ icon: '⚠️', title: `${cat.name} budget is ${Math.round(pct*100)}% used`, sub: `${fmt(spent)} of ${fmt(b.amount)}` });
  });
  const today = M.todayStr();
  data.recurring.filter(r => r.active).forEach(r => {
    if (r.nextDate <= M.fmtDate(new Date(Date.now() + 3*86400000))) {
      const cat = data.categories.find(c => c.id === r.categoryId);
      notes.push({ icon: '🔁', title: `${r.description || (cat?cat.name:'Recurring')} due ${r.nextDate === today ? 'today' : 'on ' + M.humanDateShort(r.nextDate)}`, sub: fmt(r.amount) });
    }
  });
  return notes;
}
function openNotifications() {
  const notes = buildNotifications();
  $('#notif-overlay').classList.remove('hidden');
  pushBackGuard();
  $('#notif-list').innerHTML = notes.length ? notes.map(n => `<div class="notif-item"><b>${n.icon} ${n.title}</b>${n.sub}</div>`).join('') : `<div class="empty-hint">You're all caught up.</div>`;
}
function closeNotifOverlay() { $('#notif-overlay').classList.add('hidden'); consumeBackGuard(); }
function refreshNotifDot() {
  $('#notif-dot').classList.toggle('hidden', buildNotifications().length === 0);
}

// ===========================================================
// ANALYTICS
// ===========================================================
function renderAnalyticsTab(tab) {
  if (tab === 'charts') renderAnalyticsCharts();
  else if (tab === 'budgets') renderBudgetsPane();
  else if (tab === 'recurring') renderRecurringPane();
  else if (tab === 'reports') renderReportsPane();
}
function renderAnalyticsCharts() {
  const data = D();
  const range = currentRange();
  const dist = M.expenseByCategory(data.categories, data.transactions, range);
  const series = M.monthlySeries(data.transactions, 6);
  $('#analytics-charts').innerHTML = `
    <div class="time-filter-row" id="an-time-row"></div>
    <div class="section-head"><h2>Expense Distribution</h2></div>
    <div class="chart-card">${Charts.donut(dist.map(d=>({label:d.category.name, value:d.amount, color:swatchColor(d.category.color)})), {centerLabel: fmt(dist.reduce((s,d)=>s+d.amount,0))})}</div>
    <div class="section-head"><h2>Monthly Expense Trend</h2></div>
    <div class="chart-card">${Charts.lineTrend(series.map(s=>({label:s.label.split(' ')[0], expense:s.expense})))}</div>
    <div class="section-head"><h2>Income vs Expense</h2></div>
    <div class="chart-card">${Charts.barCompare(series.map(s=>({label:s.label.split(' ')[0], income:s.income, expense:s.expense})))}</div>`;
  $('#an-time-row').innerHTML = PERIODS.filter(p=>p.id!=='custom').map(p => `<button class="chip ${S.period===p.id?'active':''}" data-p="${p.id}">${p.label}</button>`).join('');
  $all('.chip', $('#an-time-row')).forEach(c => c.onclick = () => { S.period = c.dataset.p; renderAnalyticsCharts(); });
}

function renderBudgetsPane() {
  const data = D();
  const expenseCats = data.categories.filter(c => c.type === 'expense' && !c.archived);
  $('#analytics-budgets').innerHTML = `
    <div class="section-head"><h2>Monthly Budgets</h2><button class="link-btn" id="bud-add">+ Add Budget</button></div>
    <div id="budget-list"></div>`;
  function draw() {
    const list = data.budgets.map(b => {
      const cat = data.categories.find(c => c.id === b.categoryId);
      if (!cat) return '';
      const spent = M.budgetSpent(b.categoryId, data.transactions);
      const pct = b.amount > 0 ? Math.min(1, spent / b.amount) : 0;
      const over = spent > b.amount;
      const color = over ? 'var(--red)' : (pct >= 0.85 ? 'var(--orange)' : 'var(--primary)');
      return `<div class="budget-card">
        <div class="budget-top"><span>${cat.icon} ${cat.name}</span><span>${fmt(spent)} / ${fmt(b.amount)}</span></div>
        <div class="budget-bar-track"><div class="budget-bar-fill" style="width:${pct*100}%;background:${color}"></div></div>
        <div class="budget-meta"><span>Remaining: ${fmt(Math.max(0,b.amount-spent))}</span><span><button class="link-btn" data-edit="${b.id}">Edit</button> · <button class="link-btn" data-del="${b.id}">Remove</button></span></div>
        ${over ? `<div class="budget-alert over">🔴 Exceeded by ${fmt(spent-b.amount)}</div>` : (pct>=0.85 ? `<div class="budget-alert warn">⚠️ ${Math.round(pct*100)}% used</div>` : '')}
      </div>`;
    }).join('');
    $('#budget-list').innerHTML = list || `<div class="empty-hint">No budgets set yet.</div>`;
    $all('[data-edit]', $('#budget-list')).forEach(b => b.onclick = () => openBudgetEditor(b.dataset.edit));
    $all('[data-del]', $('#budget-list')).forEach(b => b.onclick = () => confirmDialog('Remove Budget?', 'This only removes the budget limit, not past transactions.', 'Remove', async () => {
      await Store.deleteBudget(b.dataset.del); draw();
    }, true));
  }
  draw();
  $('#bud-add').onclick = () => openBudgetEditor(null);
}
function openBudgetEditor(budgetId) {
  const data = D();
  const existing = budgetId ? data.budgets.find(b => b.id === budgetId) : null;
  const expenseCats = data.categories.filter(c => c.type === 'expense' && !c.archived);
  openModal(`
    <h3>${existing ? 'Edit' : 'Add'} Budget</h3>
    <label class="field-label">Category</label>
    <select class="input" id="bg-cat">${expenseCats.map(c => `<option value="${c.id}" ${existing&&existing.categoryId===c.id?'selected':''}>${c.icon} ${c.name}</option>`).join('')}</select>
    <label class="field-label">Monthly Budget Amount</label>
    <div class="amount-input-wrap"><span class="currency-prefix">${curSym()}</span><input class="input amount-input" id="bg-amount" inputmode="decimal" value="${existing?existing.amount:''}"></div>
    <div class="modal-actions"><button class="btn btn-ghost" id="bg-cancel">Cancel</button><button class="btn btn-primary" id="bg-save">Save</button></div>`);
  $('#bg-cancel').onclick = closeModal;
  $('#bg-save').onclick = async () => {
    const amount = parseFloat($('#bg-amount').value);
    if (isNaN(amount) || amount <= 0) { toast('Enter a valid budget amount.'); return; }
    const categoryId = $('#bg-cat').value;
    if (existing) { await Store.updateBudget(existing.id, { amount, categoryId }); }
    else if (data.budgets.some(b => b.categoryId === categoryId)) { toast('This category already has a budget. Edit it instead.'); return; }
    else await Store.addBudget({ categoryId, amount, period: 'monthly' });
    closeModal(); renderBudgetsPane();
  };
}

function renderRecurringPane() {
  const data = D();
  $('#analytics-recurring').innerHTML = `
    <div class="section-head"><h2>Recurring Transactions</h2><button class="link-btn" id="rec-add">+ Add</button></div>
    <div id="recur-list"></div>`;
  function draw() {
    $('#recur-list').innerHTML = data.recurring.length ? data.recurring.map(r => {
      const cat = data.categories.find(c => c.id === r.categoryId);
      return `<div class="recur-card">
        <div class="recur-info"><b>${cat?cat.icon:'🔁'} ${r.description || (cat?cat.name:'Recurring')}</b><span>${fmt(r.amount)} · ${r.frequency} · next ${M.humanDateShort(r.nextDate)}</span></div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" data-edit="${r.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-del="${r.id}">Delete</button>
        </div></div>`;
    }).join('') : `<div class="empty-hint">No recurring transactions set up.</div>`;
    $all('[data-edit]', $('#recur-list')).forEach(b => b.onclick = () => openRecurringEditor(b.dataset.edit));
    $all('[data-del]', $('#recur-list')).forEach(b => b.onclick = () => confirmDialog('Delete Recurring Entry?', 'Future occurrences will no longer be created automatically.', 'Delete', async () => {
      await Store.deleteRecurring(b.dataset.del); draw();
    }, true));
  }
  draw();
  $('#rec-add').onclick = () => openRecurringEditor(null);
}
function openRecurringEditor(id) {
  const data = D();
  const existing = id ? data.recurring.find(r => r.id === id) : null;
  const cats = data.categories.filter(c => !c.archived);
  const accts = data.accounts.filter(a => !a.archived);
  openModal(`
    <h3>${existing ? 'Edit' : 'Add'} Recurring</h3>
    <div class="type-toggle">
      <button type="button" class="type-btn income ${(!existing||existing.type==='credit')?'':''}" data-type="credit">🟢 Income</button>
      <button type="button" class="type-btn expense" data-type="debit">🔴 Expense</button>
    </div>
    <label class="field-label">Amount</label>
    <div class="amount-input-wrap"><span class="currency-prefix">${curSym()}</span><input class="input amount-input" id="rc-amount" inputmode="decimal" value="${existing?existing.amount:''}"></div>
    <label class="field-label">Category</label>
    <select class="input" id="rc-cat">${cats.map(c=>`<option value="${c.id}" ${existing&&existing.categoryId===c.id?'selected':''}>${c.icon} ${c.name}</option>`).join('')}</select>
    <label class="field-label">Account</label>
    <select class="input" id="rc-acct">${accts.map(a=>`<option value="${a.id}" ${existing&&existing.accountId===a.id?'selected':''}>${a.name}</option>`).join('')}</select>
    <label class="field-label">Frequency</label>
    <select class="input" id="rc-freq">
      <option value="monthly" ${existing&&existing.frequency==='monthly'?'selected':''}>Every month</option>
      <option value="weekly" ${existing&&existing.frequency==='weekly'?'selected':''}>Every week</option>
      <option value="yearly" ${existing&&existing.frequency==='yearly'?'selected':''}>Every year</option>
      <option value="daily" ${existing&&existing.frequency==='daily'?'selected':''}>Every day</option>
    </select>
    <label class="field-label">Next Date</label>
    <input type="date" class="input" id="rc-next" value="${existing?existing.nextDate:M.todayStr()}">
    <label class="field-label">Description</label>
    <input class="input" id="rc-desc" value="${existing?existing.description||'':''}">
    <div class="modal-actions"><button class="btn btn-ghost" id="rc-cancel">Cancel</button><button class="btn btn-primary" id="rc-save">Save</button></div>`);

  let curType = existing ? existing.type : 'debit';
  $all('.type-btn', $('#modal-body')).forEach(b => { b.classList.toggle('active', b.dataset.type === curType); b.onclick = () => { $all('.type-btn', $('#modal-body')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); curType = b.dataset.type; }; });
  $('#rc-cancel').onclick = closeModal;
  $('#rc-save').onclick = async () => {
    const amount = parseFloat($('#rc-amount').value);
    if (isNaN(amount) || amount <= 0) { toast('Enter a valid amount.'); return; }
    const obj = {
      type: curType, amount, categoryId: $('#rc-cat').value,
      accountId: $('#rc-acct').value, frequency: $('#rc-freq').value, nextDate: $('#rc-next').value,
      description: $('#rc-desc').value.trim(), active: true
    };
    if (existing) await Store.updateRecurring(existing.id, obj); else await Store.addRecurring(obj);
    closeModal(); renderRecurringPane();
  };
}

function nextOccurrence(dateStr, freq) {
  const d = M.parseDate(dateStr);
  if (freq === 'daily') d.setDate(d.getDate() + 1);
  else if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return M.fmtDate(d);
}
async function runRecurringEngine() {
  const data = D();
  if (!data) return;
  const today = M.todayStr();
  for (const r of data.recurring.filter(r => r.active)) {
    let guard = 0;
    let nextDate = r.nextDate;
    while (nextDate <= today && guard < 36) {
      await Store.addTransaction({
        type: r.type, amount: r.amount, categoryId: r.categoryId, accountId: r.accountId,
        paymentMethod: 'Bank Transfer', date: nextDate, time: '', description: r.description || 'Recurring',
        upiId: '', isReversal: false, fromRecurring: r.id
      });
      nextDate = nextOccurrence(nextDate, r.frequency);
      guard++;
    }
    if (nextDate !== r.nextDate) await Store.updateRecurring(r.id, { nextDate });
  }
  refreshNotifDot();
}

function renderReportsPane() {
  const data = D();
  const now = new Date();
  const months = M.monthlySeries(data.transactions, 12).reverse();
  $('#analytics-reports').innerHTML = `
    <label class="field-label">Select Month</label>
    <select class="input" id="rp-month">${months.map(m=>`<option value="${m.key}">${m.label}</option>`).join('')}</select>
    <div id="rp-body"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" id="rp-export-csv">Export CSV</button>
      <button class="btn btn-ghost btn-block" id="rp-export-pdf">Export / Print PDF</button>
    </div>`;
  function draw() {
    const key = $('#rp-month').value;
    const list = data.transactions.filter(t => M.monthKey(t.date) === key);
    const income = M.sumCredit(list), expense = M.sumDebit(list);
    const byCat = M.expenseByCategory(data.categories, list, null);
    const top = byCat[0];
    const largest = list.filter(t=>t.type==='debit').sort((a,b)=>b.amount-a.amount)[0];
    const byMethod = {};
    list.filter(t=>t.type==='debit').forEach(t => byMethod[t.paymentMethod] = (byMethod[t.paymentMethod]||0)+t.amount);
    $('#rp-body').innerHTML = `
      <div class="kv-list">
        <div class="kv-row"><span class="kv-k">Income</span><span class="kv-v" style="color:var(--green)">${fmt(income)}</span></div>
        <div class="kv-row"><span class="kv-k">Expense</span><span class="kv-v" style="color:var(--red)">${fmt(expense)}</span></div>
        <div class="kv-row"><span class="kv-k">Savings</span><span class="kv-v">${fmt(income-expense)}</span></div>
        <div class="kv-row"><span class="kv-k">Top Category</span><span class="kv-v">${top?top.category.name+' — '+fmt(top.amount):'—'}</span></div>
        <div class="kv-row"><span class="kv-k">Largest Expense</span><span class="kv-v">${largest?fmt(largest.amount)+' ('+(largest.description||'')+')':'—'}</span></div>
      </div>
      <div class="section-head"><h2>Payment Method Breakdown</h2></div>
      <div class="kv-list">${Object.entries(byMethod).map(([m,a])=>`<div class="kv-row"><span class="kv-k">${m}</span><span class="kv-v">${fmt(a)}</span></div>`).join('') || '<div class="kv-row"><span class="kv-k">No expenses</span></div>'}</div>`;
  }
  draw();
  $('#rp-month').onchange = draw;
  $('#rp-export-csv').onclick = () => exportCSV($('#rp-month').value);
  $('#rp-export-pdf').onclick = () => exportPrintable($('#rp-month').value);
}

function exportCSV(monthKey) {
  const data = D();
  const list = data.transactions.filter(t => M.monthKey(t.date) === monthKey);
  const rows = [['Date','Time','Type','Category','Amount','Payment Method','Account','UPI ID','Description']];
  list.forEach(t => {
    const cat = data.categories.find(c=>c.id===t.categoryId);
    const acct = data.accounts.find(a=>a.id===t.accountId);
    rows.push([t.date, t.time||'', t.type, cat?cat.name:'', t.amount, t.paymentMethod, acct?acct.name:'', t.upiId||'', (t.description||'').replace(/,/g,';')]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  downloadFile(`transactions_${monthKey}.csv`, csv, 'text/csv');
  toast('CSV exported.');
}
function exportPrintable(monthKey) {
  const data = D();
  const list = data.transactions.filter(t => M.monthKey(t.date) === monthKey).sort((a,b)=>a.date.localeCompare(b.date));
  const income = M.sumCredit(list), expense = M.sumDebit(list);
  const win = window.open('', '_blank');
  win.document.write(`<html><head><title>Report ${monthKey}</title>
    <style>body{font-family:sans-serif;padding:24px;} table{width:100%;border-collapse:collapse;} td,th{padding:8px;border-bottom:1px solid #ddd;font-size:13px;text-align:left;}</style>
    </head><body><h2>Monthly Report — ${M.monthLabel(monthKey)}</h2>
    <p>Income: ${fmt(income)} &nbsp; Expense: ${fmt(expense)} &nbsp; Savings: ${fmt(income-expense)}</p>
    <table><tr><th>Date</th><th>Category</th><th>Type</th><th>Amount</th><th>Method</th><th>Description</th></tr>
    ${list.map(t=>{const cat=data.categories.find(c=>c.id===t.categoryId);return `<tr><td>${t.date}</td><td>${cat?cat.name:''}</td><td>${t.type}</td><td>${fmt(t.amount)}</td><td>${t.paymentMethod}</td><td>${t.description||''}</td></tr>`;}).join('')}
    </table></body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
}
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ===========================================================
// MORE / SETTINGS
// ===========================================================
function renderMore() {
  const p = prefs();
  $('#more-list').innerHTML = `
    <div class="profile-card"><div class="pc-name">${p.name || 'Your Vault'}</div><div class="pc-sub">${curSym()} ${p.currency==='₹'?'Indian Rupee':'Currency'} · Auto-lock ${p.autoLockMinutes||'off'} min</div></div>

    <div class="more-section-title">Security</div>
    <div class="more-row" data-act="change-pin"><span class="mr-ico">🔑</span><span class="mr-label">Change PIN</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="biometric"><span class="mr-ico">👆</span><span class="mr-label">Biometric Authentication</span><span class="mr-val">${Store.biometricEnabled(Store.currentUser().id)?'On':'Off'}</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="autolock"><span class="mr-ico">⏱️</span><span class="mr-label">Auto-lock</span><span class="mr-val">${p.autoLockMinutes} min</span><span class="mr-chev">›</span></div>

    <div class="more-section-title">Preferences</div>
    <div class="more-row" data-act="currency"><span class="mr-ico">💱</span><span class="mr-label">Currency</span><span class="mr-val">${p.currency}</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="theme"><span class="mr-ico">🌓</span><span class="mr-label">Theme</span><span class="mr-val">${p.theme}</span><span class="mr-chev">›</span></div>

    <div class="more-section-title">Manage</div>
    <div class="more-row" data-act="categories"><span class="mr-ico">🗂️</span><span class="mr-label">Categories</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="accounts"><span class="mr-ico">🏦</span><span class="mr-label">Accounts</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="upi"><span class="mr-ico">📲</span><span class="mr-label">UPI IDs</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="budgets"><span class="mr-ico">🎯</span><span class="mr-label">Budgets</span><span class="mr-chev">›</span></div>
    <div class="more-row" data-act="recurring"><span class="mr-ico">🔁</span><span class="mr-label">Recurring Transactions</span><span class="mr-chev">›</span></div>

    <div class="more-section-title">Household</div>
    <div class="more-row" data-act="household"><span class="mr-ico">🏡</span><span class="mr-label">My Households</span><span class="mr-val">${Store.household() ? Store.household().name : ''}</span><span class="mr-chev">›</span></div>

    <div class="more-section-title">Data</div>
    <div class="more-row" data-act="backup"><span class="mr-ico">💾</span><span class="mr-label">Backup &amp; Restore</span><span class="mr-chev">›</span></div>

    <div class="more-section-title">Account</div>
    <div class="more-row" data-act="lock"><span class="mr-ico">🔒</span><span class="mr-label" style="color:var(--red)">Lock Now</span></div>
    <div class="more-row" data-act="signout"><span class="mr-ico">🚪</span><span class="mr-label" style="color:var(--red)">Sign Out</span></div>
    <div class="more-row" data-act="delete-account"><span class="mr-ico">⚠️</span><span class="mr-label" style="color:var(--red)">Delete Account</span></div>
  `;
  $all('.more-row', $('#more-list')).forEach(r => r.onclick = () => handleMoreAction(r.dataset.act));
}

function handleMoreAction(act) {
  if (act === 'change-pin') return openChangePin();
  if (act === 'biometric') return openBiometricSettings();
  if (act === 'autolock') return openAutoLockSettings();
  if (act === 'currency') return openCurrencySettings();
  if (act === 'theme') return openThemeSettings();
  if (act === 'categories') return openDrawerPage('categories');
  if (act === 'accounts') return openDrawerPage('accounts');
  if (act === 'upi') return openDrawerPage('upi');
  if (act === 'budgets') return goNav('analytics'), setTimeout(()=>$all('.tab-btn')[1].click(),0);
  if (act === 'recurring') return goNav('analytics'), setTimeout(()=>$all('.tab-btn')[2].click(),0);
  if (act === 'backup') return openDrawerPage('backup');
  if (act === 'household') return openDrawerPage('household');
  if (act === 'lock') return doLock();
  if (act === 'signout') return $('#btn-sign-out').click();
  if (act === 'delete-account') return openDeleteAccountFlow();
}

// ---------- Delete Account (permanent, two-step confirmation) ----------
function openDeleteAccountFlow() {
  const email = Store.currentUser().email;
  openModal(`
    <h3>⚠️ Delete Your Account</h3>
    <p class="muted">This <b>permanently and irreversibly</b> deletes your account (${email}). Here's exactly what happens:</p>
    <ul class="muted" style="padding-left:18px; line-height:1.7;">
      <li>You are removed from every household you're a member of.</li>
      <li>If you <b>own</b> a household that has other members, ownership passes automatically to the longest-standing member — their data is <b>not</b> deleted.</li>
      <li>If you're the <b>only</b> member of a household you own, that household and everything in it (accounts, categories, transactions, budgets) is deleted permanently.</li>
      <li>Your login (email/password or Google) is deleted and cannot be recovered.</li>
    </ul>
    <p class="error-text" style="text-align:left;">This action cannot be undone.</p>
    <div class="modal-actions"><button class="btn btn-ghost" id="da-cancel">Cancel</button><button class="btn btn-danger" id="da-next">Continue</button></div>`);
  $('#da-cancel').onclick = closeModal;
  $('#da-next').onclick = () => openDeleteAccountConfirmStep();
}
function openDeleteAccountConfirmStep() {
  openModal(`
    <h3>Final Confirmation</h3>
    <p class="muted">Type <b>DELETE</b> below to permanently delete your account. There is no way to undo this.</p>
    <input class="input" id="da-confirm-input" placeholder="Type DELETE" autocomplete="off">
    <p class="error-text hidden" id="da-err"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="da-cancel2">Cancel</button><button class="btn btn-danger" id="da-final">Delete My Account Forever</button></div>`);
  $('#da-cancel2').onclick = closeModal;
  $('#da-final').onclick = async () => {
    if ($('#da-confirm-input').value.trim() !== 'DELETE') {
      $('#da-err').textContent = 'Type DELETE exactly (all caps) to confirm.'; $('#da-err').classList.remove('hidden'); return;
    }
    $('#da-final').disabled = true; $('#da-final').textContent = 'Deleting…';
    try {
      await Store.deleteMyAccountForever();
      closeModal();
      Store.clearDeviceLock(Store.currentUser().id);
      await Store.signOut();
      location.reload();
    } catch (e) {
      $('#da-err').textContent = e.message; $('#da-err').classList.remove('hidden');
      $('#da-final').disabled = false; $('#da-final').textContent = 'Delete My Account Forever';
    }
  };
}

function openDrawerPage(page) {
  if (page === 'categories') return openCategoriesManager();
  if (page === 'accounts') return openAccountsManager();
  if (page === 'upi') return openUpiManager();
  if (page === 'backup') return openBackupRestore();
  if (page === 'household') return openHouseholdManager();
}

// ---------- Household manager ----------
// ---------- My Households (multi-household list + switcher) ----------
function openHouseholdManager() {
  // Most people only ever have one household — jump straight to its detail
  // screen instead of making them tap through a 1-item list every time.
  // Create New / Join Existing stay reachable via the "+ Add Another
  // Household" link at the bottom of that detail screen (Priority 1: both
  // must always be reachable together, never gated behind having 0 already).
  (async () => {
    try {
      const list = await Store.listMyHouseholds();
      if (list.length === 1) openHouseholdDetail(list[0].id);
      else openHouseholdsList();
    } catch (e) { openHouseholdsList(); }
  })();
}

function openHouseholdsList() {
  openSubpage('My Households', async (root) => {
    root.innerHTML = `<div class="empty-hint">Loading…</div>`;
    const list = await Store.listMyHouseholds();
    const activeId = Store.household() ? Store.household().id : null;
    root.innerHTML = `
      <div class="field-row-2" style="margin-bottom:16px;">
        <button class="btn btn-primary" id="hl-create">+ Create New</button>
        <button class="btn btn-ghost" id="hl-join">+ Join Existing</button>
      </div>
      <div class="sep-title">Your Households</div>
      <div id="hl-list"></div>
    `;
    $('#hl-list', root).innerHTML = list.map(h => `
      <div class="household-card ${h.id === activeId ? 'active' : ''}" data-hh="${h.id}">
        <div class="hc-ico">🏡</div>
        <div class="hc-mid">
          <div class="hc-name">${h.name}</div>
          <div class="hc-sub">${h.role === 'owner' ? 'Owner' : 'Member'}</div>
        </div>
        ${h.id === activeId ? '<span class="hc-badge">Active</span>' : ''}
      </div>`).join('') || `<div class="empty-hint">No households yet.</div>`;
    $all('.household-card', root).forEach(c => c.onclick = () => openHouseholdDetail(c.dataset.hh));
    $('#hl-create', root).onclick = () => openCreateAnotherHousehold();
    $('#hl-join', root).onclick = () => openJoinAnotherHousehold();
  });
}

function openRenameHousehold(h, onDone) {
  openModal(`
    <h3>Rename Household</h3>
    <label class="field-label">Household Name</label>
    <input class="input" id="rh-name" value="${h.name}" maxlength="60">
    <p class="error-text hidden" id="rh-err"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="rh-cancel">Cancel</button><button class="btn btn-primary" id="rh-save">Save</button></div>`);
  $('#rh-cancel').onclick = closeModal;
  $('#rh-save').onclick = async () => {
    const name = $('#rh-name').value.trim();
    if (!name) { $('#rh-err').textContent = 'Enter a household name.'; $('#rh-err').classList.remove('hidden'); return; }
    try {
      await Store.renameHouseholdFlow(h.id, name);
      closeModal(); toast('Household renamed.');
      renderDrawerHead();
      if (onDone) onDone();
    } catch (e) { $('#rh-err').textContent = e.message; $('#rh-err').classList.remove('hidden'); }
  };
}

function openCreateAnotherHousehold() {
  openModal(`
    <h3>Create New Household</h3>
    <label class="field-label">Household Name</label>
    <input class="input" id="ch-name" placeholder="e.g. Weekend Home" maxlength="60">
    <p class="error-text hidden" id="ch-err"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="ch-cancel">Cancel</button><button class="btn btn-primary" id="ch-save">Create</button></div>`);
  $('#ch-cancel').onclick = closeModal;
  $('#ch-save').onclick = async () => {
    const name = $('#ch-name').value.trim();
    if (!name) { $('#ch-err').textContent = 'Enter a household name.'; $('#ch-err').classList.remove('hidden'); return; }
    try {
      await Store.createHouseholdFlow(name, 0, 'bank', true);
      await Store.switchHousehold(Store.household().id);
      closeModal(); showSuccess('✓ Household Created\n' + name);
      openHouseholdsList(); refreshCurrentView();
    } catch (e) { $('#ch-err').textContent = e.message; $('#ch-err').classList.remove('hidden'); }
  };
}
function openJoinAnotherHousehold() {
  openModal(`
    <h3>Join Existing Household</h3>
    <label class="field-label">Join Code</label>
    <input class="input" id="jh-code" placeholder="e.g. A1B2C3" maxlength="6" style="text-transform:uppercase;letter-spacing:.1em;font-weight:800;text-align:center;font-size:18px;">
    <p class="error-text hidden" id="jh-err"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="jh-cancel">Cancel</button><button class="btn btn-primary" id="jh-save">Join</button></div>`);
  $('#jh-cancel').onclick = closeModal;
  $('#jh-save').onclick = async () => {
    const code = $('#jh-code').value.trim();
    if (!code) { $('#jh-err').textContent = 'Enter a join code.'; $('#jh-err').classList.remove('hidden'); return; }
    try {
      const h = await Store.joinHouseholdFlow(code);
      await Store.switchHousehold(h.id);
      closeModal(); showSuccess('✓ Joined Household\n' + h.name);
      openHouseholdsList(); refreshCurrentView();
    } catch (e) { $('#jh-err').textContent = 'Invalid join code.'; $('#jh-err').classList.remove('hidden'); }
  };
}

function openHouseholdDetail(householdId) {
  openSubpage('Household', async (root) => {
    root.innerHTML = `<div class="empty-hint">Loading…</div>`;
    const list = await Store.listMyHouseholds();
    const h = list.find(x => x.id === householdId);
    if (!h) { root.innerHTML = `<div class="empty-hint">Household not found.</div>`; return; }
    const isActive = Store.household() && Store.household().id === h.id;
    const members = await Supa.getMembers(h.id);
    const profiles = await Store.getProfiles(members.map(m => m.user_id));
    const nameFor = (uid) => {
      if (uid === Store.currentUser().id) return 'You';
      const p = profiles.find(x => x.id === uid);
      return (p && (p.display_name || p.email)) || 'Household member';
    };
    root.innerHTML = `
      <div class="detail-header" style="background:var(--primary)">
        <div class="dh-ico">🏡</div>
        <div class="dh-name">${h.name}</div>
      </div>
      ${isActive ? `<div class="empty-hint" style="padding:8px;">This is your currently active household.</div>` : `<button class="btn btn-primary btn-block" id="hd-switch" style="margin:12px 0;">Switch to This Household</button>`}
      <div class="kv-list">
        <div class="kv-row"><span class="kv-k">Join Code</span><span class="kv-v" style="letter-spacing:.1em;font-size:16px;">${h.joinCode}</span></div>
        <div class="kv-row"><span class="kv-k">Your Role</span><span class="kv-v">${h.role === 'owner' ? 'Owner' : 'Member'}</span></div>
      </div>
      <p class="muted">Share the join code above so someone else can join this exact household.</p>

      ${h.role === 'owner' ? `<button class="btn btn-ghost btn-block" id="hd-rename" style="margin-top:10px;">✏️ Rename Household</button>` : ''}
      ${h.role === 'owner' ? `<button class="btn btn-ghost btn-block" id="hd-sharing" style="margin-top:10px;">🗂️ Category Sharing</button>` : ''}

      <div class="sep-title">Members</div>
      <div class="kv-list">${members.map(m => {
        const canManage = h.role === 'owner' && m.role !== 'owner';
        return `<div class="kv-row${canManage ? ' kv-row-clickable' : ''}" ${canManage ? `data-member="${m.user_id}" data-member-name="${nameFor(m.user_id)}"` : ''}>
          <span class="kv-k">${nameFor(m.user_id)}</span>
          <span class="kv-v">${m.role}${canManage ? ` · <button class="link-btn" data-make-owner="${m.user_id}">Make Owner</button>` : ''}${canManage ? ' <span class="kv-chev">›</span>' : ''}</span>
        </div>`;
      }).join('')}</div>
      ${h.role === 'owner' ? `<p class="muted" style="margin-top:-6px;">Tap a member to control what they can see and do.</p>` : ''}

      <div class="modal-actions">
        ${h.role === 'owner'
          ? `<button class="btn btn-danger btn-block" id="hd-delete">Delete Household</button>`
          : `<button class="btn btn-danger btn-block" id="hd-leave">Leave Household</button>`}
      </div>
      <button class="btn btn-ghost btn-block" id="hd-add-another" style="margin-top:10px;">+ Add Another Household</button>
    `;
    const backBtn = $('#hd-switch', root);
    if (backBtn) backBtn.onclick = async () => {
      await Store.switchHousehold(h.id);
      showSuccess('✓ Switched\n' + h.name);
      goNav('home'); refreshCurrentView();
    };
    $('#hd-sharing', root) && ($('#hd-sharing', root).onclick = () => openCategorySharing(h.id, h.name));
    $('#hd-rename', root) && ($('#hd-rename', root).onclick = () => openRenameHousehold(h, () => openHouseholdDetail(h.id)));
    $('#hd-add-another', root).onclick = () => openHouseholdsList();
    $all('[data-member]', root).forEach(row => row.onclick = (e) => {
      if (e.target.closest('[data-make-owner]')) return; // let Make Owner handle its own click
      const m = members.find(x => x.user_id === row.dataset.member);
      openMemberCategorySharing(h.id, h.name, row.dataset.member, row.dataset.memberName, m);
    });
    $all('[data-make-owner]', root).forEach(b => b.onclick = () => confirmDialog(
      'Transfer Ownership?',
      `Are you sure you want to make ${nameFor(b.dataset.makeOwner)} the owner of "${h.name}"? You will become a regular member. This action cannot be undone by you alone.`,
      'Transfer', async () => {
        try { await Store.transferOwnershipFlow(h.id, b.dataset.makeOwner); showSuccess('✓ Ownership Transferred'); openHouseholdDetail(h.id); }
        catch (e) { toast(e.message); }
      }, true));
    $('#hd-leave', root) && ($('#hd-leave', root).onclick = () => confirmDialog(
      'Leave Household?',
      `Are you sure you want to leave "${h.name}"? This action cannot be undone — you'll need a new invite to rejoin.`,
      'Leave', async () => {
        try {
          await Store.leaveHouseholdFlow(h.id);
          showSuccess('Left household');
          if (isActive) { await Store.loadHousehold(); if (Store.household()) await Store.switchHousehold(Store.household().id); }
          subpageBack(); refreshCurrentView();
        } catch (e) { toast(e.message); }
      }, true));
    $('#hd-delete', root) && ($('#hd-delete', root).onclick = () => confirmDialog(
      'Delete Household?',
      `Are you sure you want to permanently delete "${h.name}"? This removes it for every member (${members.length} total) and permanently deletes all its accounts, categories, transactions and budgets. This action cannot be undone.`,
      'Delete Forever', async () => {
        try {
          await Store.deleteHouseholdFlow(h.id);
          showSuccess('🗑 Household Deleted');
          if (isActive) { await Store.loadHousehold(); if (Store.household()) await Store.switchHousehold(Store.household().id); }
          subpageBack(); refreshCurrentView();
        } catch (e) { toast(e.message); }
      }, true));
  });
}

// ---------- Category Sharing (owner-only) ----------
function openCategorySharing(householdId, householdName) {
  openSubpage('Category Sharing', async (root) => {
    root.innerHTML = `<div class="empty-hint">Loading…</div>`;
    const { data: cats, error } = await Supa.client.from('categories').select('*').eq('household_id', householdId).eq('archived', false).order('type').order('sort_order');
    if (error) { root.innerHTML = `<div class="empty-hint">${error.message}</div>`; return; }

    function renderQuickToggles() {
      return CATEGORY_TYPE_SECTIONS.map(section => {
        const list = cats.filter(c => c.type === section.type);
        if (!list.length) return '';
        const allOn = list.every(c => c.shared !== false);
        return `
        <div class="share-row share-row-master" data-master="${section.type}">
          <div class="sr-name"><strong>${section.label}</strong> <span class="muted">(${list.length})</span></div>
          <label class="toggle-switch"><input type="checkbox" data-master-toggle="${section.type}" ${allOn ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>`;
      }).join('');
    }
    function renderSections() {
      return CATEGORY_TYPE_SECTIONS.map(section => {
        const list = cats.filter(c => c.type === section.type);
        if (!list.length) return '';
        return `
        <div class="sep-title">${section.label}</div>
        <div>${list.map(c => `
          <div class="share-row">
            <div class="sr-ico ${c.color}">${c.icon}</div>
            <div class="sr-name">${c.name}</div>
            <label class="toggle-switch"><input type="checkbox" data-cat="${c.id}" ${c.shared !== false ? 'checked' : ''}><span class="toggle-slider"></span></label>
          </div>`).join('')}</div>`;
      }).join('') || `<div class="empty-hint">No categories yet.</div>`;
    }

    root.innerHTML = `
      <p class="muted">Choose which categories members of "${householdName}" can see and use. Turning a category off only hides it from members — it stays visible to you, and no past transactions are deleted.</p>
      <div class="sep-title">Quick Toggle by Type</div>
      <div id="share-quick">${renderQuickToggles()}</div>
      <div id="share-sections">${renderSections()}</div>
    `;

    function wireIndividual() {
      $all('input[data-cat]', root).forEach(input => input.onchange = async () => {
        try {
          const row = await Supa.setCategoryShared(input.dataset.cat, input.checked);
          const cat = cats.find(c => c.id === input.dataset.cat);
          if (cat) cat.shared = row.shared;
          toast(input.checked ? 'Shared with members' : 'Hidden from members');
          $('#share-quick', root).innerHTML = renderQuickToggles();
          wireQuick();
        } catch (e) { input.checked = !input.checked; toast(e.message); }
      });
    }
    function wireQuick() {
      $all('input[data-master-toggle]', root).forEach(input => input.onchange = async () => {
        const type = input.dataset.masterToggle;
        const targetShared = input.checked;
        const list = cats.filter(c => c.type === type);
        input.disabled = true;
        try {
          await Promise.all(list.map(async c => {
            const row = await Supa.setCategoryShared(c.id, targetShared);
            c.shared = row.shared;
          }));
          toast(`${targetShared ? 'Shared' : 'Hidden'} all ${CATEGORY_TYPE_SECTIONS.find(s => s.type === type).label} categories`);
          $('#share-sections', root).innerHTML = renderSections();
          wireIndividual();
        } catch (e) {
          toast(e.message);
          $('#share-quick', root).innerHTML = renderQuickToggles();
          wireQuick();
        } finally {
          input.disabled = false;
        }
      });
    }
    wireIndividual();
    wireQuick();
  });
}

// ---------- Per-Member Category Sharing (owner-only) ----------
// Layered on top of the household-wide Category Sharing master switch: a
// category the owner turned OFF for the whole household stays off for
// EVERY member no matter what's set here (data layer enforces this via
// category_member_shares + the categories RLS policy, not just the UI).
function openMemberCategorySharing(householdId, householdName, memberUserId, memberName, memberRow) {
  openSubpage(`${memberName}'s Access`, async (root) => {
    root.innerHTML = `<div class="empty-hint">Loading…</div>`;
    const { data: cats, error } = await Supa.client.from('categories').select('*').eq('household_id', householdId).eq('archived', false).order('type').order('sort_order');
    if (error) { root.innerHTML = `<div class="empty-hint">${error.message}</div>`; return; }
    let canAdd = memberRow ? memberRow.can_add !== false : true;
    let canDelete = memberRow ? memberRow.can_delete !== false : true;
    function renderPermissions() {
      return `
        <div class="share-row">
          <div class="sr-name"><strong>Can Add Transactions</strong></div>
          <label class="toggle-switch"><input type="checkbox" id="perm-can-add" ${canAdd ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>
        <div class="share-row">
          <div class="sr-name"><strong>Can Delete Transactions</strong></div>
          <label class="toggle-switch"><input type="checkbox" id="perm-can-delete" ${canDelete ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>`;
    }
    const overrides = await Store.getCategoryMemberShares(cats.map(c => c.id));
    const overrideFor = (catId) => overrides.find(o => o.category_id === catId && o.user_id === memberUserId);
    function isVisible(c) {
      if (c.shared === false) return false; // household-wide OFF always wins
      const o = overrideFor(c.id);
      return o ? o.shared !== false : true; // default: visible
    }

    function renderQuickToggles() {
      return CATEGORY_TYPE_SECTIONS.map(section => {
        const list = cats.filter(c => c.type === section.type && c.shared !== false);
        if (!list.length) return '';
        const allOn = list.every(isVisible);
        return `
        <div class="share-row share-row-master" data-master="${section.type}">
          <div class="sr-name"><strong>${section.label}</strong> <span class="muted">(${list.length})</span></div>
          <label class="toggle-switch"><input type="checkbox" data-master-toggle="${section.type}" ${allOn ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>`;
      }).join('');
    }
    function renderSections() {
      return CATEGORY_TYPE_SECTIONS.map(section => {
        const list = cats.filter(c => c.type === section.type);
        if (!list.length) return '';
        return `
        <div class="sep-title">${section.label}</div>
        <div>${list.map(c => {
          const hardOff = c.shared === false;
          const on = isVisible(c);
          return `
          <div class="share-row${hardOff ? ' share-row-disabled' : ''}">
            <div class="sr-ico ${c.color}">${c.icon}</div>
            <div class="sr-name">${c.name}${hardOff ? ' <span class="muted">(off for everyone)</span>' : ''}</div>
            <label class="toggle-switch"><input type="checkbox" data-cat="${c.id}" ${on ? 'checked' : ''} ${hardOff ? 'disabled' : ''}><span class="toggle-slider"></span></label>
          </div>`;
        }).join('')}</div>`;
      }).join('') || `<div class="empty-hint">No categories yet.</div>`;
    }

    root.innerHTML = `
      <p class="muted">Control what <strong>${memberName}</strong> can see and do in "${householdName}" — independent of any other member.</p>
      <div class="sep-title">Permissions</div>
      <div id="perm-section">${renderPermissions()}</div>
      <div class="sep-title">Categories</div>
      <p class="muted">A category that's off for the whole household (via Category Sharing) stays off for everyone regardless of what's set here.</p>
      <div class="sep-title">Quick Toggle by Type</div>
      <div id="share-quick">${renderQuickToggles()}</div>
      <div id="share-sections">${renderSections()}</div>
    `;

    function wirePermissions() {
      const addInput = $('#perm-can-add', root), delInput = $('#perm-can-delete', root);
      const onChange = async () => {
        const nextAdd = addInput.checked, nextDelete = delInput.checked;
        addInput.disabled = true; delInput.disabled = true;
        try {
          await Store.setMemberPermissions(householdId, memberUserId, nextAdd, nextDelete);
          canAdd = nextAdd; canDelete = nextDelete;
          toast(`Updated permissions for ${memberName}`);
        } catch (e) {
          addInput.checked = canAdd; delInput.checked = canDelete;
          toast(e.message);
        } finally {
          addInput.disabled = false; delInput.disabled = false;
        }
      };
      addInput.onchange = onChange;
      delInput.onchange = onChange;
    }
    wirePermissions();

    function wireIndividual() {
      $all('input[data-cat]', root).forEach(input => input.onchange = async () => {
        try {
          const row = await Store.setCategoryMemberShared(input.dataset.cat, memberUserId, input.checked);
          const idx = overrides.findIndex(o => o.category_id === input.dataset.cat && o.user_id === memberUserId);
          if (idx >= 0) overrides[idx] = row; else overrides.push(row);
          toast(input.checked ? `Shown to ${memberName}` : `Hidden from ${memberName}`);
          $('#share-quick', root).innerHTML = renderQuickToggles();
          wireQuick();
        } catch (e) { input.checked = !input.checked; toast(e.message); }
      });
    }
    function wireQuick() {
      $all('input[data-master-toggle]', root).forEach(input => input.onchange = async () => {
        const type = input.dataset.masterToggle;
        const targetShared = input.checked;
        const list = cats.filter(c => c.type === type && c.shared !== false);
        input.disabled = true;
        try {
          await Promise.all(list.map(async c => {
            const row = await Store.setCategoryMemberShared(c.id, memberUserId, targetShared);
            const idx = overrides.findIndex(o => o.category_id === c.id && o.user_id === memberUserId);
            if (idx >= 0) overrides[idx] = row; else overrides.push(row);
          }));
          toast(`${targetShared ? 'Shown to' : 'Hidden from'} ${memberName}: all ${CATEGORY_TYPE_SECTIONS.find(s => s.type === type).label} categories`);
          $('#share-sections', root).innerHTML = renderSections();
          wireIndividual();
        } catch (e) {
          toast(e.message);
          $('#share-quick', root).innerHTML = renderQuickToggles();
          wireQuick();
        } finally {
          input.disabled = false;
        }
      });
    }
    wireIndividual();
    wireQuick();
  });
}

// ---------- Change device-lock PIN ----------
function openChangePin() {
  openModal(`
    <h3>Change Device PIN</h3>
    <p class="muted">This only changes the quick-unlock PIN for this device — your account password/Google login is unaffected.</p>
    <label class="field-label">Current PIN</label>
    <input type="password" inputmode="numeric" maxlength="6" class="input" id="cp-old">
    <label class="field-label">New PIN (6 digits)</label>
    <input type="password" inputmode="numeric" maxlength="6" class="input" id="cp-new">
    <label class="field-label">Confirm New PIN</label>
    <input type="password" inputmode="numeric" maxlength="6" class="input" id="cp-confirm">
    <p class="error-text hidden" id="cp-err"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="cp-cancel">Cancel</button><button class="btn btn-primary" id="cp-save">Update</button></div>`);
  $('#cp-cancel').onclick = closeModal;
  $('#cp-save').onclick = async () => {
    const oldPin = $('#cp-old').value, n1 = $('#cp-new').value, n2 = $('#cp-confirm').value;
    const err = $('#cp-err');
    if (n1.length !== 6 || !/^\d{6}$/.test(n1)) { err.textContent = 'New PIN must be 6 digits.'; err.classList.remove('hidden'); return; }
    if (n1 !== n2) { err.textContent = "New PINs don't match."; err.classList.remove('hidden'); return; }
    try {
      await Store.changeDeviceLock(Store.currentUser().id, oldPin, n1);
      closeModal(); toast('PIN updated.');
    } catch (e) { err.textContent = 'Current PIN is incorrect.'; err.classList.remove('hidden'); }
  };
}

function openBiometricSettings() {
  const userId = Store.currentUser().id;
  const enabled = Store.biometricEnabled(userId);
  const supported = VaultWebAuthn.isSupported();
  openModal(`
    <h3>Biometric Authentication</h3>
    <p class="muted">${supported ? 'Use fingerprint / Face ID / Windows Hello on this device to unlock without typing your device PIN. This is a device-local convenience — your account password/Google login remains the real credential.' : 'Not available: this needs a secure context (https or localhost) and a supported platform authenticator.'}</p>
    <label class="switch-row"><span>Enable Biometric Unlock</span><input type="checkbox" id="bio-toggle" ${enabled?'checked':''} ${supported?'':'disabled'}></label>
    <div class="modal-actions"><button class="btn btn-primary btn-block" id="bio-close">Done</button></div>`);
  $('#bio-close').onclick = closeModal;
  $('#bio-toggle').onchange = async (e) => {
    if (e.target.checked) {
      try { await Store.enableBiometric(userId, prefs().name || Store.currentUser().email); toast('Biometric unlock enabled.'); }
      catch (err) { toast('Could not register biometric.'); e.target.checked = false; }
    } else {
      Store.disableBiometric(userId); toast('Biometric unlock disabled.');
    }
  };
}

function openAutoLockSettings() {
  const p = prefs();
  const opts = [1,5,15,30,60,0];
  openModal(`
    <h3>Auto-lock</h3>
    <p class="muted">Lock the app automatically after a period of inactivity.</p>
    ${opts.map(m => `<label class="switch-row"><span>${m===0?'Never':(m+' minute'+(m>1?'s':''))}</span><input type="radio" name="al" value="${m}" ${p.autoLockMinutes===m?'checked':''}></label>`).join('')}
    <div class="modal-actions"><button class="btn btn-primary btn-block" id="al-save">Save</button></div>`);
  $('#al-save').onclick = () => {
    const val = parseInt($('input[name=al]:checked').value, 10);
    const p2 = prefs(); p2.autoLockMinutes = val; Store.setPrefs(p2);
    resetAutoLockTimer(); closeModal(); renderMore(); toast('Auto-lock updated.');
  };
}

function openCurrencySettings() {
  const p = prefs();
  const list = [['₹','Indian Rupee'],['$','US Dollar'],['€','Euro'],['£','British Pound'],['¥','Yen']];
  openModal(`<h3>Currency</h3>${list.map(([sym,name])=>`<label class="switch-row"><span>${sym} ${name}</span><input type="radio" name="cur" value="${sym}" ${p.currency===sym?'checked':''}></label>`).join('')}
    <div class="modal-actions"><button class="btn btn-primary btn-block" id="cur-save">Save</button></div>`);
  $('#cur-save').onclick = () => {
    const p2 = prefs(); p2.currency = $('input[name=cur]:checked').value; Store.setPrefs(p2);
    closeModal(); renderMore(); refreshCurrentView(); toast('Currency updated.');
  };
}

const BG_PRESETS = ['#f4f5f8', '#fff7ed', '#f0fdf4', '#eff6ff', '#fdf4ff', '#fef2f2', '#0e0f13', '#101820'];
function openThemeSettings() {
  const p = prefs();
  openModal(`<h3>Theme</h3>
    <label class="switch-row"><span>☀️ Light</span><input type="radio" name="th" value="light" ${p.theme==='light'?'checked':''}></label>
    <label class="switch-row"><span>🌙 Dark</span><input type="radio" name="th" value="dark" ${p.theme==='dark'?'checked':''}></label>
    <label class="switch-row"><span>💻 System</span><input type="radio" name="th" value="system" ${p.theme==='system'?'checked':''}></label>

    <label class="field-label" style="margin-top:22px;">Background Color</label>
    <div class="swatch-row" id="bg-swatches">${BG_PRESETS.map(c => `<div class="swatch ${p.bgColor===c?'selected':''}" data-c="${c}" style="background:${c};border:1px solid var(--border);"></div>`).join('')}</div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px;">
      <input type="color" id="bg-custom" value="${p.bgColor || '#f4f5f8'}" style="width:44px;height:36px;border-radius:8px;border:1px solid var(--border);background:none;cursor:pointer;">
      <span class="muted" style="font-size:13px;">Or pick any custom color</span>
    </div>
    <button class="btn btn-text" id="bg-reset" style="padding:8px 0;">Reset to theme default</button>

    <div class="modal-actions"><button class="btn btn-primary btn-block" id="th-save">Save</button></div>`);

  let chosenBg = p.bgColor || null;
  $all('.swatch', $('#bg-swatches')).forEach(s => s.onclick = () => {
    $all('.swatch', $('#bg-swatches')).forEach(x => x.classList.remove('selected'));
    s.classList.add('selected'); chosenBg = s.dataset.c; $('#bg-custom').value = s.dataset.c;
  });
  $('#bg-custom').oninput = () => { chosenBg = $('#bg-custom').value; $all('.swatch', $('#bg-swatches')).forEach(x => x.classList.remove('selected')); };
  $('#bg-reset').onclick = () => { chosenBg = null; $all('.swatch', $('#bg-swatches')).forEach(x => x.classList.remove('selected')); toast('Will reset to theme default on save.'); };

  $('#th-save').onclick = () => {
    const p2 = prefs(); p2.theme = $('input[name=th]:checked').value; p2.bgColor = chosenBg; Store.setPrefs(p2);
    applyTheme(); closeModal(); renderMore(); toast('Theme updated.');
  };
}

// ---------- Categories manager ----------
function openCategoriesManager() {
  openSubpage('Categories', (root) => {
    const data = D();
    function draw() {
      const cats = data.categories.slice().sort((a,b)=>a.order-b.order);
      root.innerHTML = `<button class="btn btn-primary btn-block" id="cm-add" style="margin-bottom:14px;">+ Add Category</button><div id="cm-list"></div>`;
      $('#cm-list', root).innerHTML = cats.map((c,i) => `
        <div class="cat-manage-row">
          <div class="cmr-ico ${c.color}">${c.icon}</div>
          <div class="cmr-name">${c.name} <span class="mr-val">(${c.type})</span></div>
          <div class="cmr-actions">
            <button data-up="${c.id}" ${i===0?'disabled':''}>↑</button>
            <button data-down="${c.id}" ${i===cats.length-1?'disabled':''}>↓</button>
            <button data-edit="${c.id}">✎</button>
            <button data-del="${c.id}">🗑</button>
          </div>
        </div>`).join('');
      $all('[data-edit]', root).forEach(b => b.onclick = () => openCategoryEditor(b.dataset.edit, draw));
      $all('[data-del]', root).forEach(b => b.onclick = () => confirmDialog('Delete Category?', 'Existing transactions keep their record but will show as archived category.', 'Delete', async () => {
        await Store.updateCategory(b.dataset.del, { archived: true }); draw();
      }, true));
      $all('[data-up]', root).forEach(b => b.onclick = async () => { await swapOrder(data.categories, b.dataset.up, -1); draw(); });
      $all('[data-down]', root).forEach(b => b.onclick = async () => { await swapOrder(data.categories, b.dataset.down, 1); draw(); });
      $('#cm-add', root).onclick = () => openCategoryEditor(null, draw);
    }
    draw();
  });
}
async function swapOrder(list, id, dir) {
  const sorted = list.slice().sort((a,b)=>a.order-b.order);
  const idx = sorted.findIndex(c=>c.id===id);
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= sorted.length) return;
  const a = sorted[idx], b = sorted[swapIdx];
  const aOrder = a.order, bOrder = b.order;
  await Promise.all([Store.updateCategory(a.id, { order: bOrder }), Store.updateCategory(b.id, { order: aOrder })]);
}
function openCategoryEditor(catId, onDone) {
  const data = D();
  const existing = catId ? data.categories.find(c => c.id === catId) : null;
  openModal(`
    <h3>${existing ? 'Edit' : 'Add'} Category</h3>
    <label class="field-label">Name</label>
    <input class="input" id="cg-name" value="${existing?existing.name:''}">
    <label class="field-label">Type</label>
    <select class="input" id="cg-type">
      <option value="income" ${existing&&existing.type==='income'?'selected':''}>Income</option>
      <option value="expense" ${existing&&existing.type==='expense'?'selected':''}>Expense</option>
      <option value="borrow" ${existing&&existing.type==='borrow'?'selected':''}>Money Borrowed</option>
      <option value="lend" ${existing&&existing.type==='lend'?'selected':''}>Money Lent</option>
      <option value="financial" ${existing&&existing.type==='financial'?'selected':''}>Other (Savings/Investments/Credit Card)</option>
    </select>
    <label class="field-label">Color</label>
    <div class="swatch-row" id="cg-colors">${M.PALETTE.map(p=>`<div class="swatch ${p} ${existing&&existing.color===p?'selected':(!existing&&p==='pal-2'?'selected':'')}" data-c="${p}"></div>`).join('')}</div>
    <label class="field-label">Icon</label>
    <div class="icon-pick-row" id="cg-icons">${M.ICON_CHOICES.map(ic=>`<div class="icon-pick ${existing&&existing.icon===ic?'selected':''}" data-i="${ic}">${ic}</div>`).join('')}</div>
    <div class="modal-actions"><button class="btn btn-ghost" id="cg-cancel">Cancel</button><button class="btn btn-primary" id="cg-save">Save</button></div>`);
  let color = existing ? existing.color : 'pal-2';
  let icon = existing ? existing.icon : '💠';
  $all('.swatch', $('#cg-colors')).forEach(s => s.onclick = () => { $all('.swatch',$('#cg-colors')).forEach(x=>x.classList.remove('selected')); s.classList.add('selected'); color = s.dataset.c; });
  $all('.icon-pick', $('#cg-icons')).forEach(s => s.onclick = () => { $all('.icon-pick',$('#cg-icons')).forEach(x=>x.classList.remove('selected')); s.classList.add('selected'); icon = s.dataset.i; });
  $('#cg-cancel').onclick = closeModal;
  $('#cg-save').onclick = async () => {
    const name = $('#cg-name').value.trim();
    if (!name) { toast('Please enter a category name.'); return; }
    const type = $('#cg-type').value;
    if (existing) await Store.updateCategory(existing.id, { name, type, color, icon });
    else await Store.addCategory({ name, type, color, icon, order: data.categories.length, archived: false });
    closeModal(); if (onDone) onDone(); toast('Category saved.');
  };
}

// ---------- Accounts manager ----------
function openAccountsManager() {
  openSubpage('Accounts', (root) => {
    const data = D();
    function draw() {
      root.innerHTML = `<button class="btn btn-primary btn-block" id="am-add" style="margin-bottom:14px;">+ Add Account</button><div id="am-list"></div>`;
      $('#am-list', root).innerHTML = data.accounts.filter(a=>!a.archived).map(a => {
        const bal = M.accountBalance(a, data.transactions);
        const meta = M.ACCOUNT_TYPES.find(t=>t.value===a.type) || {};
        return `<div class="account-card" data-acc="${a.id}"><div><b>${meta.icon||'💼'} ${a.name}</b><span>${meta.label||a.type}</span></div><div class="acc-bal" style="color:${bal<0?'var(--red)':'var(--text)'}">${fmt(bal)}</div></div>`;
      }).join('');
      $all('.account-card', root).forEach(c => c.onclick = () => openAccountDetail(c.dataset.acc));
      $('#am-add', root).onclick = () => openAccountEditor(null, draw);
    }
    draw();
  });
}
function openAccountEditor(accId, onDone) {
  const data = D();
  const existing = accId ? data.accounts.find(a => a.id === accId) : null;
  openModal(`
    <h3>${existing?'Edit':'Add'} Account</h3>
    <label class="field-label">Name</label>
    <input class="input" id="ae-name" value="${existing?existing.name:''}">
    <label class="field-label">Type</label>
    <select class="input" id="ae-type">${M.ACCOUNT_TYPES.map(t=>`<option value="${t.value}" ${existing&&existing.type===t.value?'selected':''}>${t.icon} ${t.label}</option>`).join('')}</select>
    <label class="field-label">Opening Balance</label>
    <div class="amount-input-wrap"><span class="currency-prefix">${curSym()}</span><input class="input amount-input" id="ae-bal" inputmode="decimal" value="${existing?existing.openingBalance:0}"></div>
    <div class="modal-actions"><button class="btn btn-ghost" id="ae-cancel">Cancel</button><button class="btn btn-primary" id="ae-save">Save</button></div>`);
  $('#ae-cancel').onclick = closeModal;
  $('#ae-save').onclick = async () => {
    const name = $('#ae-name').value.trim();
    if (!name) { toast('Please enter an account name.'); return; }
    const type = $('#ae-type').value;
    const bal = parseFloat($('#ae-bal').value) || 0;
    if (existing) await Store.updateAccount(existing.id, { name, type, openingBalance: bal });
    else await Store.addAccount({ name, type, openingBalance: bal, archived: false });
    closeModal(); if (onDone) onDone(); toast('Account saved.');
  };
}
function openAccountDetail(accId) {
  const data = D();
  const acc = data.accounts.find(a => a.id === accId);
  openSubpage(acc.name, (root) => {
    const txns = data.transactions.filter(t => t.accountId === accId);
    const bal = M.accountBalance(acc, data.transactions);
    const credits = M.sumCredit(txns), debits = M.sumDebit(txns);
    root.innerHTML = `
      <div class="detail-header" style="background:var(--primary)">
        <div class="dh-ico">${(M.ACCOUNT_TYPES.find(t=>t.value===acc.type)||{}).icon||'💼'}</div>
        <div class="dh-name">${acc.name}</div>
        <div class="dh-amt">${fmt(bal)}</div>
      </div>
      <div class="kv-list">
        <div class="kv-row"><span class="kv-k">Credits</span><span class="kv-v" style="color:var(--green)">${fmt(credits)}</span></div>
        <div class="kv-row"><span class="kv-k">Debits</span><span class="kv-v" style="color:var(--red)">${fmt(debits)}</span></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-block" id="acd-edit">Edit Account</button>
        <button class="btn btn-danger btn-block" id="acd-delete">Delete Account</button>
      </div>`;
    mountFilterableTxnList(root, {
      initialPeriod: 'all',
      showMethodFilter: false,
      getTxns: (range) => M.txnsInRange(D().transactions, range).filter(t => t.accountId === accId),
    });
    $('#acd-edit', root).onclick = () => openAccountEditor(acc.id, () => openAccountDetail(acc.id));
    $('#acd-delete', root).onclick = () => confirmDialog(
      'Delete this account?',
      `Are you sure you want to delete "${acc.name}"? This action cannot be undone.${txns.length ? ` Its ${txns.length} past transaction(s) stay in your records for history, but you won't be able to pick this account for new ones.` : ''}`,
      'Delete', async () => {
        await Store.archiveAccount(acc.id);
        showSuccess('🗑 Account Deleted');
        subpageBack();
      }, true);
  });
}

// ---------- UPI manager ----------
function openUpiManager() {
  openSubpage('UPI IDs', (root) => {
    const data = D();
    function draw() {
      root.innerHTML = `<button class="btn btn-primary btn-block" id="upi-add" style="margin-bottom:14px;">+ Add UPI ID</button><div id="upi-list"></div>`;
      $('#upi-list', root).innerHTML = data.upiIds.length ? data.upiIds.map(u => `
        <div class="upi-card">
          <b>${u.upiId}</b>
          <div class="sub">${u.provider || 'UPI'} ${u.linkedAccountName ? '· ' + u.linkedAccountName : ''}</div>
          <div class="upi-actions"><button class="btn btn-sm btn-ghost" data-edit="${u.id}">Edit</button><button class="btn btn-sm btn-danger" data-del="${u.id}">Delete</button></div>
        </div>`).join('') : `<div class="empty-hint">No UPI IDs saved yet.</div>`;
      $all('[data-edit]', root).forEach(b => b.onclick = () => openUpiEditor(b.dataset.edit, draw));
      $all('[data-del]', root).forEach(b => b.onclick = () => confirmDialog('Delete UPI ID?', 'This will not affect past transactions.', 'Delete', async () => {
        await Store.deleteUpi(b.dataset.del); draw();
      }, true));
      $('#upi-add', root).onclick = () => openUpiEditor(null, draw);
    }
    draw();
  });
}
function openUpiEditor(upiId, onDone) {
  const data = D();
  const existing = upiId ? data.upiIds.find(u => u.id === upiId) : null;
  openModal(`
    <h3>${existing?'Edit':'Add'} UPI ID</h3>
    <label class="field-label">UPI ID</label>
    <input class="input" id="up-id" placeholder="username@upi" value="${existing?existing.upiId:''}">
    <label class="field-label">Provider / App</label>
    <select class="input" id="up-provider">${['Google Pay','PhonePe','Paytm','Other'].map(p=>`<option ${existing&&existing.provider===p?'selected':''}>${p}</option>`).join('')}</select>
    <label class="field-label">Linked Account Name</label>
    <input class="input" id="up-linked" value="${existing?existing.linkedAccountName||'':''}">
    <p class="error-text hidden" id="up-err"></p>
    <div class="modal-actions"><button class="btn btn-ghost" id="up-cancel">Cancel</button><button class="btn btn-primary" id="up-save">Save</button></div>`);
  $('#up-cancel').onclick = closeModal;
  $('#up-save').onclick = async () => {
    const id = $('#up-id').value.trim();
    if (!M.isValidUpi(id)) { $('#up-err').textContent = 'Enter a valid UPI ID, e.g. name@bank.'; $('#up-err').classList.remove('hidden'); return; }
    const obj = { upiId: id, provider: $('#up-provider').value, linkedAccountName: $('#up-linked').value.trim() };
    if (existing) await Store.updateUpi(existing.id, obj); else await Store.addUpi(obj);
    closeModal(); if (onDone) onDone(); toast('UPI ID saved.');
  };
}

// ---------- Backup & Restore ----------
function openBackupRestore() {
  openSubpage('Backup & Restore', (root) => {
    root.innerHTML = `
      <p class="muted">Your data lives in the cloud (Supabase), shared with your household. Save a snapshot any time as extra insurance, or load records back in from an old save file.</p>
      <button class="btn btn-primary btn-block" id="bk-export" style="margin-top:14px;">💾 Save Backup File (.sav)</button>
      <button class="btn btn-ghost btn-block" id="bk-csv" style="margin-top:10px;">📄 Export All Transactions as CSV</button>
      <label class="field-label" style="margin-top:24px;">Load from Save File</label>
      <p class="muted" style="margin-top:0;">Adds the records from the file into this household — it won't delete anything already here.</p>
      <input type="file" accept=".sav,.json" class="input" id="bk-file">
      <button class="btn btn-danger btn-block" id="bk-restore" style="margin-top:10px;">Load Save File</button>`;
    $('#bk-export', root).onclick = () => {
      const obj = { exportedAt: new Date().toISOString(), app: 'vault-money-manager', version: 2, household: Store.household() && Store.household().name, data: D() };
      downloadFile(`vault_${M.todayStr()}.sav`, JSON.stringify(obj, null, 2), 'application/octet-stream');
      toast('Save file downloaded.');
    };
    $('#bk-csv', root).onclick = () => {
      const data = D();
      const rows = [['Date','Time','Type','Category','Amount','Payment Method','Account','UPI ID','Description']];
      data.transactions.forEach(t => {
        const cat = data.categories.find(c=>c.id===t.categoryId); const acct = data.accounts.find(a=>a.id===t.accountId);
        rows.push([t.date,t.time||'',t.type,cat?cat.name:'',t.amount,t.paymentMethod,acct?acct.name:'',t.upiId||'',(t.description||'').replace(/,/g,';')]);
      });
      downloadFile('all_transactions.csv', rows.map(r=>r.join(',')).join('\n'), 'text/csv');
    };
    $('#bk-restore', root).onclick = () => {
      const file = $('#bk-file', root).files[0];
      if (!file) { toast('Choose a save file first.'); return; }
      confirmDialog('Load Save File?', 'This adds every record from the file into your current household. Duplicate transactions are possible if you load the same file twice.', 'Load', async () => {
        try {
          const text = await file.text();
          const obj = JSON.parse(text);
          toast('Loading…');
          await Store.bulkImport(obj.data || obj);
          toast('Save file loaded.'); refreshCurrentView(); goNav('home');
        } catch (e) { toast('Could not load that file: ' + e.message); }
      }, true);
    };
  });
}

// ===========================================================
// AI ASSISTANT
// ===========================================================
function openAssistant() {
  $('#ai-overlay').classList.remove('hidden');
  pushBackGuard();
  setTimeout(() => $('#ai-input').focus(), 100);
}
function closeAssistant() {
  $('#ai-overlay').classList.add('hidden');
  consumeBackGuard();
}
function appendAiMessage(text, cls) {
  const el = document.createElement('div');
  el.className = 'ai-msg ' + cls;
  el.textContent = text;
  $('#ai-messages').appendChild(el);
  $('#ai-messages').scrollTop = $('#ai-messages').scrollHeight;
  return el;
}
function showAiTyping() {
  const el = document.createElement('div');
  el.className = 'ai-typing'; el.id = 'ai-typing-indicator';
  el.innerHTML = '<span></span><span></span><span></span>';
  $('#ai-messages').appendChild(el);
  $('#ai-messages').scrollTop = $('#ai-messages').scrollHeight;
}
function hideAiTyping() {
  const el = $('#ai-typing-indicator');
  if (el) el.remove();
}
async function sendAssistantMessage() {
  if (S.aiBusy) return;
  const input = $('#ai-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendAiMessage(text, 'ai-msg-user');
  S.aiHistory.push({ role: 'user', content: text });
  S.aiBusy = true;
  showAiTyping();
  try {
    const res = await Supa.askAssistant(text, S.aiHistory.slice(0, -1), curSym());
    hideAiTyping();
    appendAiMessage(res.reply, 'ai-msg-bot');
    S.aiHistory.push({ role: 'assistant', content: res.reply });
    if (res.actions && res.actions.length) {
      res.actions.forEach(a => appendAiMessage('✓ ' + a, 'ai-msg-action'));
      await Store.refreshTable('transactions');
      refreshCurrentView();
      refreshNotifDot();
    }
  } catch (e) {
    hideAiTyping();
    appendAiMessage('Sorry, something went wrong: ' + e.message, 'ai-msg-error');
  }
  S.aiBusy = false;
}

})();
