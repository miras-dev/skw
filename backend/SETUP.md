# CWL Roster Manager v3 — setup

A single-page site (black theme, mobile-first) where admins sign in, see each
family clan's **own** CWL line-up (main 15 + subs), pull a starting line-up from
the **ClashCWL "who should play"** ranking, and move players around — every
change written to a **Google Sheet** and logged with **who / what / when**.

## What v3 changes (vs v2)

The Google Sheet now has **one tab per clan** — that clan's 15 main + 4 subs, in
the columns `Slot · # · Name · Tag · TH · Ranked League · HeroSum · Score ·
Signal · Note · UpdatedBy · UpdatedAt` — plus a **Not Selected** tab pooling
every unselected player from every clan (leading `Clan` column). These tabs are
**auto-rebuilt after every change** — read them, don't hand-edit them. The app's
real data lives in a hidden **`_Roster`** tab (the old flat sheet, renamed). Clan
tabs are created / renamed automatically as clans are added or renamed.

**`cwl-roster.html` is unchanged** — the HTTP API is byte-identical to v2. Only
the Apps Script (`Code.gs`) needs updating.

### Upgrading an existing v2 deployment (keeps your data)

1. Apps Script editor → select all of `Code.gs`, delete, paste the **v3**
   `Code.gs`. Save.
2. Also update `roster-scoring.gs` if it changed (it didn't in this release).
3. Function dropdown → **`migrateV2toV3`** → Run. Renames `Roster` → `_Roster`
   and builds the per-clan + `Not Selected` tabs from your current rosters.
   History and Accounts untouched.
   *(Run `seed` instead only to wipe everything back to empty.)*
4. **Deploy → Manage deployments → edit ✏️ → Version: New version → Deploy.**
   Same `/exec` URL — nothing to change on the website.

---


```
cwl-roster.html ──fetch──► Google Apps Script Web App ──► Google Sheet
 (host on your subdomain)          │                       Roster · History · Accounts
                                   └── server-side ──► api.clashcwl.com/clan-deep
                                                       api.clashcwl.com/clan-battlelogs
                                   then runs the SHARED Eligibility.rankClan()
```

## Files

| File | Where it goes |
|---|---|
| `cwl-roster.html` | Your static host (`roster.clashcwl.com`). One self-contained file. |
| `Code.gs` | Apps Script project on the Google Sheet — main backend. |
| `roster-scoring.gs` | Same Apps Script project — vendored copy of the CWL scoring. |
| `make-scoring-bundle.sh` | Dev tool. Regenerates `roster-scoring.gs` from `clash-companion/js/`. |

---

## 1. Create the Sheet + backend (once)

1. <https://sheets.new> — blank Sheet, name it *CWL Rosters*.
2. **Extensions → Apps Script**. Delete the sample `myFunction`.
3. In the Apps Script editor: **Files → ➕ → Script**, name it **`roster-scoring`**
   (no `.gs` — the editor adds it). Open `roster-scoring.gs` from this folder,
   copy the whole thing, paste it into that new file.
4. Click the default **`Code.gs`** file → paste the whole of this folder's
   `Code.gs` into it. **Save** (💾) — saves both files.
5. Function dropdown → **`selfTest`** → **Run**. Grant permissions when asked
   (*Review permissions → your account → Advanced → Go to (project) → Allow* —
   it's your own script). Check the execution log says `roster-scoring.gs OK`.
6. Function dropdown → **`seed`** → **Run**. This creates three tabs:
   - **Roster** — five family clans registered, rosters empty
   - **History** — one `seed` row
   - **Accounts** — `Ben` and `admin` (passwords stored SHA-256 + per-row salt)
7. **Deploy → New deployment** → ⚙️ → **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
   - **Deploy**, approve, **copy the `/exec` URL**.

> "Anyone" = anyone with that URL can call the API (no Google login needed for
> your admins). The URL is unguessable; don't post it publicly.

---

## 2. Host the site

The HTML is one file. Put it on `roster.clashcwl.com` (S3 + CloudFront, per your
existing setup — upload as `index.html`). It also works from `file://` for
testing.

First load: expand **"Backend URL (set once per device)"** on the login screen,
paste the `/exec` URL, sign in. The URL is remembered in that browser.

**Logins:** `Ben` / `skwben`, `admin` / `admin`. Both are full admins. Any
signed-in admin can create more from the site (**Add admin** button on any clan
tab) — new accounts land in the **Accounts** tab, password hashed.

---

## 3. Using it

- **Clan chips** across the top — one per family clan, plus **Not-Selected** and
  **＋ Clan**. Each clan is self-contained; rosters are never mixed.
- **＋ Clan** — name + `#tag`. New empty tab with its own Import button.
- **Import from ClashCWL** (per clan) — runs the ClashCWL ranking for that
  clan's tag and **replaces the whole roster**: positions **1–15 → main**,
  **16–19 → subs**, **20+ → that clan's not-selected list**. Takes 20–40s (one
  API call per member). Re-importing wipes any manual changes for that clan
  (they stay in History). Imported players get the note
  *"Selected from ClashCWL API · <date>"*.
- **Move to…** — pick any clan's Main/Subs or Not-Selected. The moved player's
  note becomes *"Moved to <Clan>/<slot> by @<you> · <date>"* and the badge flips
  to `manual`.
- **→ Sub / → Main**, **↑ ↓** reorder, **Note** field — all logged.
- **History** button (bottom-right) — last ~200 changes: who, what, when. Full
  log lives forever in the Sheet's **History** tab.
- The page re-polls every 20s so admins see each other's changes.
- Soft cap: chip count turns amber past 15 main / 4 subs — never blocks.

---

## Refreshing the scoring (dev)

`roster-scoring.gs` is a **byte-identical concatenation** of
`clash-companion/js/leaguetiers.js` + `battlelog.js` + `eligibility.js`
(dependency order). When that shared scoring changes upstream:

```bash
cd cwl-roster-v2
./make-scoring-bundle.sh                       # assumes ~/Desktop/Azolute/clash-companion
# or: ./make-scoring-bundle.sh /path/to/clash-companion
```

Then paste the regenerated `roster-scoring.gs` back into the Apps Script project
and **Deploy → Manage deployments → edit → New version → Deploy**.

The file header records the source commit hash it was built from.

---

## Notes / limits

- **Import is slow and can truncate.** `api.clashcwl.com/clan-battlelogs` runs
  one upstream call per member; API Gateway hangs up at 29s. For a 40+ member
  clan the import may come back `truncated` — the site shows an amber warning and
  you re-import a minute later (the API caches, so the gaps fill in).
- **No CORS problem.** The site's browser never calls `api.clashcwl.com` — the
  Apps Script does, server-to-server. So the site can live on any domain.
- **Not-Selected filter** narrows by the clan name mentioned in a player's note
  (there's no stored "home clan" once someone is unassigned). Pragmatic, not
  exact.
- **Passwords**: SHA-256 + per-row salt in the Accounts tab. Login sends
  plaintext over HTTPS to the script, which hashes and compares. Light, but
  nothing sensitive is in the Sheet anyway.
- **Cost**: static file on your existing CloudFront + Apps Script free tier +
  a handful of calls to your existing Lambda = effectively $0/month.
