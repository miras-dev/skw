/**
 * CWL Roster Manager v2 — Google Apps Script backend.
 *
 * Companion file: roster-scoring.gs (vendored scoring — LeagueTiers / BattleLog /
 * Eligibility). Both files must be in the same Apps Script project.
 *
 * Google Sheet, three tabs:
 *   Roster    — one row per player (the live board)
 *   History   — append-only audit log
 *   Accounts  — username / salted-SHA-256 password hash / who created it
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

var SALT = "cwl-roster-v2";
var CLASHCWL_API = "https://api.clashcwl.com/api";  // server-to-server: no CORS

var SHEET = { roster: "Roster", history: "History", accounts: "Accounts" };

var ROSTER_HEADERS = [
  "tag", "name", "clan", "slot", "position",
  "th", "heroSum", "rankedScore", "league", "signal", "note",
  "updatedBy", "updatedAt",
];
var HISTORY_HEADERS = ["timestamp", "user", "action", "player", "detail"];
var ACCOUNT_HEADERS = ["username", "hash", "salt", "createdBy", "createdAt", "password"];

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

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || "state";
    if (action === "state") return json_(getState_(tokenUser_(e && e.parameter && e.parameter.token)));
    return json_({ ok: false, error: "unknown GET action: " + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.stack || err) });
  }
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); }
  catch (err) { return json_({ ok: false, error: "bad JSON body" }); }

  try {
    if (body.action === "login") {
      var u = verifyLogin_(body.user, body.pass);
      if (!u) return json_({ ok: false, error: "Wrong username or password" });
      logHistory_(u, "login", "-", "signed in");
      return json_({ ok: true, token: makeToken_(u), user: u });
    }

    var user = tokenUser_(body.token);
    if (!user) return json_({ ok: false, error: "Not logged in — please sign in again" });

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      switch (body.action) {
        case "addAccount": return json_(doAddAccount_(user, body));
        case "addClan":    return json_(doAddClan_(user, body));
        case "importClan": return json_(doImportClan_(user, body));
        case "move":       return json_(doMove_(user, body));
        case "reorder":    return json_(doReorder_(user, body));
        case "toggleSlot": return json_(doToggleSlot_(user, body));
        case "note":       return json_(doNote_(user, body));
        default:           return json_({ ok: false, error: "unknown action: " + body.action });
      }
    } finally { lock.releaseLock(); }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.stack || err) });
  }
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
    if (m) reg[m[1]] = { key: m[1], name: r.name, tag: r.league /* stored in league col */, note: r.note };
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
  var st = getState_(actor); st.ok = true; return st;
}

function doNote_(actor, b) {
  var sh = rosterSheet_();
  var r = findRow_(sh, b.tag);
  if (!r) return { ok: false, error: "player not found" };
  var note = String(b.note == null ? "" : b.note).slice(0, 400);
  setCells_(sh, r.rowIndex, { note: note, updatedBy: actor, updatedAt: new Date() });
  logHistory_(actor, "note", r.data.name, note ? ('"' + note + '"') : "(cleared)");
  var st = getState_(actor); st.ok = true; return st;
}

/* ============================ state read ============================ */

function getState_(me) {
  var rows = readRoster_().filter(function (r) { return r.clan !== "_registry"; });
  rows.forEach(function (r) { r.position = Number(r.position) || 0; });

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
  var sh = ss_().getSheetByName(SHEET.roster);
  if (!sh) throw new Error('No "' + SHEET.roster + '" tab — run seed() first.');
  return sh;
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
 * Creates the three tabs. Roster gets the five family clans registered and
 * nothing else (rosters start empty — use "Import from ClashCWL" per clan).
 * Accounts gets Ben / admin. Safe to re-run: it resets everything.
 */
function seed() {
  var ss = ss_();

  var sh = ss.getSheetByName(SHEET.roster) || ss.insertSheet(SHEET.roster);
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
