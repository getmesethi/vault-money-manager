# Vault — Personal Money Manager (Cloud Edition)

A household expense tracker backed by **Supabase** (Postgres + Auth + Realtime).
Sign in with email/password or Google, share one household's accounts,
categories, transactions and budgets with a partner, and see changes sync
live across devices.

## Running it

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "serve.ps1"
```

Serves the static files at **http://localhost:8791**. Any static server works
identically — this is still plain HTML/CSS/JS, no build step. A browser is
required (not `file://`) so Supabase's session storage and OAuth redirect work
correctly.

## Project layout

```
index.html          screens: auth, household setup, migration, device-PIN lock, app shell
css/style.css         design tokens, layout, animations, light/dark themes
js/crypto.js           PBKDF2 helpers (now only used for the local device-lock PIN + reading old backups)
js/webauthn.js          biometric convenience-unlock (WebAuthn)
js/model.js              default categories, calculations (unchanged from local version)
js/supa.js                thin wrapper over supabase-js: auth, household RPCs, table CRUD, realtime
js/store.js               data layer: session/household state + in-memory cache synced with Supabase
js/charts.js               inline-SVG charts (unchanged)
js/app.js                  navigation, rendering, all screen wiring
serve.ps1                    zero-dependency local dev server
```

## Architecture — what changed from the local-only version

- **Real accounts.** Supabase Auth handles sign-up/sign-in (email+password)
  and Google OAuth. A wrong password just fails to authenticate — there's a
  real server now, so "forgot password" is a real, working reset-email flow.
- **Households replace the single-device vault.** Every table (`accounts`,
  `categories`, `transactions`, `budgets`, `recurring`, `upi_ids`) has a
  `household_id`. A `households` + `household_members` pair of tables tracks
  who belongs to which household. The first person creates one and gets a
  6-character join code; a partner enters that code to see and edit the same
  data. Both directions were tested (a transaction added by either member is
  visible to both).
- **Row Level Security is the real security boundary now**, not client-side
  encryption. Every policy checks membership via a `is_household_member()`
  helper function (needed to avoid a classic Postgres RLS pitfall: a policy
  on `household_members` that queries `household_members` itself recurses
  infinitely unless routed through a `security definer` function that
  bypasses RLS internally — this is fixed and tested).
- **The 6-digit PIN is now a *device* lock, not encryption.** It gates
  re-entry into an already-authenticated browser session on one device (like
  re-locking a banking app) — it is hashed and stored per-device via
  `localStorage`, keyed by your Supabase user id. It is **not** the key to
  your data anymore; your data's real protection is your account
  password/Google login plus RLS. "Forgot PIN" now just signs you out so you
  can log back in with your real credentials — no more "wipe everything," a
  genuine improvement over the old local-only design.
- **One-time migration.** If this browser still has the old local-only
  encrypted vault, the app detects it after you create/join a household and
  offers to import it (enter its old PIN) — this was tested with real data
  end-to-end (accounts, categories, transactions all copied over correctly).
- **Realtime.** Every table is in the `supabase_realtime` publication; the
  app subscribes per-household and refreshes the current view when any
  member's device changes something.

## What you still need to do

1. **Google Sign-In needs one manual setup step in Google Cloud Console +
   the Supabase dashboard** — I can't create OAuth credentials on your
   behalf. In your Supabase project → **Authentication → Providers → Google**,
   turn it on and paste in a Client ID + Client Secret from a Google Cloud
   OAuth consent screen you create at https://console.cloud.google.com/apis/credentials
   (type "Web application"). Add this exact Authorized redirect URI there:
   `https://kdzdmtswlegmplsfmwjk.supabase.co/auth/v1/callback`
   Until that's done, the "Continue with Google" button will error — email/
   password sign-in works today with no setup.
2. **Email confirmation** is on by default (Supabase's built-in mailer, with
   a low rate limit meant for testing, not real traffic). For frictionless
   family use, either turn off "Confirm email" in **Authentication → Providers
   → Email**, or connect a custom SMTP provider under **Project Settings →
   Auth → SMTP Settings** if you want reliable delivery at normal usage.
3. **Turn on leaked-password protection** (Supabase flagged this as off by
   default) — **Authentication → Policies → Password** — a free, one-click
   improvement that checks new passwords against known breach lists.
4. **Each household member just runs the app locally** (`serve.ps1` on their
   own machine, or any static host) and either creates the household or
   joins it with the 6-character code shown under the **Household** section
   of the drawer/More menu. There's no need to publicly host the frontend
   for this to work — only the Supabase backend needs to be reachable, which
   it already is.

## Supabase project

- Project ref: `kdzdmtswlegmplsfmwjk` (region `ap-northeast-1`)
- Dashboard: https://supabase.com/dashboard/project/kdzdmtswlegmplsfmwjk
- The anon/publishable key embedded in `js/supa.js` is meant to be public —
  it has no access without a valid session, and RLS gates everything else.
