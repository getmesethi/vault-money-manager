/* =========================================================
   store.js — data layer on top of Supa (Supabase).

   Security model, v2:
   - Real identity + access control now lives in Supabase Auth +
     Postgres Row Level Security (see the household_* policies).
     A wrong password just fails to log in; RLS means even a
     signed-in user's queries can only ever touch rows in
     households they belong to.
   - The 6-digit "PIN" is now a LOCAL DEVICE LOCK ONLY — a fast
     re-entry gate on top of an already-authenticated Supabase
     session on this device (like re-locking a banking app). It
     is NOT the encryption key for your data anymore (data isn't
     stored locally at all beyond a working cache). Its hash+salt
     lives in localStorage, scoped per Supabase user id.
   - localStorage keys:
       vp.prefs                 -> plaintext UI prefs (theme, currency, autoLockMinutes, name)
       vp.devicelock.<user_id>  -> { salt, hash } for the local quick-unlock PIN
       vp.webauthn.<user_id>    -> { credentialId } if biometric convenience-unlock is on
     Legacy (pre-cloud) keys, read only for one-time migration:
       vault.meta / vault.blob  -> old encrypted local vault
   ========================================================= */
const Store = (() => {
  const K_PREFS = 'vp.prefs';

  let _session = null;         // Supabase session
  let _household = null;       // { id, name, joinCode, ownerId, role }
  let _data = null;            // in-memory cache: { accounts, categories, transactions, budgets, recurring, upiIds }
  let _channel = null;         // realtime channel

  // ---------------- Prefs (local, non-sensitive) ----------------
  function getPrefs() {
    try {
      return Object.assign({ theme: 'system', currency: '₹', autoLockMinutes: 5, name: '', bgColor: null },
        JSON.parse(localStorage.getItem(K_PREFS) || '{}'));
    } catch (e) { return { theme: 'system', currency: '₹', autoLockMinutes: 5, name: '', bgColor: null }; }
  }
  function setPrefs(p) { localStorage.setItem(K_PREFS, JSON.stringify(p)); }

  // ---------------- Auth ----------------
  async function refreshSession() { _session = await Supa.getSession(); return _session; }
  function session() { return _session; }
  function currentUser() { return _session ? _session.user : null; }
  function onAuthStateChange(cb) { Supa.onAuthStateChange((event, session) => { _session = session; cb(event, session); }); }

  async function signUpEmail(email, password) { return Supa.signUpEmail(email, password); }
  async function signInEmail(email, password) { const d = await Supa.signInEmail(email, password); _session = d.session; return d; }
  async function signInGoogle() { return Supa.signInGoogle(); }
  async function resetPassword(email) { return Supa.resetPassword(email); }
  async function signOut() {
    stopRealtime();
    await Supa.signOut();
    _session = null; _household = null; _data = null;
  }

  // ---------------- Household ----------------
  function household() { return _household; }

  function toHouseholdObj(r) {
    return { id: r.households.id, name: r.households.name, joinCode: r.households.join_code, ownerId: r.households.owner_id, role: r.role };
  }
  function activeHouseholdKey(userId) { return 'vp.activeHousehold.' + userId; }

  async function listMyHouseholds() {
    const rows = await Supa.myMemberships();
    return rows.map(toHouseholdObj);
  }

  async function loadHousehold() {
    const list = await listMyHouseholds();
    if (!list.length) { _household = null; return null; }
    const uid = currentUser().id;
    const savedId = localStorage.getItem(activeHouseholdKey(uid));
    _household = list.find(h => h.id === savedId) || list[0];
    localStorage.setItem(activeHouseholdKey(uid), _household.id);
    return _household;
  }

  async function switchHousehold(householdId) {
    const list = await listMyHouseholds();
    const h = list.find(x => x.id === householdId);
    if (!h) throw new Error('Household not found');
    _household = h;
    localStorage.setItem(activeHouseholdKey(currentUser().id), h.id);
    stopRealtime();
    await loadAllData();
    startRealtime();
    return h;
  }

  async function renameHouseholdFlow(householdId, name) {
    await Supa.renameHousehold(householdId, name);
    if (_household && _household.id === householdId) _household.name = name;
  }
  async function leaveHouseholdFlow(householdId) { await Supa.leaveHousehold(householdId); }
  async function transferOwnershipFlow(householdId, newOwnerId) { await Supa.transferOwnership(householdId, newOwnerId); }
  async function deleteHouseholdFlow(householdId) { await Supa.deleteHousehold(householdId); }
  async function setCategoryShared(categoryId, shared) {
    const row = await Supa.setCategoryShared(categoryId, shared);
    const cat = _data.categories.find(c => c.id === categoryId);
    if (cat) cat.shared = row.shared;
    return cat;
  }
  async function deleteMyAccountForever() { return Supa.deleteUserAccount(); }
  async function setCategoryMemberShared(categoryId, userId, shared) { return Supa.setCategoryMemberShared(categoryId, userId, shared); }
  async function getCategoryMemberShares(categoryIds) { return Supa.getCategoryMemberShares(categoryIds); }
  async function setMemberPermissions(householdId, userId, canAdd, canDelete) { return Supa.setMemberPermissions(householdId, userId, canAdd, canDelete); }

  async function createHouseholdFlow(name, openingBalance, openingAccountType, seedDefaults) {
    const h = await Supa.createHousehold(name);
    _household = { id: h.id, name: h.name, joinCode: h.join_code, ownerId: h.owner_id, role: 'owner' };
    if (seedDefaults === false) return _household; // a legacy-vault import is about to supply everything instead
    // seed default categories
    const defaults = Model.defaultCategories().map(c => ({
      household_id: h.id, name: c.name, type: c.type, color: c.color, icon: c.icon, sort_order: c.order, archived: false
    }));
    await Supa.upsertRows('categories', defaults);
    // seed default accounts
    const accounts = [
      { household_id: h.id, name: 'Bank Account', type: 'bank', opening_balance: (openingAccountType === 'bank' ? openingBalance : 0) || 0 },
      { household_id: h.id, name: 'Cash', type: 'cash', opening_balance: (openingAccountType === 'cash' ? openingBalance : 0) || 0 },
      { household_id: h.id, name: 'UPI', type: 'upi', opening_balance: 0 },
      { household_id: h.id, name: 'Credit Card', type: 'credit_card', opening_balance: 0 },
    ];
    if (openingAccountType === 'savings' || openingAccountType === 'other') {
      accounts.push({ household_id: h.id, name: openingAccountType === 'savings' ? 'Savings Account' : 'Other', type: openingAccountType, opening_balance: openingBalance || 0 });
    }
    await Supa.upsertRows('accounts', accounts);
    return _household;
  }

  async function joinHouseholdFlow(code) {
    const h = await Supa.joinHousehold(code);
    _household = { id: h.id, name: h.name, joinCode: h.join_code, ownerId: h.owner_id, role: 'member' };
    return _household;
  }

  async function getMembers() { return Supa.getMembers(_household.id); }
  async function getProfiles(userIds) { return Supa.getProfiles(userIds); }
  async function updateOwnProfile(displayName) { return Supa.updateOwnProfile(displayName); }

  // ---------------- Row <-> app-object mapping ----------------
  const mapFrom = {
    accounts: r => ({ id: r.id, name: r.name, type: r.type, openingBalance: Number(r.opening_balance), archived: r.archived }),
    categories: r => ({ id: r.id, name: r.name, type: r.type, color: r.color, icon: r.icon, order: r.sort_order, archived: r.archived, shared: r.shared !== false }),
    transactions: r => ({
      id: r.id, type: r.type, amount: Number(r.amount), categoryId: r.category_id, accountId: r.account_id,
      paymentMethod: r.payment_method, date: r.date, time: r.time || '', description: r.description || '',
      upiId: r.upi_id || '', isReversal: r.is_reversal, fromRecurring: r.from_recurring,
      createdAt: new Date(r.created_at).getTime(), updatedAt: new Date(r.updated_at).getTime()
    }),
    budgets: r => ({ id: r.id, categoryId: r.category_id, amount: Number(r.amount), period: r.period }),
    recurring: r => ({ id: r.id, type: r.type, amount: Number(r.amount), categoryId: r.category_id, accountId: r.account_id, frequency: r.frequency, nextDate: r.next_date, description: r.description || '', active: r.active }),
    upi_ids: r => ({ id: r.id, upiId: r.upi_id, provider: r.provider || '', linkedAccountName: r.linked_account_name || '' }),
  };
  const mapTo = {
    accounts: a => ({ household_id: _household.id, name: a.name, type: a.type, opening_balance: a.openingBalance, archived: !!a.archived }),
    categories: c => ({ household_id: _household.id, name: c.name, type: c.type, color: c.color, icon: c.icon, sort_order: c.order, archived: !!c.archived }),
    transactions: t => ({
      household_id: _household.id, account_id: t.accountId, category_id: t.categoryId, type: t.type, amount: t.amount,
      payment_method: t.paymentMethod, date: t.date, time: t.time || null, description: t.description || null,
      upi_id: t.upiId || null, is_reversal: !!t.isReversal, from_recurring: t.fromRecurring || null,
      created_by: currentUser() ? currentUser().id : null, updated_at: new Date().toISOString()
    }),
    budgets: b => ({ household_id: _household.id, category_id: b.categoryId, amount: b.amount, period: b.period || 'monthly' }),
    recurring: r => ({ household_id: _household.id, type: r.type, amount: r.amount, category_id: r.categoryId, account_id: r.accountId, frequency: r.frequency, next_date: r.nextDate, description: r.description || null, active: r.active !== false }),
    upi_ids: u => ({ household_id: _household.id, upi_id: u.upiId, provider: u.provider || null, linked_account_name: u.linkedAccountName || null }),
  };

  const TABLES = ['accounts', 'categories', 'transactions', 'budgets', 'recurring', 'upi_ids'];
  const KEY = { accounts: 'accounts', categories: 'categories', transactions: 'transactions', budgets: 'budgets', recurring: 'recurring', upi_ids: 'upiIds' };

  function data() { return _data; }

  async function loadAllData() {
    _data = { accounts: [], categories: [], transactions: [], budgets: [], recurring: [], upiIds: [] };
    await Promise.all(TABLES.map(async t => {
      const rows = await Supa.listAll(t, _household.id);
      _data[KEY[t]] = rows.map(mapFrom[t]);
    }));
    return _data;
  }

  async function refreshTable(t) {
    if (!_data) return;
    const rows = await Supa.listAll(t, _household.id);
    _data[KEY[t]] = rows.map(mapFrom[t]);
  }

  let _realtimeCallback = null;
  function startRealtime(onChange) {
    stopRealtime();
    if (onChange) _realtimeCallback = onChange;
    _channel = Supa.subscribeHousehold(_household.id, async (table, payload) => {
      await refreshTable(table);
      if (_realtimeCallback) _realtimeCallback(table);
    });
  }
  function stopRealtime() { if (_channel) { Supa.unsubscribe(_channel); _channel = null; } }

  // Generic CRUD used by app.js — insert/update push straight into the
  // shared cache object so every render function (which calls data()
  // fresh each time) sees the change immediately.
  async function addRow(t, obj) {
    const row = await Supa.insertRow(t, mapTo[t](obj));
    const mapped = mapFrom[t](row);
    _data[KEY[t]].push(mapped);
    return mapped;
  }
  async function updateRow(t, id, patch) {
    const current = _data[KEY[t]].find(x => x.id === id);
    const merged = Object.assign({}, current, patch);
    const row = await Supa.updateRow(t, id, mapTo[t](merged));
    const mapped = mapFrom[t](row);
    Object.assign(current, mapped);
    return mapped;
  }
  async function deleteRow(t, id) {
    await Supa.deleteRow(t, id);
    _data[KEY[t]] = _data[KEY[t]].filter(x => x.id !== id);
  }

  const addTransaction = obj => addRow('transactions', obj);
  const updateTransaction = (id, patch) => updateRow('transactions', id, patch);
  const deleteTransaction = id => deleteRow('transactions', id);

  const addCategory = obj => addRow('categories', obj);
  const updateCategory = (id, patch) => updateRow('categories', id, patch);

  const addAccount = obj => addRow('accounts', obj);
  const updateAccount = (id, patch) => updateRow('accounts', id, patch);
  const archiveAccount = id => updateRow('accounts', id, { archived: true });

  const addBudget = obj => addRow('budgets', obj);
  const updateBudget = (id, patch) => updateRow('budgets', id, patch);
  const deleteBudget = id => deleteRow('budgets', id);

  const addRecurring = obj => addRow('recurring', obj);
  const updateRecurring = (id, patch) => updateRow('recurring', id, patch);
  const deleteRecurring = id => deleteRow('recurring', id);

  const addUpi = obj => addRow('upi_ids', obj);
  const updateUpi = (id, patch) => updateRow('upi_ids', id, patch);
  const deleteUpi = id => deleteRow('upi_ids', id);

  // Bulk import (used by the local->cloud migration and JSON restore)
  async function bulkImport(oldData) {
    const idMap = { categories: {}, accounts: {} };
    for (const c of oldData.categories || []) {
      const row = await Supa.insertRow('categories', mapTo.categories(c));
      idMap.categories[c.id] = row.id;
    }
    for (const a of oldData.accounts || []) {
      const row = await Supa.insertRow('accounts', mapTo.accounts(a));
      idMap.accounts[a.id] = row.id;
    }
    const txnRows = (oldData.transactions || []).map(t => mapTo.transactions(Object.assign({}, t, {
      categoryId: idMap.categories[t.categoryId] || null, accountId: idMap.accounts[t.accountId] || null,
      fromRecurring: null // old local recurring ids aren't valid UUIDs in the new schema; the audit link is informational only
    })));
    await Supa.upsertRows('transactions', txnRows);
    const budgetRows = (oldData.budgets || []).filter(b => idMap.categories[b.categoryId]).map(b => mapTo.budgets(Object.assign({}, b, { categoryId: idMap.categories[b.categoryId] })));
    await Supa.upsertRows('budgets', budgetRows);
    const recRows = (oldData.recurring || []).map(r => mapTo.recurring(Object.assign({}, r, { categoryId: idMap.categories[r.categoryId] || null, accountId: idMap.accounts[r.accountId] || null })));
    await Supa.upsertRows('recurring', recRows);
    const upiRows = (oldData.upiIds || []).map(mapTo.upi_ids);
    await Supa.upsertRows('upi_ids', upiRows);
    await loadAllData();
  }

  // ---------------- Legacy local vault (pre-cloud) — migration only ----------------
  function hasLegacyVault() {
    return !!localStorage.getItem('vault.meta') && !!localStorage.getItem('vault.blob');
  }
  async function unlockLegacyVault(pin) {
    const meta = JSON.parse(localStorage.getItem('vault.meta'));
    const key = await VaultCrypto.deriveKey(pin, meta.salt, meta.iterations);
    const blob = JSON.parse(localStorage.getItem('vault.blob'));
    return VaultCrypto.decryptJSON(blob, key); // throws if PIN wrong
  }
  function wipeLegacyVault() {
    localStorage.removeItem('vault.meta');
    localStorage.removeItem('vault.blob');
  }

  // ---------------- Local device-lock PIN ----------------
  function deviceLockKey(userId) { return 'vp.devicelock.' + userId; }
  function hasDeviceLock(userId) { return !!localStorage.getItem(deviceLockKey(userId)); }
  async function setDeviceLock(userId, pin) {
    const salt = await VaultCrypto.newSalt();
    const key = await VaultCrypto.deriveKey(pin, salt, 100000);
    const hash = await VaultCrypto.exportRawKey(key);
    localStorage.setItem(deviceLockKey(userId), JSON.stringify({ salt, hash, iterations: 100000 }));
  }
  async function verifyDeviceLock(userId, pin) {
    const raw = localStorage.getItem(deviceLockKey(userId));
    if (!raw) return false;
    const rec = JSON.parse(raw);
    const key = await VaultCrypto.deriveKey(pin, rec.salt, rec.iterations);
    const hash = await VaultCrypto.exportRawKey(key);
    return hash === rec.hash;
  }
  async function changeDeviceLock(userId, oldPin, newPin) {
    const ok = await verifyDeviceLock(userId, oldPin);
    if (!ok) throw new Error('Incorrect current PIN');
    await setDeviceLock(userId, newPin);
  }
  function clearDeviceLock(userId) { localStorage.removeItem(deviceLockKey(userId)); }

  // ---------------- Local biometric convenience gate (device-lock only) ----------------
  function webauthnKey(userId) { return 'vp.webauthn.' + userId; }
  function biometricEnabled(userId) { return !!localStorage.getItem(webauthnKey(userId)); }
  async function enableBiometric(userId, displayName) {
    const credId = await VaultWebAuthn.register(userId, displayName || 'vault-user');
    if (!credId) throw new Error('Registration cancelled');
    localStorage.setItem(webauthnKey(userId), JSON.stringify({ credentialId: credId }));
  }
  function disableBiometric(userId) { localStorage.removeItem(webauthnKey(userId)); }
  async function verifyBiometric(userId) {
    const raw = localStorage.getItem(webauthnKey(userId));
    if (!raw) return false;
    const rec = JSON.parse(raw);
    return VaultWebAuthn.verify(rec.credentialId);
  }

  return {
    getPrefs, setPrefs,
    refreshSession, session, currentUser, onAuthStateChange, signUpEmail, signInEmail, signInGoogle, resetPassword, signOut,
    household, loadHousehold, createHouseholdFlow, joinHouseholdFlow, getMembers, getProfiles, updateOwnProfile,
    listMyHouseholds, switchHousehold, renameHouseholdFlow, leaveHouseholdFlow, transferOwnershipFlow, deleteHouseholdFlow,
    setCategoryShared, deleteMyAccountForever, setCategoryMemberShared, getCategoryMemberShares, setMemberPermissions,
    data, loadAllData, refreshTable, startRealtime, stopRealtime,
    addTransaction, updateTransaction, deleteTransaction,
    addCategory, updateCategory,
    addAccount, updateAccount, archiveAccount,
    addBudget, updateBudget, deleteBudget,
    addRecurring, updateRecurring, deleteRecurring,
    addUpi, updateUpi, deleteUpi,
    bulkImport,
    hasLegacyVault, unlockLegacyVault, wipeLegacyVault,
    hasDeviceLock, setDeviceLock, verifyDeviceLock, changeDeviceLock, clearDeviceLock,
    biometricEnabled, enableBiometric, disableBiometric, verifyBiometric,
  };
})();
