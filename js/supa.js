/* =========================================================
   supa.js — thin wrapper around supabase-js: auth, household
   management, and CRUD for every shared financial table.
   RLS on the server is the real security boundary — this file
   just calls the API; it never trusts anything back from the
   server as "safe HTML" (all rendering escapes/uses textContent
   or template literals with values the user themselves typed).
   ========================================================= */
const Supa = (() => {
  const URL = 'https://kdzdmtswlegmplsfmwjk.supabase.co';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkemRtdHN3bGVnbXBsc2Ztd2prIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NzY2OTEsImV4cCI6MjEwNDE1MjY5MX0.OfvaFHKbH3wUraqdWKQy_SwzzMnr1thKu7fvUHuREJU';

  const client = window.supabase.createClient(URL, ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  // ---------------- Auth ----------------
  async function getSession() {
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  }
  function onAuthStateChange(cb) {
    client.auth.onAuthStateChange((event, session) => cb(event, session));
  }
  async function signUpEmail(email, password) {
    const { data, error } = await client.auth.signUp({
      email, password,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    return data;
  }
  async function signInEmail(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }
  async function signInGoogle() {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    return data;
  }
  async function resetPassword(email) {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) throw error;
  }
  async function signOut() {
    await client.auth.signOut();
  }

  // ---------------- Household ----------------
  async function myMemberships() {
    // IMPORTANT: household_members' RLS policy (is_household_member) lets any
    // member of a household read ALL membership rows for that household, not
    // just their own — that's needed elsewhere for rendering the Members
    // list. Without filtering by our own user id here, that means an owner
    // with 1 other member would get back 2 rows for the SAME household (their
    // own 'owner' row + the other member's 'member' row), rendering as a
    // duplicate household card. So always scope this to our own rows.
    const { data: { user }, error: userErr } = await client.auth.getUser();
    if (userErr) throw userErr;
    if (!user) return [];
    const { data, error } = await client.from('household_members')
      .select('household_id, role, households(id, name, join_code, owner_id)')
      .eq('user_id', user.id);
    if (error) throw error;
    return data;
  }
  async function createHousehold(name) {
    const { data, error } = await client.rpc('create_household', { p_name: name });
    if (error) throw error;
    return data;
  }
  async function joinHousehold(code) {
    const { data, error } = await client.rpc('join_household', { p_join_code: code });
    if (error) throw error;
    return data;
  }
  async function getMembers(householdId) {
    const { data, error } = await client.from('household_members').select('*').eq('household_id', householdId);
    if (error) throw error;
    return data;
  }
  async function renameHousehold(householdId, name) {
    const { error } = await client.from('households').update({ name }).eq('id', householdId);
    if (error) throw error;
  }
  async function leaveHousehold(householdId) {
    const { error } = await client.rpc('leave_household', { p_household_id: householdId });
    if (error) throw error;
  }
  async function transferOwnership(householdId, newOwnerId) {
    const { error } = await client.rpc('transfer_household_ownership', { p_household_id: householdId, p_new_owner_id: newOwnerId });
    if (error) throw error;
  }
  async function deleteHousehold(householdId) {
    const { error } = await client.rpc('delete_household', { p_household_id: householdId });
    if (error) throw error;
  }
  async function setCategoryShared(categoryId, shared) {
    const { data, error } = await client.rpc('set_category_shared', { p_category_id: categoryId, p_shared: shared });
    if (error) throw error;
    return data;
  }
  // Per-member override on top of the household-wide categories.shared
  // master switch (see categories_select_member RLS policy). Household OFF
  // always wins regardless of what's stored here.
  async function setCategoryMemberShared(categoryId, userId, shared) {
    const { data, error } = await client.rpc('set_category_member_shared', { p_category_id: categoryId, p_user_id: userId, p_shared: shared });
    if (error) throw error;
    return data;
  }
  async function getCategoryMemberShares(categoryIds) {
    if (!categoryIds.length) return [];
    const { data, error } = await client.from('category_member_shares').select('category_id, user_id, shared').in('category_id', categoryIds);
    if (error) throw error;
    return data;
  }
  // Owner-only: restrict (or restore) a specific member's ability to add or
  // delete transactions in this household. The owner themself can never be
  // restricted (enforced server-side, not just here).
  async function setMemberPermissions(householdId, userId, canAdd, canDelete) {
    const { data, error } = await client.rpc('set_member_permissions', { p_household_id: householdId, p_user_id: userId, p_can_add: canAdd, p_can_delete: canDelete });
    if (error) throw error;
    return data;
  }
  async function deleteUserAccount() {
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('Not signed in.');
    const resp = await fetch(`${URL}/functions/v1/delete-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ confirm: 'DELETE' })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not delete account.');
    return data;
  }
  async function getProfiles(userIds) {
    if (!userIds.length) return [];
    const { data, error } = await client.from('profiles').select('*').in('id', userIds);
    if (error) throw error;
    return data;
  }
  async function updateOwnProfile(displayName) {
    const { error } = await client.from('profiles').update({ display_name: displayName }).eq('id', (await client.auth.getUser()).data.user.id);
    if (error) throw error;
  }

  // ---------------- Generic table helpers ----------------
  function table(name) { return client.from(name); }

  async function listAll(name, householdId) {
    const { data, error } = await client.from(name).select('*').eq('household_id', householdId);
    if (error) throw error;
    return data;
  }
  async function insertRow(name, row) {
    const { data, error } = await client.from(name).insert(row).select().single();
    if (error) throw error;
    return data;
  }
  async function updateRow(name, id, patch) {
    const { data, error } = await client.from(name).update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  async function deleteRow(name, id) {
    const { error } = await client.from(name).delete().eq('id', id);
    if (error) throw error;
  }
  async function upsertRows(name, rows) {
    if (!rows.length) return [];
    const { data, error } = await client.from(name).insert(rows).select();
    if (error) throw error;
    return data;
  }

  // ---------------- AI Assistant (Edge Function) ----------------
  async function askAssistant(message, history, currency) {
    const { data: { session } } = await client.auth.getSession();
    if (!session) throw new Error('Not signed in.');
    const resp = await fetch(`${URL}/functions/v1/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ message, history, currency })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Assistant request failed.');
    return data; // { reply, actions }
  }

  // ---------------- Realtime ----------------
  function subscribeHousehold(householdId, onChange) {
    const channel = client.channel('household-' + householdId);
    ['accounts','categories','transactions','budgets','recurring','upi_ids','household_members','dues'].forEach(t => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `household_id=eq.${householdId}` }, (payload) => onChange(t, payload));
    });
    channel.subscribe();
    return channel;
  }
  function unsubscribe(channel) {
    if (channel) client.removeChannel(channel);
  }

  return {
    client, getSession, onAuthStateChange, signUpEmail, signInEmail, signInGoogle, resetPassword, signOut,
    myMemberships, createHousehold, joinHousehold, getMembers, getProfiles, updateOwnProfile,
    renameHousehold, leaveHousehold, transferOwnership, deleteHousehold, setCategoryShared, deleteUserAccount,
    setCategoryMemberShared, getCategoryMemberShares, setMemberPermissions,
    listAll, insertRow, updateRow, deleteRow, upsertRows,
    subscribeHousehold, unsubscribe, askAssistant
  };
})();
