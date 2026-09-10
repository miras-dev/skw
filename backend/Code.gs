/**
 * CWL Roster Manager v3 — Google Apps Script backend.
 *
 * Companion file: roster-scoring.gs (vendored scoring — LeagueTiers / BattleLog /
 * Eligibility). Both files must be in the same Apps Script project.
 *
 * Google Sheet tabs:
 *   <one per clan>  — that clan's 15 main + 4 subs, human-readable (auto-rebuilt)
 *   Not Selected    — every unselected player from every clan (auto-rebuilt)
 *   History         — append-only audit log
 *   Accounts        — username / salted-SHA-256 password hash / who created it
 *   _Roster         — INTERNAL flat source of truth. One row per player. Do not
 *                     edit by hand — the per-clan tabs are generated from it and
 *                     any hand edits here are overwritten on the next action.
 *
 * v3 change vs v2: the app's source of truth is still one flat sheet (renamed
 * _Roster), but after every mutation rebuildViews_() regenerates one tab per
 * clan plus a "Not Selected" tab. Clan tabs are created/renamed automatically as
 * clans are added. Read the flat sheet, look at the pretty tabs.
 *
 * The site (cwl-roster.html) talks to this over HTTP:
 *   GET  ?action=state                              → { ok, rows, clans, history, me }
 *   POST { action:"login", user, pass }             → { ok, token, user }
 *   POST { action:"addAccount", token, user, pass } → { ok }              (any logged-in user)
 *   POST { action:"addClan", token, key, name, tag }→ { ok, ...state }
 *   POST { action:"importClan", token, key }        → { ok, ...state, importReport }
 *   POST { action:"move",  token, tag, clan, slot } → { ok, ...state }
 *   POST { action:"reorder", token, tag, position } → { ok, ...state }
 *   POST { action:"toggleSlot", token, tag }        → { ok, ...state }
 *   POST { action:"note",  token, tag, note }       → { ok, ...state }
 *
 * Auth: accounts live in the Accounts tab; passwords are SHA-256(salt + pass),
 * salt per row. The login token is base64(user|SALT|issuedDay) — enough to name
 * the actor in the audit log. Anyone with the deployment URL can reach the API;
 * this is light gatekeeping, not real security.
 *
 * ── SETUP ────────────────────────────────────────────────────────────────────
 *  1. Create a blank Google Sheet.
 *  2. Extensions → Apps Script. Delete the sample.
 *  3. File → + → Script → name it `roster-scoring` → paste roster-scoring.gs.
 *  4. Back in Code.gs → paste this whole file. Save.
 *  5. Run  seed()  once (function dropdown → seed → Run → grant permissions).
 *     Creates the three tabs; seeds Accounts with Ben / admin and the five clans.
 *  6. Deploy → New deployment → Web app.
 *       Execute as: Me     Who has access: Anyone
 *     Deploy, copy the /exec URL.
 *  7. Open the site, paste that URL into the backend-URL box once. Done.
 *
 *  Change/add logins from the site (any user can add an admin), or edit the
 *  Accounts tab by hand (put a plaintext password in a new row's `password`
 *  column and leave hash/salt blank — seed()/normaliseAccounts() will hash it;
 *  or just use the site).
 * ─────────────────────────────────────────────────────────────────────────────
 */

var SALT = "cwl-roster-v2";  // unchanged — keeps existing login tokens valid
var CLASHCWL_API = "https://api.clashcwl.com/api";  // server-to-server: no CORS

// _Roster is the internal flat source of truth. "Not Selected" and the per-clan
// tabs are generated views. History / Accounts unchanged.
var SHEET = { roster: "_Roster", notSelected: "Not Selected", history: "History", accounts: "Accounts" };

// Legacy tab name from v1/v2 — seed()/rosterSheet_() migrate it to _Roster.
var LEGACY_ROSTER_TAB = "Roster";

var ROSTER_HEADERS = [
  "tag", "name", "clan", "slot", "position",
  "th", "heroSum", "rankedScore", "league", "signal", "note",
  "updatedBy", "updatedAt",
];
var HISTORY_HEADERS = ["timestamp", "user", "action", "player", "detail"];
var ACCOUNT_HEADERS = ["username", "hash", "salt", "createdBy", "createdAt", "password"];

// Columns of each generated per-clan tab (the order the user asked for).
var PLAYER_HEADERS = [
  "Slot", "#", "Name", "Tag", "TH", "Ranked League", "HeroSum",
  "Score", "Signal", "Note", "UpdatedBy", "UpdatedAt",
];
// "Not Selected" tab: same, with a leading Clan column.
var NOTSEL_HEADERS = ["Clan"].concat(PLAYER_HEADERS);

var MAIN_CAP = 15, SUB_CAP = 4, IMPORT_MAIN = 15, IMPORT_SUB = 4;

// Seed family. `key` is the stable id used everywhere; `name` is the label.
var SEED_CLANS = [
  { key: "sumkindofwonder", name: "Sumkindofwonder", tag: "#2L92V9CYP" },
  { key: "black-and-white", name: "Black & White",   tag: "#2GYCLYJRV" },
  { key: "sumkindofbeauty", name: "SumKindOfBeauty",  tag: "#2R0CPQCGV" },
  { key: "turri",           name: "Turri",            tag: "#2G9Q89JPV" },
  { key: "rocking-warrior", name: "Rocking Warrior",  tag: "#Q0RVR822"  },
];

/* ============================ HTTP ============================ */
/*
 * Everything goes through doGet. Apps Script POST issues a 302 redirect to
 * script.googleusercontent.com; on some Google accounts that redirect carries a
 * stale "lib=" param and 405s, breaking every write. GET has no redirect, so the
 * site sends all actions as GET query params instead. Payloads are tiny JSON
 * (login, a tag + clan, a note ≤400 chars) and fit a URL comfortably.
 *
 * doPost is kept as a thin alias so a POST still works where it happens to.
 */

function doGet(e) {
  try {
    return json_(route_((e && e.parameter) || {}));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.stack || err) });
  }
}

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};
    // also accept a JSON body if one was sent
    if (e && e.postData && e.postData.contents) {
      try {
        var b = JSON.parse(e.postData.contents);
        for (var k in b) if (p[k] === undefined) p[k] = b[k];
      } catch (ignore) {}
    }
    return json_(route_(p));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.stack || err) });
  }
}

/** Single dispatcher for both verbs. `p` is a flat string map of params. */
function route_(p) {
  var action = p.action || "state";

  if (action === "state") {
    return getState_(tokenUser_(p.token));
  }

  if (action === "login") {
    var u = verifyLogin_(p.user, p.pass);
    if (!u) return { ok: false, error: "Wrong username or password" };
    logHistory_(u, "login", "-", "signed in");
    return { ok: true, token: makeToken_(u), user: u };
  }

  var user = tokenUser_(p.token);
  if (!user) return { ok: false, error: "Not logged in — please sign in again" };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    switch (action) {
      case "addAccount": return doAddAccount_(user, p);
      case "addClan":    return doAddClan_(user, p);
      case "importClan": return doImportClan_(user, p);
      case "move":       return doMove_(user, p);
      case "reorder":    return doReorder_(user, p);
      case "toggleSlot": return doToggleSlot_(user, p);
      case "note":       return doNote_(user, p);
      default:           return { ok: false, error: "unknown action: " + action };
    }
  } finally { lock.releaseLock(); }
}

/* ============================ accounts / auth ============================ */

function sha256_(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return b.map(function (x) { return ("0" + (x & 0xff).toString(16)).slice(-2); }).join("");
}
function randSalt_() {
  return Utilities.getUuid().replace(/-/g, "").slice(0, 16);
}

function accountsSheet_() {
  var sh = ss_().getSheetByName(SHEET.accounts);
  if (!sh) { sh = ss_().insertSheet(SHEET.accounts); sh.appendRow(ACCOUNT_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

/** Read accounts, hashing any row that has a plaintext `password` and no hash. */
function readAccounts_() {
  var sh = accountsSheet_();
  var v = sh.getDataRange().getValues();
  var head = v[0].map(String);
  var col = {}; ACCOUNT_HEADERS.forEach(function (h) { col[h] = head.indexOf(h); });
  var out = [];
  for (var i = 1; i < v.length; i++) {
    var row = v[i];
    var username = String(row[col.username] || "").trim();
    if (!username) continue;
    var hash = String(row[col.hash] || "").trim();
    var salt = String(row[col.salt] || "").trim();
    var plain = String(row[col.password] || "").trim();
    if (!hash && plain) {
      salt = randSalt_();
      hash = sha256_(salt + plain);
      sh.getRange(i + 1, col.hash + 1).setValue(hash);
      sh.getRange(i + 1, col.salt + 1).setValue(salt);
      sh.getRange(i + 1, col.password + 1).setValue("");  // don't keep plaintext
    }
    out.push({ username: username, hash: hash, salt: salt, row: i + 1 });
  }
  return out;
}

function verifyLogin_(user, pass) {
  user = String(user || "").trim();
  if (!user) return null;
  var accs = readAccounts_();
  for (var i = 0; i < accs.length; i++) {
    if (accs[i].username.toLowerCase() === user.toLowerCase() && accs[i].hash
        && accs[i].hash === sha256_(accs[i].salt + String(pass || ""))) {
      return accs[i].username;
    }
  }
  return null;
}

function doAddAccount_(actor, b) {
  var user = String(b.user || "").trim();
  var pass = String(b.pass || "");
  if (!user || !pass) return { ok: false, error: "username and password required" };
  if (user.length > 40) return { ok: false, error: "username too long" };
  var accs = readAccounts_();
  for (var i = 0; i < accs.length; i++) {
    if (accs[i].username.toLowerCase() === user.toLowerCase()) {
      return { ok: false, error: "that username already exists" };
    }
  }
  var salt = randSalt_();
  accountsSheet_().appendRow([user, sha256_(salt + pass), salt, actor, new Date(), ""]);
  logHistory_(actor, "addAccount", user, "new admin account created");
  rebuildViews_();
  var st = getState_(actor); st.ok = true; return st;
}

function makeToken_(user) {
  var day = Math.floor(Date.now() / 86400000);  // token naturally ages out after ~1 day
  return Utilities.base64EncodeWebSafe(user + "|" + SALT + "|" + day);
}
function tokenUser_(token) {
  if (!token) return null;
  try {
    var s = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    var p = s.split("|");
    if (p.length !== 3 || p[1] !== SALT) return null;
    var day = Math.floor(Date.now() / 86400000);
    if (Math.abs(day - Number(p[2])) > 2) return null;   // stale token
    var accs = readAccounts_();
    for (var i = 0; i < accs.length; i++) if (accs[i].username === p[0]) return p[0];
  } catch (e) {}
  return null;
}

/* ============================ clans ============================ */

// Clans are discovered from the Roster tab (every distinct clan key) plus a
// registry row per clan carrying its name + source tag, kept in the special
// player row  tag = "@clan/<key>"  so no extra sheet is needed.
function clanRegistry_() {
  var rows = readRoster_();
  var reg = {};
  rows.forEach(function (r) {
    var m = /^@clan\/(.+)$/.exec(r.tag);
    if (m) reg[m[1]] = {
      key: m[1],
      name: r.name,
      tag: r.league,      // source #tag stashed in the league column
      tabName: r.note,     // last generated tab name stashed in the note column
    };
  });
  return reg;
}

function registerClan_(sh, key, name, tag) {
  var row = blankRosterRow_();
  row.tag = "@clan/" + key;
  row.name = name;
  row.clan = "_registry";
  row.slot = "_meta";
  row.league = tag;                 // reuse the column to stash the source tag
  row.updatedAt = new Date();
  sh.appendRow(ROSTER_HEADERS.map(function (h) { return row[h]; }));
}

function doAddClan_(actor, b) {
  var key = String(b.key || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  var name = String(b.name || "").trim();
  var tag = normTag_(b.tag);
  if (!key || !name) return { ok: false, error: "name required" };
  if (tag === "#") return { ok: false, error: "clan tag required" };
  var reg = clanRegistry_();
  if (reg[key]) return { ok: false, error: "a clan with that id already exists" };
  registerClan_(rosterSheet_(), key, name, tag);
  logHistory_(actor, "addClan", name, key + "  " + tag);
  rebuildViews_();
  var st = getState_(actor); st.ok = true; return st;
}

/* ============================ ClashCWL import ============================ */

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error("ClashCWL API " + code + " for " + url + " :: " + text.slice(0, 200));
  return JSON.parse(text);
}

/**
 * Full replace of one clan's roster from the ClashCWL "who should play" ranking.
 *
 * Same data path as the ClashCWL site: GET /clan-deep + /clan-battlelogs, then
 * the SHARED Eligibility.rankClan() (roster-scoring.gs). Positions 1-15 → main,
 * 16-19 → subs, 20+ → this clan's not-selected pool. Every prior placement for
 * this clan (manual or imported) is wiped first.
 */
function doImportClan_(actor, b) {
  var key = String(b.key || "").trim();
  var reg = clanRegistry_();
  var clan = reg[key];
  if (!clan) return { ok: false, error: "unknown clan: " + key };
  var tag = String(clan.tag || "").replace(/^#/, "");
  if (!tag) return { ok: false, error: "clan has no source tag — re-add it with a #tag" };

  var deep = fetchJson_(CLASHCWL_API + "/clan-deep?tag=" + encodeURIComponent(tag));
  var logs = fetchJson_(CLASHCWL_API + "/clan-battlelogs?tag=" + encodeURIComponent(tag));

  var players = deep.players || [];
  var members = logs.members || [];
  var ranked = Eligibility.rankClan(players, members, { warSize: IMPORT_MAIN });
  var ordered = ranked.members;   // already sorted best-first by the shared model

  // Build the new rows for this clan.
  var stamp = fmtDate_(new Date());
  var sh = rosterSheet_();
  var all = readRoster_();

  // Drop every existing player row for this clan (keep the @clan/ registry row).
  var keepValues = [ROSTER_HEADERS];
  all.forEach(function (r) {
    if (r.clan === key) return;                 // wiped
    if (r.tag === "@clan/" + key) { keepValues.push(ROSTER_HEADERS.map(function (h) { return r[h]; })); return; }
    keepValues.push(ROSTER_HEADERS.map(function (h) { return r[h]; }));
  });

  var mainN = 0, subN = 0, poolN = 0;
  ordered.forEach(function (m, i) {
    var row = blankRosterRow_();
    row.tag = m.tag;
    row.name = m.name;
    row.clan = key;
    row.th = m.thLevel || "";
    row.heroSum = m.heroSum || "";
    row.rankedScore = (m.score == null ? "" : m.score);
    row.league = m.leagueTier || "";
    row.updatedBy = actor;
    row.updatedAt = new Date();
    if (i < IMPORT_MAIN) {
      row.slot = "main"; row.position = ++mainN; row.signal = "clashcwl";
      row.note = "Selected from ClashCWL API · " + stamp;
    } else if (i < IMPORT_MAIN + IMPORT_SUB) {
      row.slot = "sub"; row.position = ++subN; row.signal = "clashcwl";
      row.note = "Substitute from ClashCWL API · " + stamp;
    } else {
      row.slot = "pool"; row.position = ++poolN; row.signal = "clashcwl";
      row.note = "Not selected by ClashCWL import · " + stamp;
    }
    keepValues.push(ROSTER_HEADERS.map(function (h) { return row[h]; }));
  });

  // Rewrite the sheet in one shot.
  sh.clearContents();
  sh.getRange(1, 1, keepValues.length, ROSTER_HEADERS.length).setValues(keepValues);
  sh.setFrozenRows(1);

  var report = {
    clan: clan.name, ranked: ordered.length,
    main: mainN, sub: subN, pool: poolN,
    missingLogs: ranked.missingLogs || 0,
    unrated: ranked.unrated || 0,
    truncated: !!logs.truncated,
  };
  logHistory_(actor, "importClan", clan.name,
    "replaced roster from ClashCWL — " + mainN + " main, " + subN + " subs, " + poolN + " not selected"
    + (report.truncated ? " (battle logs truncated — partial ranking)" : "")
    + (report.missingLogs ? " · " + report.missingLogs + " without readable logs" : ""));

  rebuildViews_();
  var st = getState_(actor);
  st.ok = true;
  st.importReport = report;
  return st;
}

/* ============================ player actions ============================ */

function doMove_(actor, b) {
  var sh = rosterSheet_();
  var r = findRow_(sh, b.tag);
  if (!r) return { ok: false, error: "player not found: " + b.tag };
  var reg = clanRegistry_();
  var toClan = String(b.clan || "").trim();
  if (toClan !== "unassigned" && !reg[toClan]) return { ok: false, error: "unknown clan: " + toClan };
  var toSlot = toClan === "unassigned" ? "pool" : (b.slot === "sub" ? "sub" : "main");

  var fromClan = r.data.clan, fromSlot = r.data.slot;
  var destPos = listOf_(sh, toClan, toSlot).length + 1;
  var label = toClan === "unassigned" ? "Not-Selected" : (reg[toClan].name + "/" + toSlot);

  setCells_(sh, r.rowIndex, {
    clan: toClan, slot: toSlot, position: destPos,
    signal: "manual",
    note: "Moved to " + label + " by @" + actor + " · " + fmtDate_(new Date()),
    updatedBy: actor, updatedAt: new Date(),
  });
  renumber_(sh, fromClan, fromSlot);
  renumber_(sh, toClan, toSlot);

  logHistory_(actor, "move", r.data.name,
    clanLabel_(reg, fromClan) + "/" + fromSlot + "  →  " + label);
  rebuildViews_();
  var st = getState_(actor); st.ok = true; return st;
}

function doToggleSlot_(actor, b) {
  var sh = rosterSheet_();
  var r = findRow_(sh, b.tag);
  if (!r) return { ok: false, error: "player not found" };
  if (r.data.clan === "unassigned" || r.data.clan === "_registry")
    return { ok: false, error: "not a clan roster player" };
  var next = r.data.slot === "main" ? "sub" : "main";
  var fromSlot = r.data.slot;
  setCells_(sh, r.rowIndex, {
    slot: next, position: listOf_(sh, r.data.clan, next).length + 1,
    updatedBy: actor, updatedAt: new Date(),
  });
  renumber_(sh, r.data.clan, fromSlot);
  renumber_(sh, r.data.clan, next);
  var reg = clanRegistry_();
  logHistory_(actor, "toggleSlot", r.data.name, clanLabel_(reg, r.data.clan) + ": " + fromSlot + " → " + next);
  rebuildViews_();
  var st = getState_(actor); st.ok = true; return st;
}

function doReorder_(actor, b) {
  var sh = rosterSheet_();
  var r = findRow_(sh, b.tag);
  if (!r) return { ok: false, error: "player not found" };
  var target = Math.max(1, parseInt(b.position, 10) || 1);
  var list = listOf_(sh, r.data.clan, r.data.slot)
    .filter(function (x) { return x.data.tag !== r.data.tag; })
    .sort(function (a, c) { return a.data.position - c.data.position; });
  list.splice(Math.min(target - 1, list.length), 0, r);
  list.forEach(function (x, i) { setCells_(sh, x.rowIndex, { position: i + 1 }); });
  setCells_(sh, r.rowIndex, { updatedBy: actor, updatedAt: new Date() });
  var reg = clanRegistry_();
  logHistory_(actor, "reorder", r.data.name, clanLabel_(reg, r.data.clan) + "/" + r.data.slot + " → #" + target);
  rebuildViews_();
  var st = getState_(actor); st.ok = true; return st;
}

function doNote_(actor, b) {
  var sh = rosterSheet_();
  var r = findRow_(sh, b.tag);
  if (!r) return { ok: false, error: "player not found" };
  var note = String(b.note == null ? "" : b.note).slice(0, 400);
  setCells_(sh, r.rowIndex, { note: note, updatedBy: actor, updatedAt: new Date() });
  logHistory_(actor, "note", r.data.name, note ? ('"' + note + '"') : "(cleared)");
  rebuildViews_();
  var st = getState_(actor); st.ok = true; return st;
}

/* ============================ state read ============================ */

function getState_(me) {
  var rows = readRoster_().filter(function (r) { return r.clan !== "_registry"; });
  rows.forEach(function (r) {
    r.position = Number(r.position) || 0;
    // League badge URL, from the shared LeagueTiers table (roster-scoring.gs).
    r.leagueIcon = r.league ? (LeagueTiers.iconOf(r.league, "small") || "") : "";
    r.leagueRank = r.league ? LeagueTiers.rankOf(r.league) : null;
  });

  var reg = clanRegistry_();
  var clans = SEED_ORDER_().filter(function (k) { return reg[k]; })
    .concat(Object.keys(reg).filter(function (k) { return SEED_ORDER_().indexOf(k) === -1; }))
    .map(function (k) { return { key: k, name: reg[k].name, tag: reg[k].tag }; });

  var hsh = historySheet_();
  var hv = hsh.getDataRange().getValues();
  var history = [];
  for (var j = Math.max(1, hv.length - 200); j < hv.length; j++) {
    history.push({ timestamp: hv[j][0], user: hv[j][1], action: hv[j][2], player: hv[j][3], detail: hv[j][4] });
  }
  history.reverse();

  return {
    ok: true, me: me || null, rows: rows, clans: clans, history: history,
    caps: { main: MAIN_CAP, sub: SUB_CAP },
    serverTime: new Date().toISOString(),
  };
}

function SEED_ORDER_() { return SEED_CLANS.map(function (c) { return c.key; }); }

/* ============================ sheet plumbing ============================ */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function rosterSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET.roster);
  if (sh) return sh;
  // Migrate a v1/v2 "Roster" tab to "_Roster" in place, keeping its data.
  var legacy = ss.getSheetByName(LEGACY_ROSTER_TAB);
  if (legacy) { legacy.setName(SHEET.roster); return legacy; }
  throw new Error('No "' + SHEET.roster + '" tab — run seed() first.');
}
function historySheet_() {
  var sh = ss_().getSheetByName(SHEET.history);
  if (!sh) { sh = ss_().insertSheet(SHEET.history); sh.appendRow(HISTORY_HEADERS); sh.setFrozenRows(1); }
  return sh;
}

function blankRosterRow_() {
  var o = {}; ROSTER_HEADERS.forEach(function (h) { o[h] = ""; }); return o;
}

function readRoster_() {
  var sh = rosterSheet_();
  var v = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    var o = {};
    for (var c = 0; c < ROSTER_HEADERS.length; c++) o[ROSTER_HEADERS[c]] = v[i][c];
    out.push(o);
  }
  return out;
}

function findRow_(sh, tag) {
  tag = normTag_(tag);
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (normTag_(v[i][0]) === tag) {
      var o = {};
      for (var c = 0; c < ROSTER_HEADERS.length; c++) o[ROSTER_HEADERS[c]] = v[i][c];
      o.position = Number(o.position) || 0;
      return { rowIndex: i + 1, data: o };
    }
  }
  return null;
}

function listOf_(sh, clan, slot) {
  var v = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (v[i][2] === clan && v[i][3] === slot) {
      var o = {};
      for (var c = 0; c < ROSTER_HEADERS.length; c++) o[ROSTER_HEADERS[c]] = v[i][c];
      o.position = Number(o.position) || 0;
      out.push({ rowIndex: i + 1, data: o });
    }
  }
  return out;
}

function renumber_(sh, clan, slot) {
  if (!clan) return;
  var list = listOf_(sh, clan, slot).sort(function (a, b) { return a.data.position - b.data.position; });
  list.forEach(function (x, i) {
    if (x.data.position !== i + 1) setCells_(sh, x.rowIndex, { position: i + 1 });
  });
}

function setCells_(sh, rowIndex, patch) {
  for (var k in patch) {
    var col = ROSTER_HEADERS.indexOf(k);
    if (col !== -1) sh.getRange(rowIndex, col + 1).setValue(patch[k]);
  }
}

function logHistory_(user, action, player, detail) {
  historySheet_().appendRow([new Date(), user, action, player, detail]);
}

/* ============================ generated views ============================ */

/**
 * Rebuild one tab per clan (15 main + 4 subs, the columns the user asked for)
 * plus a single "Not Selected" tab. Called after every mutating action, and by
 * seed(). The flat _Roster sheet is the source of truth; these are read-only
 * renders — hand edits here do not feed back.
 *
 * Idempotent and self-healing: it creates missing tabs, renames a clan's tab
 * when the clan is renamed, and deletes clan tabs whose clan no longer exists.
 * It never touches _Roster, Not Selected wording aside, History or Accounts.
 */
function rebuildViews_() {
  var ss = ss_();
  var reg = clanRegistry_();
  var rows = readRoster_().filter(function (r) { return r.clan !== "_registry"; });

  // group players by clan/slot
  var byClan = {};   // key -> { main:[], sub:[], pool:[] }
  rows.forEach(function (r) {
    if (r.clan === "unassigned") return;
    if (!reg[r.clan]) return;                         // orphan — ignore
    var g = byClan[r.clan] || (byClan[r.clan] = { main: [], sub: [], pool: [] });
    (g[r.slot] || g.pool).push(r);
  });

  var sortPos = function (a, b) { return (Number(a.position) || 0) - (Number(b.position) || 0); };
  var protectedTabs = {};
  protectedTabs[SHEET.roster] = 1;
  protectedTabs[SHEET.notSelected] = 1;
  protectedTabs[SHEET.history] = 1;
  protectedTabs[SHEET.accounts] = 1;

  // ---- per-clan tabs ----
  // Registry may carry a `tabName` we last used, so a rename finds the old tab.
  var order = getState_(null).clans.map(function (c) { return c.key; });

  order.forEach(function (key, idx) {
    var meta = reg[key];
    if (!meta) return;
    var wantName = safeTabName_(meta.name, key);
    var sh = ss.getSheetByName(wantName)
          || (meta.tabName ? ss.getSheetByName(meta.tabName) : null);
    if (!sh) {
      sh = ss.insertSheet(wantName);
    } else if (sh.getName() !== wantName) {
      // clan was renamed — move the tab with it, unless the target name is taken
      if (!ss.getSheetByName(wantName)) sh.setName(wantName);
    }
    // remember the name we used so a future rename can find it
    if (meta.tabName !== sh.getName()) writeClanTabName_(key, sh.getName());
    protectedTabs[sh.getName()] = 1;

    var g = byClan[key] || { main: [], sub: [], pool: [] };
    var main = g.main.slice().sort(sortPos);
    var sub = g.sub.slice().sort(sortPos);

    var out = [];
    out.push(["Clan", meta.name, "Tag", meta.tag || "", "", "", "", "", "", "", "", ""]);
    out.push(["Rebuilt", fmtDate_(new Date()), "", "", "", "", "", "", "", "", "", ""]);
    out.push([]);
    out.push(PLAYER_HEADERS);
    main.forEach(function (r, i) { out.push(playerRow_("MAIN", i + 1, r)); });
    for (var m = main.length; m < 15; m++) out.push(["MAIN", m + 1, "—", "", "", "", "", "", "", "", "", ""]);
    out.push([]);
    out.push(PLAYER_HEADERS);
    sub.forEach(function (r, i) { out.push(playerRow_("SUB", i + 1, r)); });
    for (var s = sub.length; s < 4; s++) out.push(["SUB", s + 1, "—", "", "", "", "", "", "", "", "", ""]);

    writeGrid_(sh, out, PLAYER_HEADERS.length);
    sh.setFrozenRows(4);
  });

  // ---- Not Selected tab ----
  var ns = ss.getSheetByName(SHEET.notSelected) || ss.insertSheet(SHEET.notSelected);
  var nsRows = [NOTSEL_HEADERS];
  // players explicitly unassigned
  rows.filter(function (r) { return r.clan === "unassigned"; })
    .forEach(function (r) { nsRows.push(["(unassigned)"].concat(playerRow_("POOL", nsRows.length, r))); });
  // plus each clan's own not-selected pool (ranked 20+ from an import, or moved there)
  order.forEach(function (key) {
    var meta = reg[key]; if (!meta) return;
    var g = byClan[key]; if (!g) return;
    g.pool.slice().sort(sortPos).forEach(function (r, i) {
      nsRows.push([meta.name].concat(playerRow_("POOL", i + 1, r)));
    });
  });
  if (nsRows.length === 1) nsRows.push(["—", "", "", "", "", "", "", "", "", "", "", "", ""]);
  writeGrid_(ns, nsRows, NOTSEL_HEADERS.length);
  ns.setFrozenRows(1);

  // ---- delete stale clan tabs (a removed clan) ----
  ss.getSheets().forEach(function (sh) {
    var nm = sh.getName();
    if (protectedTabs[nm]) return;
    if (nm.charAt(0) === "_") return;                 // leave user's own _-prefixed tabs alone
    // Only delete tabs that look like ours: first cell A1 === "Clan"
    var a1 = sh.getRange(1, 1).getValue();
    if (a1 === "Clan" && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

function playerRow_(slotLabel, num, r) {
  return [
    slotLabel, num,
    r.name || "", r.tag || "",
    r.th || "", r.league || "", r.heroSum || "",
    (r.rankedScore === "" || r.rankedScore == null) ? "" : r.rankedScore,
    r.signal || "", r.note || "",
    r.updatedBy || "", r.updatedAt ? fmtDate_(new Date(r.updatedAt)) : "",
  ];
}

/** Overwrite a sheet with a 2-D array, padding ragged rows, clearing leftovers. */
function writeGrid_(sh, grid, width) {
  sh.clearContents();
  var norm = grid.map(function (row) {
    var out = row.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  });
  if (norm.length) sh.getRange(1, 1, norm.length, width).setValues(norm);
}

/** Sheet-name-safe: <=100 chars, no  : \ / ? * [ ]  and not clashing with ours. */
function safeTabName_(name, key) {
  var n = String(name || key || "Clan").replace(/[:\\\/\?\*\[\]]/g, " ").trim().slice(0, 90);
  if (!n) n = key || "Clan";
  var reserved = {};
  reserved[SHEET.roster] = 1; reserved[SHEET.notSelected] = 1;
  reserved[SHEET.history] = 1; reserved[SHEET.accounts] = 1;
  if (reserved[n]) n = n + " (clan)";
  return n;
}

/* We stash the tab name we last used for a clan in the registry row's `note`
   column (the @clan/<key> row), so a later rename can locate the old tab. */
function writeClanTabName_(key, tabName) {
  var sh = rosterSheet_();
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][0]) === "@clan/" + key) {
      sh.getRange(i + 1, ROSTER_HEADERS.indexOf("note") + 1).setValue(tabName);
      return;
    }
  }
}

/* ============================ misc ============================ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function normTag_(t) {
  return "#" + String(t == null ? "" : t).replace(/^#/, "").toUpperCase().trim();
}
function clanLabel_(reg, key) {
  if (key === "unassigned") return "Not-Selected";
  return (reg[key] && reg[key].name) || key;
}
function fmtDate_(d) {
  return Utilities.formatDate(d, ss_().getSpreadsheetTimeZone() || "UTC", "d MMM yyyy HH:mm");
}

/* ============================ one-time seed ============================ */

/**
 * Fresh install / full reset. Creates:
 *   _Roster    — flat source of truth, five family clans registered, no players
 *   History    — one seed row
 *   Accounts   — Ben / admin (hashed)
 * then rebuildViews_() lays out the empty per-clan tabs + "Not Selected".
 * Safe to re-run — it wipes everything back to this state.
 */
function seed() {
  var ss = ss_();

  var legacy = ss.getSheetByName(LEGACY_ROSTER_TAB);
  var sh = ss.getSheetByName(SHEET.roster) || legacy || ss.insertSheet(SHEET.roster);
  if (sh.getName() !== SHEET.roster) sh.setName(SHEET.roster);
  sh.clear();
  sh.appendRow(ROSTER_HEADERS);
  sh.setFrozenRows(1);
  SEED_CLANS.forEach(function (c) { registerClan_(sh, c.key, c.name, c.tag); });

  var hsh = ss.getSheetByName(SHEET.history) || ss.insertSheet(SHEET.history);
  hsh.clear();
  hsh.appendRow(HISTORY_HEADERS);
  hsh.setFrozenRows(1);
  hsh.appendRow([new Date(), "system", "seed", "-", SEED_CLANS.length + " clans registered; rosters empty"]);

  var ash = ss.getSheetByName(SHEET.accounts) || ss.insertSheet(SHEET.accounts);
  ash.clear();
  ash.appendRow(ACCOUNT_HEADERS);
  ash.setFrozenRows(1);
  [["Ben", "skwben"], ["admin", "admin"]].forEach(function (p) {
    var salt = randSalt_();
    ash.appendRow([p[0], sha256_(salt + p[1]), salt, "system", new Date(), ""]);
  });

  rebuildViews_();
  SpreadsheetApp.flush();
}

/**
 * v2 → v3 migration WITHOUT losing data. Run this ONCE instead of seed() if you
 * already have rosters in the old "Roster" tab you want to keep:
 *   • renames "Roster" → "_Roster"
 *   • builds the per-clan + "Not Selected" tabs from it
 * Leaves History and Accounts untouched.
 */
function migrateV2toV3() {
  var ss = ss_();
  var legacy = ss.getSheetByName(LEGACY_ROSTER_TAB);
  if (legacy && !ss.getSheetByName(SHEET.roster)) legacy.setName(SHEET.roster);
  rosterSheet_();                 // throws if neither tab exists
  rebuildViews_();
  logHistory_("system", "migrate", "-", "v2 → v3: generated per-clan tabs");
  SpreadsheetApp.flush();
}

/** Optional: quick check that roster-scoring.gs is loaded and callable. */
function selfTest() {
  var ok = typeof Eligibility === "object" && typeof Eligibility.rankClan === "function"
        && typeof LeagueTiers === "object" && LeagueTiers.rankOf("Legend I") === 36
        && typeof BattleLog === "object" && typeof BattleLog.summariseRanked === "function";
  Logger.log(ok ? "roster-scoring.gs OK" : "roster-scoring.gs NOT loaded");
  return ok;
}

/* ============================ diagnostics ============================ */

/**
 * DIAGNOSE — run this from the Apps Script editor (function dropdown → Run),
 * then open View → Logs (or Executions) and copy everything it printed.
 *
 * It checks, in order:
 *   1. roster-scoring.gs is loaded (Eligibility / BattleLog / LeagueTiers)
 *   2. all the v3 functions the site's POST path calls actually exist
 *   3. the required sheet tabs exist and have the right headers
 *   4. a real doPost({action:"login"}) round-trip returns JSON, not an error
 *   5. a dry read of getState_ succeeds
 *
 * Nothing here writes to the sheet or the audit log — safe to run any time.
 */
function DIAGNOSE() {
  var L = [];
  var log = function (s) { L.push(s); Logger.log(s); };
  var ok = true;
  var fail = function (s) { ok = false; log("  ✗ " + s); };
  var pass = function (s) { log("  ✓ " + s); };

  log("===== CWL Roster Manager — backend diagnosis =====");
  log("time: " + new Date().toISOString());

  // ---- 1. scoring bundle ----
  log("\n[1] roster-scoring.gs");
  try {
    if (typeof Eligibility !== "object") fail("Eligibility is not defined — roster-scoring.gs is NOT in this project. Add it: Files ➕ → Script → name it 'roster-scoring' → paste the file → Save.");
    else if (typeof Eligibility.rankClan !== "function") fail("Eligibility.rankClan missing — roster-scoring.gs is truncated. Re-paste the whole file.");
    else pass("Eligibility.rankClan present");

    if (typeof BattleLog !== "object" || typeof BattleLog.summariseRanked !== "function") fail("BattleLog.summariseRanked missing from roster-scoring.gs");
    else pass("BattleLog.summariseRanked present");

    if (typeof LeagueTiers !== "object" || LeagueTiers.rankOf("Legend I") !== 36) fail("LeagueTiers broken in roster-scoring.gs (rankOf('Legend I') should be 36)");
    else pass("LeagueTiers.rankOf OK");
  } catch (e) { fail("threw: " + e); }

  // ---- 2. v3 functions the POST path needs ----
  log("\n[2] v3 functions present in Code.gs");
  var need = ["doPost","doGet","doMove_","doImportClan_","doToggleSlot_","doReorder_",
              "doNote_","doAddClan_","doAddAccount_","getState_","rebuildViews_",
              "playerRow_","writeGrid_","safeTabName_","writeClanTabName_","clanRegistry_",
              "readRoster_","rosterSheet_","verifyLogin_","tokenUser_","makeToken_"];
  need.forEach(function (fn) {
    if (typeof this[fn] === "function" || typeof eval("typeof " + fn) === "function") pass(fn + "()");
    else fail(fn + "() is MISSING — your Code.gs paste is incomplete. Re-paste the whole v3 file.");
  }, this);

  // ---- 3. sheet tabs ----
  log("\n[3] sheet tabs");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  log("  tabs found: " + names.join(", "));
  var flat = ss.getSheetByName("_Roster") || ss.getSheetByName("Roster");
  if (!flat) fail('Neither "_Roster" nor "Roster" tab exists — run seed() or migrateV2toV3().');
  else {
    pass('flat source tab: "' + flat.getName() + '"');
    var hdr = flat.getRange(1, 1, 1, ROSTER_HEADERS.length).getValues()[0].join(",");
    if (hdr.indexOf("tag") !== 0) fail('_Roster header row is wrong (got: "' + hdr + '"). Expected to start with "tag,name,clan,...". Re-run seed() or fix the header.');
    else pass("_Roster header row OK");
    var n = Math.max(0, flat.getLastRow() - 1);
    log("  _Roster data rows (incl. @clan registry rows): " + n);
  }
  if (!ss.getSheetByName("Accounts")) fail('"Accounts" tab missing — run seed().');
  else pass("Accounts tab present");
  if (!ss.getSheetByName("History")) fail('"History" tab missing — run seed().');
  else pass("History tab present");

  // ---- 4. real login round-trip through doPost ----
  log("\n[4] doPost({action:'login'}) round-trip");
  try {
    var res = doPost({ postData: { contents: JSON.stringify({ action: "login", user: "admin", pass: "admin" }) } });
    var body = res.getContent();
    if (body.charAt(0) !== "{") fail("doPost returned non-JSON (first char '" + body.charAt(0) + "'). Body starts: " + body.slice(0, 120));
    else {
      var j = JSON.parse(body);
      if (j.ok && j.token) pass("login round-trip OK — got a token");
      else if (!j.ok && /password/i.test(j.error || "")) fail("login says wrong password — the Accounts tab has no valid 'admin' row. Re-run seed(), or add admin from the site.");
      else fail("login returned: " + body.slice(0, 200));
    }
  } catch (e) { fail("doPost threw: " + e + (e.stack ? "\n" + e.stack : "")); }

  // ---- 5. getState_ dry read ----
  log("\n[5] getState_() read");
  try {
    var st = getState_(null);
    if (st && st.ok) pass("getState_ OK — " + (st.rows || []).length + " player rows, " + (st.clans || []).length + " clans");
    else fail("getState_ returned: " + JSON.stringify(st).slice(0, 200));
  } catch (e) { fail("getState_ threw: " + e + (e.stack ? "\n" + e.stack : "")); }

  // ---- 6. rebuildViews_ (the v3 addition) ----
  log("\n[6] rebuildViews_() — the v3 per-clan tab generator");
  try {
    rebuildViews_();
    pass("rebuildViews_ ran without throwing");
    var after = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); });
    log("  tabs now: " + after.join(", "));
  } catch (e) { fail("rebuildViews_ threw: " + e + (e.stack ? "\n" + e.stack : "")); }

  log("\n===== RESULT: " + (ok ? "ALL CHECKS PASSED — if the site still fails, redeploy: Deploy → Manage deployments → edit ✏️ → Version: New version → Deploy" : "PROBLEM FOUND — see the ✗ lines above") + " =====");
  return L.join("\n");
}

/* ============================ auth bootstrap ============================ */

/**
 * FORCE_AUTH — run this ONCE from the editor to make the OAuth consent screen
 * appear, so you can grant every scope the Web app needs (especially
 * external_request, used by "Import from ClashCWL").
 *
 * When you run it:
 *   1. A "Authorization required" dialog appears → Review permissions
 *   2. Pick m4michu123@gmail.com
 *   3. "Google hasn't verified this app" → Advanced → Go to (project) (unsafe)
 *   4. Allow  → the function runs and logs the checks below
 *
 * After it succeeds, DELETE this function (or leave it — it is harmless) and
 * redeploy: Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 */
function FORCE_AUTH() {
  var out = [];
  var log = function (s) { out.push(s); Logger.log(s); };

  log("Requesting scopes…");

  // external_request — needed by doImportClan_ (UrlFetchApp → api.clashcwl.com)
  try {
    var r = UrlFetchApp.fetch("https://example.com", { muteHttpExceptions: true });
    log("  ✓ external_request granted (example.com → HTTP " + r.getResponseCode() + ")");
  } catch (e) {
    log("  ✗ external_request FAILED: " + e);
  }

  // spreadsheets — the core scope
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    log("  ✓ spreadsheets granted (open: " + ss.getName() + ", " + ss.getSheets().length + " tabs)");
  } catch (e) {
    log("  ✗ spreadsheets FAILED: " + e);
  }

  // script.external_request is enough; a POST round-trip proves the whole chain
  try {
    var res = doPost({ postData: { contents: JSON.stringify({ action: "login", user: "admin", pass: "admin" }) } });
    var body = res.getContent();
    log("  doPost login → " + (body.charAt(0) === "{" ? "JSON OK: " + body.slice(0, 80) : "NON-JSON: " + body.slice(0, 80)));
  } catch (e) {
    log("  ✗ doPost threw: " + e);
  }

  log("\nDone. Now redeploy a NEW VERSION of the Web app.");
  return out.join("\n");
}

/**
 * PROBE_DEPLOYMENT — pings the live /exec URL from inside Apps Script to see
 * what an anonymous POST actually gets back. Run from the editor, then check
 * View → Logs.
 *
 * Paste your current /exec URL into DEPLOY_URL below first.
 */
function PROBE_DEPLOYMENT() {
  var DEPLOY_URL = "https://script.google.com/macros/s/AKfycby0Eo5ES8VIqiGPXU6SbgSjkasQ0sX-7NgQQ1KG1rDAmUEjHvzCQ8umq7IOBEzTSpDk/exec";
  var log = function (s) { Logger.log(s); };

  log("=== GET " + DEPLOY_URL + "?action=state ===");
  try {
    var g = UrlFetchApp.fetch(DEPLOY_URL + "?action=state", { muteHttpExceptions: true, followRedirects: true });
    log("  status " + g.getResponseCode() + "  ct=" + g.getHeaders()["Content-Type"]);
    log("  body[0..100]: " + g.getContentText().slice(0, 100));
  } catch (e) { log("  threw: " + e); }

  log("\n=== POST (login) ===");
  try {
    var p = UrlFetchApp.fetch(DEPLOY_URL, {
      method: "post",
      contentType: "text/plain;charset=utf-8",
      payload: JSON.stringify({ action: "login", user: "admin", pass: "admin" }),
      muteHttpExceptions: true,
      followRedirects: true,
    });
    log("  status " + p.getResponseCode() + "  ct=" + p.getHeaders()["Content-Type"]);
    var body = p.getContentText();
    log("  body[0..300]: " + body.slice(0, 300));
    // pull any visible error text out of Google's HTML
    var m = body.match(/errorMessage[^>]*>([^<]{0,200})/);
    if (m) log("  >>> Google error text: " + m[1]);
    var t = body.match(/<title>([^<]*)<\/title>/);
    if (t) log("  >>> page title: " + t[1]);
  } catch (e) { log("  threw: " + e); }

  log("\n=== who owns / can access this deployment ===");
  log("  effective user: " + Session.getEffectiveUser().getEmail());
  log("  (deployment must be: Execute as = Me,  Who has access = Anyone)");
}
