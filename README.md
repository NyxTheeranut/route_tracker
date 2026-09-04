# Route Planner

A route-planning tool for field sales reps: see your assigned stores on a map,
build a driving route, tick off visits, synced to a Google Sheet.

Each signed-in person sees **only their own stores** — enforced by the backend,
not just hidden in the page. The page itself ships with no store data at all;
it's fetched after sign-in, scoped to whoever is signed in.

## How it fits together

```
Browser (this page, hosted on GitHub Pages)
   │  Google Sign-In (Google Identity Services)
   ▼
Apps Script Web App  ──executes as the Sheet owner──▶  Google Sheet
   │   verifies the ID token against Google directly        "Users" tab (who can see what)
   │   looks up the signed-in email in the "Users" tab       "7-Eleven Stores" / "RTR Stores" tabs
   │   returns ONLY that person's stores                     daily visit tabs (2026-09-03, ...)
   ▼
this page renders the map/routes/checklist for just those stores
```

`update_stores_sheet.py` is a separate, local-only tool — it re-reads the
source xlsx files on your machine and pushes the full store list into the
Sheet. It's never called from the hosted page.

## One-time setup

### 1. Google Cloud Console — OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (or pick an existing one) dedicated to this app.
2. **APIs & Services → OAuth consent screen** — configure it (External or
   Internal depending on your Google Workspace situation), add yourself as a
   test user if it stays in "Testing" publish status.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Authorized JavaScript origins — add both:
     - `https://<your-github-username>.github.io`
     - `http://localhost:8090` (for local testing via `Start Route Planner.command`)
   - Leave "Authorized redirect URIs" empty — Google Identity Services'
     sign-in button doesn't use a redirect flow.
4. Copy the **Client ID** (looks like `123...-abc....apps.googleusercontent.com`).
   You do **not** need the client secret for this — the page only ever uses
   the Client ID, client-side.

### 2. Google Sheet + Apps Script backend

1. Create a new Google Sheet.
2. **Extensions → Apps Script**, delete the starter code, paste in the full
   contents of `Sheets Sync - Apps Script Code.gs` from this repo.
3. **Project Settings** (gear icon, left sidebar) → **Script Properties** →
   add two:
   - `OAUTH_CLIENT_ID` = the Client ID from step 1.
   - `SYNC_SECRET` = any random string, e.g. from `openssl rand -hex 24` in a
     terminal. Gates the `syncStores` action (used only by
     `update_stores_sheet.py`, see step 5) — without it, anyone who finds the
     deployment URL could overwrite the entire store list with one request,
     since that action can't go through the sign-in check the way everything
     else does.
4. **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
     (real access control happens via the ID token + Users tab check inside
     the script, not via this deployment setting)
5. Deploy, authorize when prompted, copy the **Web app URL**.

### 3. Wire the two together

1. In `index.html`, set `GOOGLE_CLIENT_ID` (near the top of the
   `<script>` block) to the Client ID from step 1.
2. Set `DEFAULT_SYNC_URL` to the Web app URL from step 2.

### 4. Add your team to the Users tab

1. Open the page and sign in once with the account that should be admin —
   this auto-creates a "Users" tab in the Sheet with a sample row.
2. In the Sheet, edit that row (or add a new one) for yourself:
   `email | role | person_name | cm_name` — set `role` to `admin` to see
   everything, or `ae` to see just the stores where `person` matches
   `person_name`, or `cm` for a team (`cm` matches `cm_name`).
3. Add a row per teammate. Delete the sample row.

### 5. Push the store list

Create a file named `sync_secret.txt` next to (one level above) this repo —
i.e. in the `Dashboard` folder — containing exactly the `SYNC_SECRET` value
from step 2, no extra whitespace. **Never commit this file**; it lives
outside the repo specifically so it can't be. Then run
`update_stores_sheet.py` (or double-click `Update Store List.command` in the
Dashboard folder) to populate the "7-Eleven Stores" / "RTR Stores" tabs.
Re-run it any time the source xlsx files change.

### 6. Deploy to GitHub Pages

Push this repo to GitHub, then **Settings → Pages → Source: Deploy from a
branch → `main` / `(root)`**. The page will be live at
`https://<your-username>.github.io/<repo-name>/`.

## Security notes

- The Apps Script deployment uses "Anyone" access, but that's not the real
  gate — every request carries a Google ID token, which the script verifies
  directly against Google (checking both the signature and that it was
  issued for *this* app's Client ID) before trusting the email in it.
- A verified token proves who's calling, not that they're allowed to do what
  they're asking. `markVisited` and `getVisits` additionally require the
  email to be a row in the Users tab (not just any Google account — an
  unrecognized email gets nothing back, an explicit "not set up" response,
  same as `myStores`), and require the `person`/`cm` in the request to
  actually be the caller's own (or their team's, for `cm`/`admin` roles) — an
  `ae` can't read or write another salesperson's visit records by passing a
  different name in the request.
- `syncStores` can't go through that check at all — it's not a person
  signing in, it's `update_stores_sheet.py` running on your own machine — so
  it's gated by `SYNC_SECRET` instead (see step 2 and step 5 above). This
  deployment's URL is not actually secret; it's embedded directly in the
  public `index.html`, so without this, "Anyone" access would mean anyone on
  the internet could overwrite the store list with one request.
