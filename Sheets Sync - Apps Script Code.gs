/**
 * Route Planner -- Google Sheets backend (visit sync + per-person auth).
 *
 * What this is: the API the hosted Route Planner page calls. It runs inside a
 * Google Sheet, as that Sheet's owner -- there is no separate server to host or
 * pay for, and the Sheet itself is the database.
 *
 * ── Data layout ────────────────────────────────────────────────────────────
 * "7-Eleven Stores" / "RTR Stores" -- the store master list. Populated (fully
 *   overwritten each run, never appended) by running update_stores_sheet.py
 *   locally whenever the source xlsx files change. This is what myStores reads
 *   from and scopes down per caller.
 * "Users" -- who's allowed in, and what they can see. Columns: email, role,
 *   person_name, cm_name. role is one of:
 *     ae    -> sees only stores where store.person === person_name
 *     cm    -> sees only stores where store.cm === cm_name
 *     admin -> sees everything
 *   Created automatically (with a sample row) the first time anyone signs in,
 *   if it doesn't exist yet -- fill in real rows for your team, delete the
 *   sample row.
 * Daily tabs (e.g. "2026-09-03") -- one per day, visit check-off history. See
 *   getDaySheet_ below. Tabs older than RETENTION_DAYS are deleted automatically.
 * "Routes" -- the current route plan per person, so it follows them from
 *   laptop to phone. One row per email, overwritten in place (see the
 *   route plans section below for why it's shaped that way).
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * The page signs the user in with Google Identity Services and sends the
 * resulting ID token on every request. This script verifies that token against
 * Google directly (no session/cookie trust needed) and checks the token's
 * audience against OAUTH_CLIENT_ID, so it only accepts tokens issued for THIS
 * app -- not a token from some other Google sign-in.
 *
 * A verified token proves WHO is calling, not that they're allowed to. Every
 * action enforces that separately:
 *   myStores               -> requires the email to be a row in Users, scopes
 *                              the returned stores to that row's role.
 *   markVisited / getVisits -> requireTeamMember_ requires the same Users-tab
 *                              membership (a valid Google account alone is
 *                              NOT enough -- it must be a signed-up teammate),
 *                              then requireOwnScope_ requires the person/cm in
 *                              the request to actually be the caller's own
 *                              (or their team's, for cm/admin).
 *   saveRoute / loadRoute   -> same Users-tab membership, then keyed entirely
 *                              by the VERIFIED email from the token. These
 *                              take no person/cm from the request at all, so
 *                              unlike markVisited there's no client-supplied
 *                              identity to validate in the first place.
 *   syncStores              -> not a person signing in at all (it's
 *                              update_stores_sheet.py on your machine), so it
 *                              can't go through the Users tab -- gated by a
 *                              shared SYNC_SECRET instead.
 *
 * ── SETUP (one-time) ─────────────────────────────────────────────────────
 *  1. Create a new Google Sheet (or open one you want to use for this).
 *  2. Extensions -> Apps Script. Delete any starter code, paste this whole file in.
 *  3. Project Settings (gear icon, left sidebar) -> Script Properties -> Add:
 *       OAUTH_CLIENT_ID = <the Client ID from Google Cloud Console -- see the
 *       Route Planner repo's README for how to create it>
 *       SYNC_SECRET = <any random string -- generate one with, e.g.,
 *       `openssl rand -hex 24` in a terminal. Also put this exact value into
 *       update_stores_sheet.py's SYNC_SECRET constant. This is what stops
 *       anyone who finds the deployment URL from overwriting your store list
 *       -- without it, "Anyone" access means anyone, not just your script.>
 *  4. Deploy -> New deployment -> Type: Web app.
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     ("Anyone" is fine here -- real access control happens via the ID token +
 *     Users tab check above, not via this deployment setting.)
 *  5. Deploy, authorize when prompted, copy the Web app URL into the page's
 *     config (see the frontend repo).
 *  6. Sign in once from the page with the account that should be admin -- this
 *     creates the Users tab. Edit that row's role to "admin", add the rest of
 *     the team below it, delete the sample row.
 */

var RETENTION_DAYS = 30; // how many days of daily visit tabs to keep before auto-deleting
var VISIT_HEADER = [
  "timestamp", "date", "person", "cm", "storeCode", "storeName", "storeType", "visited",
];
var STORE_HEADER = [
  "code", "type", "name", "person", "cm", "status",
  "district", "subdistrict", "address", "lat", "lng",
];
var DATE_SHEET_RE = /^\d{4}-\d{2}-\d{2}$/;

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.action === "myStores") {
      return jsonResponse_(myStores_(body.idToken));
    }

    if (body.action === "markVisited") {
      var user = requireTeamMember_(body.idToken);
      requireOwnScope_(user, body.person, body.cm);
      upsertVisit_(body);
      return jsonResponse_({ ok: true });
    }

    // The route plan itself, so it survives changing device (plan on the
    // laptop, run it from the phone). Keyed by the VERIFIED email off the
    // token -- never by a name from the request body, and never by
    // person_name, which is blank for admins and would collide. Nothing in
    // the request identifies the caller, so there's nothing to spoof.
    if (body.action === "saveRoute") {
      var routeUser = requireTeamMember_(body.idToken);
      saveRoute_(routeUser.email, body.plan, body.summary);
      return jsonResponse_({ ok: true });
    }

    if (body.action === "loadRoute") {
      var loadUser = requireTeamMember_(body.idToken);
      return jsonResponse_({ ok: true, plan: loadRoute_(loadUser.email) });
    }

    if (body.action === "syncStores") {
      // Only ever called from your own machine via update_stores_sheet.py, but
      // unlike the other actions it can't go through the ID-token/Users-tab
      // check -- it's not a person signing in, it's a script. It still needs
      // SOME check, though: this deployment's URL sits in plain text in the
      // public index.html, so without one, anyone who finds it could wipe and
      // replace the entire store list with a single unauthenticated request.
      requireSyncSecret_(body.secret);
      var count = syncStores_(body.stores || []);
      return jsonResponse_({ ok: true, count: count });
    }

    return jsonResponse_({ ok: false, error: "unknown action" });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === "getVisits") {
      var user = requireTeamMember_(e.parameter.idToken);
      var person = e.parameter.person || "";
      var date = e.parameter.date || "";
      requireOwnScope_(user, person, null);
      return jsonResponse_({ ok: true, visits: getVisits_(person, date) });
    }
    return jsonResponse_({ ok: true });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err) });
  }
}

// ---------- auth ----------

function requireAuth_(idToken) {
  var email = verifyIdToken_(idToken);
  if (!email) throw new Error("not signed in");
  return email;
}

// Like requireAuth_, but also requires the verified email to actually be a row
// in the Users tab -- markVisited/getVisits used to skip this (only myStores_
// checked it), so any Google account, not just this team's, could write or
// read visit records once it had a token for this app's client ID.
function requireTeamMember_(idToken) {
  var email = requireAuth_(idToken);
  var user = lookupUser_(email);
  if (!user) throw new Error("no_access: " + email + " is not in the Users tab");
  user.email = email;
  return user;
}

// admin/cm can act on anyone in their scope; an ae can only mark/read their
// own visits. Without this, any signed-in team member could pass a different
// person's name in the request body and write or read someone else's data --
// the token only proves who's calling, not that they're allowed to touch the
// record they're asking for.
function requireOwnScope_(user, person, cm) {
  if (user.role === "admin") return;
  if (user.role === "cm") {
    if (cm != null && cm !== user.cmName) throw new Error("forbidden: not your team");
    return;
  }
  if (person !== user.personName) throw new Error("forbidden: not your own records");
}

// syncStores_ isn't a person signing in -- it's update_stores_sheet.py on your
// own machine -- so it can't be checked against the Users tab. A shared
// secret (set once as a Script Property, and passed by the python script) is
// the minimum needed so this deployment's public URL alone isn't enough to
// overwrite the store list.
function requireSyncSecret_(secret) {
  var expected = PropertiesService.getScriptProperties().getProperty("SYNC_SECRET");
  if (!expected) throw new Error("SYNC_SECRET script property is not set -- see setup notes at the top of this file");
  if (secret !== expected) throw new Error("forbidden: bad sync secret");
}

// Verifies the ID token directly against Google (not just trusting the client) and
// checks it was issued for THIS app specifically, via the audience claim.
function verifyIdToken_(idToken) {
  if (!idToken) return null;
  var resp = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var expectedClientId = PropertiesService.getScriptProperties().getProperty("OAUTH_CLIENT_ID");
  if (!expectedClientId) throw new Error("OAUTH_CLIENT_ID script property is not set -- see setup notes at the top of this file");
  if (data.aud !== expectedClientId) return null;
  if (!data.email || data.email_verified !== "true") return null;
  return data.email;
}

// Looks up role/scope for a verified email. Creates the Users tab (with a sample
// row) on first use if it doesn't exist yet, so there's something to edit.
function lookupUser_(email) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Users");
  if (!sheet) {
    sheet = ss.insertSheet("Users");
    sheet.appendRow(["email", "role", "person_name", "cm_name"]);
    sheet.appendRow(["example@gmail.com", "ae", "ทิพวรรณ โพธิ์คัง", "ชานนท์ สิงหเรศร์"]);
    sheet.setFrozenRows(1);
    return null; // just created -- nothing real to match against yet
  }
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[idx.email]).trim().toLowerCase() === email.toLowerCase()) {
      return {
        role: String(row[idx.role] || "ae").trim().toLowerCase(),
        personName: String(row[idx.person_name] || "").trim(),
        cmName: String(row[idx.cm_name] || "").trim(),
      };
    }
  }
  return null;
}

// ---------- myStores: the whole point of the auth layer ----------
// Returns ONLY what the signed-in caller is allowed to see -- an ae's own
// stores, a cm's team, or everything for admin. An email not in the Users tab
// gets nothing back (ok:false), not a filtered-to-empty list, so the page can
// tell "not set up yet" apart from "genuinely has zero stores".
function myStores_(idToken) {
  var email = verifyIdToken_(idToken);
  if (!email) return { ok: false, error: "not_signed_in" };
  var user = lookupUser_(email);
  if (!user) {
    return {
      ok: false,
      error: "no_access",
      message: "This Google account (" + email + ") isn't set up yet. Ask an admin to add it to the Users tab.",
    };
  }
  var stores = readAllStores_();
  var scoped;
  if (user.role === "admin") {
    scoped = stores;
  } else if (user.role === "cm") {
    scoped = stores.filter(function (s) { return s.cm === user.cmName; });
  } else {
    scoped = stores.filter(function (s) { return s.person === user.personName; });
  }
  return {
    ok: true,
    email: email,
    role: user.role,
    stores: scoped,
    // Not used by the normal UI -- surfaced in the browser console so "why do
    // I see 0 stores" is answerable by looking, not guessing: is it that no
    // store data was found at all, or that data exists but didn't match this
    // person/cm's name exactly?
    debug: {
      totalStoresFound: stores.length,
      totalByType: countByType_(stores),
      matchedForYou: scoped.length,
      matchedOn: user.role === "admin" ? "admin (no filter)"
        : user.role === "cm" ? { cm: user.cmName }
        : { person: user.personName },
    },
  };
}

function countByType_(stores) {
  var counts = {};
  stores.forEach(function (s) {
    var t = s.type || "unknown";
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

// Scans every tab in the spreadsheet and reads any that look like store data --
// by COLUMN STRUCTURE (has code/type/lat/lng), not by an exact tab name. That
// way it doesn't matter whether a tab is named "7-Eleven Stores", was renamed
// by hand, or split differently -- it's picked up either way. It also means
// this never accidentally reads the Users tab or a daily visit tab, since
// neither has this column shape.
function readAllStores_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  ss.getSheets().forEach(function (sheet) {
    // Only tabs syncStores_ actually writes ("7-Eleven Stores", "RTR Stores",
    // "<type> Stores"). This used to scan EVERY tab and take anything with a
    // matching column shape, which also swept up strays like a leftover
    // "Sheet1" -- rows there with shifted columns showed up as bogus
    // salespeople (a store name appearing as a person tab). Still checks the
    // column shape below, so a "Stores" tab with the wrong columns is skipped.
    if (!/stores$/i.test(sheet.getName().trim())) return;
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return;
    var idx = {};
    data[0].forEach(function (h, i) { idx[String(h).trim()] = i; });
    if (idx.code == null || idx.type == null || idx.lat == null || idx.lng == null) return;
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (!row[idx.code]) continue;
      var type = row[idx.type];
      out.push({
        id: (type === "7-11" ? "7-" : "R-") + row[idx.code],
        type: type,
        code: String(row[idx.code]),
        name: row[idx.name],
        // Trimmed to match lookupUser_'s personName/cmName exactly -- without this, a stray
        // trailing space in the source xlsx (invisible in a spreadsheet cell) makes the === match
        // in myStores_ fail for every single store, silently. That's the whole reason a CM/AE can
        // sign in fine but see zero stores with no error: the comparison never throws, it just
        // never matches.
        person: String(row[idx.person] || "").trim(),
        cm: String(row[idx.cm] || "").trim(),
        status: row[idx.status],
        district: row[idx.district],
        subdistrict: row[idx.subdistrict],
        address: row[idx.address] || "",
        lat: Number(row[idx.lat]),
        lng: Number(row[idx.lng]),
      });
    }
  });
  return out;
}

// ---------- route plans (one row per person, overwritten in place) ----------
// Deliberately ONE ROW PER PERSON, with the whole plan as JSON in a single
// cell, rather than a row per store per day. Finishing a route consumes the
// plan instead of producing history: 10 salespeople is 10 rows in week 1 and
// still 10 rows in week 500, so there's no growth and nothing to clean up.
// The permanent record of what actually happened is the daily visit tabs --
// that's a separate job, and it already has its own retention. A row-per-store
// design would add ~90 rows per person per week and need a second cleanup job
// fighting it.
var ROUTES_HEADER = ["email", "updatedAt", "summary", "planJson"];
// Sheets caps a cell at 50k characters; leave headroom rather than failing at
// the boundary. A 400-store plan is ~8k, so this is far from binding.
var MAX_PLAN_CHARS = 45000;

function routesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Routes");
  if (!sheet) {
    sheet = ss.insertSheet("Routes");
    sheet.appendRow(ROUTES_HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function saveRoute_(email, planJson, summary) {
  if (typeof planJson !== "string") throw new Error("plan must be a JSON string");
  if (planJson.length > MAX_PLAN_CHARS) throw new Error("plan too large");
  var sheet = routesSheet_();
  var data = sheet.getDataRange().getValues();
  var row = [email, new Date(), summary || "", planJson];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email.toLowerCase()) {
      writeRouteRow_(sheet, i + 1, row);
      return;
    }
  }
  writeRouteRow_(sheet, data.length + 1, row);
}

function writeRouteRow_(sheet, rowNum, row) {
  var range = sheet.getRange(rowNum, 1, 1, ROUTES_HEADER.length);
  // Same lesson as writeStoreSheet_: format as plain text BEFORE writing, so
  // Sheets can't reinterpret any part of the JSON payload as a date/number.
  range.setNumberFormat("@");
  range.setValues([row]);
}

function loadRoute_(email) {
  var sheet = routesSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === email.toLowerCase()) {
      return String(data[i][3] || "");
    }
  }
  return "";
}

// ---------- daily visit tabs ----------

// Gets (or creates) the tab for a given day. Creating a new day's tab is also the
// trigger point for cleaning up old ones -- that keeps cleanup to at most once per
// day rather than running on every single sync request.
function getDaySheet_(dateStr, createIfMissing) {
  // dateStr comes straight from the request body/query string. Without this
  // check, a caller could pass date:"Users" (or "7-Eleven Stores", etc.) and
  // this would happily fetch that REAL tab and let upsertVisit_ write a
  // visit-shaped row into it -- wrong columns, live data corrupted. Every
  // other value here is either the literal "*Stores" sync tabs or a genuine
  // yyyy-mm-dd tab; nothing legitimate ever needs another shape.
  if (!DATE_SHEET_RE.test(dateStr)) throw new Error("invalid date");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(dateStr);
  if (!sheet && createIfMissing) {
    sheet = ss.insertSheet(dateStr);
    sheet.appendRow(VISIT_HEADER);
    sheet.setFrozenRows(1);
    cleanupOldSheets_(dateStr);
  }
  return sheet;
}

function visitColIndex_() {
  var idx = {};
  VISIT_HEADER.forEach(function (h, i) { idx[h] = i; });
  return idx;
}

function upsertVisit_(body) {
  var dateStr =
    body.date ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var sheet = getDaySheet_(dateStr, true);
  var idx = visitColIndex_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (
      row[idx.person] === body.person &&
      String(row[idx.storeCode]) === String(body.storeCode)
    ) {
      sheet.getRange(i + 1, idx.timestamp + 1).setValue(new Date());
      sheet.getRange(i + 1, idx.visited + 1).setValue(!!body.visited);
      return;
    }
  }
  sheet.appendRow([
    new Date(),
    dateStr,
    body.person || "",
    body.cm || "",
    body.storeCode || "",
    body.storeName || "",
    body.storeType || "",
    !!body.visited,
  ]);
}

function getVisits_(person, dateStr) {
  var sheet = getDaySheet_(dateStr, false);
  if (!sheet) return [];
  var idx = visitColIndex_();
  var data = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[idx.person] === person) {
      out.push({
        storeCode: row[idx.storeCode],
        storeName: row[idx.storeName],
        visited: !!row[idx.visited],
        timestamp: row[idx.timestamp],
      });
    }
  }
  return out;
}

// Deletes any date-named tab more than RETENTION_DAYS older than `referenceDateStr`.
// e.g. with the default 30-day retention, creating the "2026-10-01" tab deletes
// "2026-09-01" (and anything older) -- roughly a month of daily tabs stays around
// at any given time, oldest ones dropping off as new days are added.
function cleanupOldSheets_(referenceDateStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var refDate = parseDate_(referenceDateStr);
  if (!refDate) return;
  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (!DATE_SHEET_RE.test(name)) return; // leave non-date tabs alone
    var sheetDate = parseDate_(name);
    if (!sheetDate) return;
    var ageDays = Math.round((refDate - sheetDate) / (24 * 60 * 60 * 1000));
    if (ageDays >= RETENTION_DAYS) {
      ss.deleteSheet(sheet);
    }
  });
}

function parseDate_(s) {
  if (!DATE_SHEET_RE.test(s)) return null;
  var parts = s.split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// ---------- store master list sync (called only by the local python script) ----------
// Full-refresh: fully overwrites the two tabs each run, never appended -- safe to
// re-run any time, never builds up duplicates or stale rows. Not behind the
// ID-token check (it's a script running on your machine, not a person signing
// in) -- gated by requireSyncSecret_ instead, checked in doPost before this
// is ever called.

function syncStores_(stores) {
  var byType = {};
  stores.forEach(function (s) {
    var t = s.type || "Other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(s);
  });
  var total = 0;
  Object.keys(byType).forEach(function (type) {
    var sheetName = type === "7-11" ? "7-Eleven Stores"
      : type === "RTR" ? "RTR Stores"
      : type + " Stores";
    writeStoreSheet_(sheetName, byType[type]);
    total += byType[type].length;
  });
  return total;
}

function writeStoreSheet_(sheetName, stores) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.clearContents();
  var rows = [STORE_HEADER];
  stores.forEach(function (s) {
    rows.push([
      s.code || "", s.type || "", s.name || "", s.person || "", s.cm || "",
      s.status || "", s.district || "", s.subdistrict || "", s.address || "",
      s.lat != null ? s.lat : "", s.lng != null ? s.lng : "",
    ]);
  });
  var range = sheet.getRange(1, 1, rows.length, STORE_HEADER.length);
  // Set BEFORE writing, not after: Sheets "helpfully" auto-detects values like
  // "7-11" as a date (July 11) and silently stores a date instead of the literal
  // string, unless the cell is already plain-text formatted at write time. This
  // is what corrupted every 7-11 store's type -- setNumberFormat AFTER the fact
  // wouldn't have un-corrupted already-written cells, only prevents it going
  // forward, hence the full-refresh re-run being required.
  range.setNumberFormat("@");
  range.setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, STORE_HEADER.length);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
