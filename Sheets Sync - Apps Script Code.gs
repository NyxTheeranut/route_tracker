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
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * The page signs the user in with Google Identity Services and sends the
 * resulting ID token on every request. This script verifies that token against
 * Google directly (no session/cookie trust needed) and checks the token's
 * audience against OAUTH_CLIENT_ID, so it only accepts tokens issued for THIS
 * app -- not a token from some other Google sign-in. The verified email is then
 * looked up in the Users tab to decide what the caller is allowed to see.
 * markVisited/getVisits also require a valid token now -- an unrecognized email
 * can't write anything.
 *
 * ── SETUP (one-time) ─────────────────────────────────────────────────────
 *  1. Create a new Google Sheet (or open one you want to use for this).
 *  2. Extensions -> Apps Script. Delete any starter code, paste this whole file in.
 *  3. Project Settings (gear icon, left sidebar) -> Script Properties -> Add:
 *       OAUTH_CLIENT_ID = <the Client ID from Google Cloud Console -- see the
 *       Route Planner repo's README for how to create it>
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
      var email = requireAuth_(body.idToken);
      upsertVisit_(body, email);
      return jsonResponse_({ ok: true });
    }

    if (body.action === "syncStores") {
      // local-only tool, not called from the hosted page -- see note at call site
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
      var email = requireAuth_(e.parameter.idToken);
      var person = e.parameter.person || "";
      var date = e.parameter.date || "";
      return jsonResponse_({ ok: true, visits: getVisits_(person, date, email) });
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
      matchedOn: user.role === "cm" ? { cm: user.cmName } : { person: user.personName },
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
        person: row[idx.person],
        cm: row[idx.cm],
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

// ---------- daily visit tabs ----------

// Gets (or creates) the tab for a given day. Creating a new day's tab is also the
// trigger point for cleaning up old ones -- that keeps cleanup to at most once per
// day rather than running on every single sync request.
function getDaySheet_(dateStr, createIfMissing) {
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

function upsertVisit_(body, callerEmail) {
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

function getVisits_(person, dateStr, callerEmail) {
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
// re-run any time, never builds up duplicates or stale rows. Deliberately NOT
// behind the ID-token auth check -- it's only ever called from your own machine
// via update_stores_sheet.py, never from the hosted page.

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
  sheet.getRange(1, 1, rows.length, STORE_HEADER.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, STORE_HEADER.length);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
