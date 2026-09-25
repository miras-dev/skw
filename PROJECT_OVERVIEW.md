# SkW Family — Project Overview

This document exists so a new chat session can understand this whole project without re-reading every file. If you're an AI assistant picking this up cold: read this first, and you should have everything you need to talk about the project intelligently and make changes confidently. It's written in plain English on purpose — the goal is understanding, not a spec.

There's a companion file, `PROJECT_BACKGROUND.md`, holding Clash of Clans domain background (Ranked Battles, League tiers, Clan War Leagues mechanics) and a list of known small code inconsistencies. You don't need it for most changes — only pull it in if a task actually touches league/tier logic, CWL sizing, or scoring bands, or if you want the known-quirks list before touching nearby code. Keeping that material in a separate file is a deliberate token-efficiency choice: most changes only need this file.

If something in here turns out to be wrong or stale, trust the code over this doc — but see the standing instruction below.

---

## ⚠️ Standing instruction: keep this doc in sync with logic changes

**From now on, whenever a change to this repository touches a logical/decision-making layer of the app — not just visual or copy tweaks — update this file (or `PROJECT_BACKGROUND.md`, whichever section is relevant) in the same piece of work.** This applies to things like:

- Ranking/scoring strategy changes (how `form`, `confidence`, `score`, or `band` are computed in `roster-scoring.gs`)
- Priority/eligibility changes (who counts as a Legend candidate, what makes it into `suggested`, band thresholds, what "maxed" means)
- Any new rule about how players get bucketed into main/sub/pool, or how `status`/`signal` get set
- New actions, new fields in the data model, or changes to what an existing action does
- Anything that changes the *behavior* described in §4–§7 below, not just how it looks

Routine UI polish, copy edits, styling, or bug fixes that don't change a decision-making rule don't need a doc update. When in doubt, ask whether a future reader of this doc would now be told something incorrect about *how the system decides things* — if yes, update it.

---

## 1. What this project actually is

**SkW Family** is a small suite of websites built for a real Clash of Clans "family" of clans (a group of allied clans run by the same leadership, called "SumKindOfWonder" / SkW). The family currently has 5 clans: Sumkindofwonder, Black & White, SumKindOfBeauty, Turri, and Rocking Warrior.

The site does two things:

1. **Publishes public information** about the family — which clans exist, their stats, and a leaderboard of the family's strongest players (`index.html`), plus a live, read-only view of each clan's current War League lineup (`lineup.html`).
2. **Gives clan leadership a tool** to manage those lineups — decide who's in the main 15 (or 30), who's a substitute, who's benched, pull suggested rosters from an external ranking service, and track changes over time (`cwl-roster.html`, admin-only, login required).

There's no framework here. Every page is a single self-contained HTML file with inline `<style>` and inline `<script>` — plain vanilla JavaScript, no React/Vue/build step, no npm dependencies for the frontend. The backend is a **Google Apps Script** project (Google's serverless JS-on-a-spreadsheet platform) using a Google Sheet as the database.

Live site: `https://skw.clashcwl.com`. It's a subdomain of a larger site called ClashCWL (`clashcwl.com`), which appears to be an independent ranking/stats service that this family's site pulls data from.

For Clash of Clans domain background (Ranked Battles, League tiers, Clan War Leagues) needed to fully understand *why* this tool works the way it does, see `PROJECT_BACKGROUND.md`.

---

## 2. The moving pieces, at a glance

```
                    ┌─────────────────────────────────────────┐
                    │         skw.clashcwl.com (S3 + CloudFront) │
                    │                                           │
   index.html ──────┼──► site root "/" — public homepage         │
   cwl-roster.html ─┼──► "/cwl-roster.html" — admin roster tool  │
   lineup.html ─────┼──► "/lineup.html" — public lineup viewer   │
                    └─────────────────────────────────────────┘
                                     │
                                     │  every page talks to ONE backend:
                                     ▼
                    ┌─────────────────────────────────────────┐
                    │   Google Apps Script Web App (/exec URL)  │
                    │   backend/Code.gs + backend/roster-scoring.gs │
                    │   reads/writes a Google Sheet as its DB   │
                    └─────────────────────────────────────────┘
                                     │
                        also calls out to, server-side:
                                     ▼
              api.clashcwl.com (ClashCWL's own API — clan data,
              battle logs, single-player lookups, ranking opinions)

     Additionally, cwl-roster.html and lineup.html both call, straight
     from the browser (no backend involved), a free public service:
              api.clashk.ing (ClashKing — war/CWL/clan-history stats
              used only inside the "Player Info" panel's charts)
```

Everything is deployed automatically: a GitHub Actions workflow (`.github/workflows/deploy.yml`) pushes the three HTML files and `assets/` to S3 and invalidates CloudFront on every push to `main`. **The backend is not part of that automation** — it lives in a Google Apps Script project and has to be updated by hand: paste the new `Code.gs` into the Apps Script editor, then Deploy → Manage deployments → New version. The `/exec` URL stays stable across redeploys, so nothing on the frontend needs to change when the backend is updated.

> **Note on `README.md`**: it has a stale inaccuracy about the deploy mapping — see the known-rough-edges list in `PROJECT_BACKGROUND.md`. Trust the workflow file over the README if they ever disagree.

---

## 3. `index.html` — the public homepage

A marketing/landing page for the family. Fully public, no login, no admin features. Everything on it is either static content or read-only data pulled from the backend.

**Page structure top to bottom:**

1. **A parallax background image** behind everything — implemented with a real CSS transform on scroll (not `background-attachment:fixed`, deliberately, because that's unreliable on iOS Safari).
2. **A sticky top bar** that only appears once you've scrolled past the full-height hero banner. Has the SkW logo/brand and two buttons: **"View lineups"** (links to `lineup.html`) and **"Discord"** (opens the family's Discord invite in a new tab). Hidden entirely on narrow/mobile screens.
3. **The hero section** — full-viewport-height banner with the SkW logo, the tagline "Clash of Clans · CWL Family", and the same two buttons ("View lineups", "Discord"), which animate in with a staggered fade/drop on page load.
4. **"Our Clans" section** — a grid of clan cards, one per family clan, fetched live from the backend (`?action=state`). Each card is itself a clickable link that opens the clan's live in-game profile via a Supercell deep link (`clashofclans.com` clan-profile URL) in a new tab — clicking a clan card does **not** navigate anywhere on this site, it jumps straight into the Clash of Clans app/website for that clan. Each card shows the clan's badge, name, tag, war league (styled as the headline stat), and — if stats have been imported at least once — member count, war win/loss record, and clan points.
5. **"Hall Of Flame — Top 15 Players"** — a leaderboard of the family's strongest 15 players across all clans, ranked by league tier first and trophies only as a tiebreaker within the same tier (the code is explicit that a lower-league player with more trophies never outranks a higher-league player). This data is **not fetched live on every page load** — it's a cached snapshot an admin refreshes on demand via a hidden "Refresh rankings" button (only visible to a signed-in admin, detected by checking for a valid login token the admin page previously saved to this browser's local storage — same-origin trick, since both pages are served from the same domain). The list shows rank, a colored initials avatar, player name (with their clan's color), league icon, league name, and trophy count. The top 5 rows get extra "ember" flame styling (an animated glowing gradient border); rank 1 specifically burns gold instead of purple. **Any player currently in Legend I league** gets a distinct, even flashier treatment — a faster gold burn, a diagonal light-sweep animation, two little lightning-bolt decorations, and spark-burst particles — applied regardless of their position in the top 15, because reaching the single highest league in the game is treated as noteworthy on its own.
6. **"Family Strength" stat strip** — four big numbers (total clans, total main-roster players, total substitutes, total tracked players) derived from the same clan data already fetched for the clan cards above — no extra API call.
7. **A closing call-to-action band** repeating the "View lineups" / "Discord" buttons.
8. **Footer** — links to "Player lineups" (`lineup.html`), "Admin" (`cwl-roster.html`), and a "Part of the ClashCWL network" link out to `clashcwl.com`.

No forms, no logins, no write actions anywhere on this page except the one admin-only "Refresh rankings" button. Nothing here polls automatically — everything loads once per page visit.

---

## 4. `cwl-roster.html` — the admin roster manager

This is the real workhorse of the project — a single-page admin app, login required, where clan leadership actually builds and edits each clan's CWL roster.

### 4.1 Terminology you need before any of this makes sense

- **"Main"** — the starting CWL lineup for a clan this season: 15 players by default, or 30 if that clan has opted into 30-man CWL.
- **"Sub" / "Substitutes"** — up to 4 backup players who aren't in the starting 15/30 but are ready to fill in.
- **"Pool" / "Not selected"** — everyone else being tracked for that clan who isn't currently on main or sub. This isn't a punishment bucket exactly — it includes strong players (including Legend league players) who just haven't been placed yet, as well as players confirmed unavailable.
- **A clan's "key"** vs **"name"** vs **"tag"** — the *key* is an internal URL-safe slug (like `sumkindofwonder`) used everywhere in code and API calls; the *name* is the human-readable display name ("Sumkindofwonder"); the *tag* is the actual in-game `#TAG` identifier used to look the clan up via the Clash of Clans / ClashCWL APIs.
- **"Signal"** — a small badge on each player card showing *how* they ended up in their current spot: `clashcwl` (the automated ranking put them there) or `manual` (a human admin moved or added them). This is purely informational, so an admin can see at a glance which placements are the algorithm's opinion versus a deliberate human override.
- **"Status"** — a secondary marker layered on top of slot, mainly meaningful for pool players: blank/normal, `legend` (this player is in a Legend league and worth keeping an eye on even though they're unplaced), `not-selected`, or `out` (confirmed unavailable — injured from the game in the loosest sense, on a break, kicked, etc.). The "Not Selected" tab groups players into two visual sections using exactly this field: a "substitutes" section for `legend`/`not-selected` players, and a separate "confirmed unavailable" section for `out` players.

### 4.2 Logging in and the overall shell

A simple username/password login screen. On success, the app stores a login token in the browser's local storage (so refreshing the page or coming back later doesn't require logging in again — the session is considered valid for about 30 days by the backend). Once logged in, the page has:

- A **sticky header bar**: brand/logo (links back to `index.html`), a live status indicator (saving/error/OK), the logged-in username, and action buttons — **Player view** (opens `lineup.html`), **Add admin**, **Clear data**, **Sign out** — which collapse into a hamburger menu on narrow screens.
- A **row of clan chips** below that — one tappable chip per clan (colored dot, name, a "main/subs" count badge that turns orange if either count is over its cap), plus a **"Not-Selected"** chip and a **"Current War"** chip, plus a dashed **"+ Clan"** chip to register a new family clan.
- A **search bar** that, when you type into it, replaces the whole main view with a flat, all-clans search result list (matches on player name or tag).
- The **main content area**, which shows whichever tab/clan is currently selected.
- A floating **"History"** button (bottom-right) that opens a running activity log of every change any admin has made, and gets a red "unseen" dot if someone else has made changes since you last checked it.

The app polls the backend every 20 seconds for fresh data (but pauses that polling while you have unsaved edits in flight, so it can't clobber something you're mid-way through changing).

### 4.3 The three main views

**A clan's roster view** (the default, one per clan) shows a header card with the clan's badge, name, tag, war league, a dropdown to switch between 15-man and 30-man CWL sizing, and — once you've imported at least once — a stat grid (level, members, average TH, war record, win streak, clan points). Below that, a toolbar offers either **"Import from ClashCWL"** (if this clan's roster is currently empty) or **"Check for updates"** (once it has a roster — see §4.6), plus **"+ Add player"**, and, for any non-founding clan, danger buttons to remove the clan (only if empty) or remove the clan and all its players at once. Below the toolbar are three sections — Main roster, Substitutes, Not selected (this clan) — each just a list of player cards you can drag players between, or between clans entirely.

**The Not-Selected view** (its own tab) shows every pool player across the *whole family* at once, with a dropdown to filter down to one origin clan if you want.

**The Current War view** shows, per clan, whatever CWL/war is currently live for them, pulled straight from the official Clash of Clans API via a small relay server the backend calls out to (see §6.4) — war state (preparing/battling/ended/not in a war/private war log), the opponent, team size, star and destruction totals for both sides, and — most usefully — a per-member breakdown so leadership can see at a glance who in the current war has and hasn't attacked yet, along with each attack's stars/destruction and the best hit taken defensively.

### 4.4 The player card

Every player, everywhere in this app, is rendered by the same card component: their position number (in main/sub views), a league icon, their name, a colored score pill (green/amber/red depending on how highly the ranking model rates them), a clan-signal badge, league name, Town Hall pill, hero-level sum, and their player tag. Underneath, action buttons — **View info** (opens the big Player Info panel, see §4.8), **Move to…** (opens a picker to relocate them to any clan/slot or Not-Selected), a quick **"→ Sub" / "→ Main"** toggle if applicable, and up/down arrows to reorder them within their current list. There's also an editable note field (any admin can leave a free-text note on a player, saved on blur) and a small stamp showing who last touched this row and when. Every card is also draggable — you can literally drag a player from one clan's Main list and drop them into another clan's Sub list, or into Not-Selected.

### 4.5 Adding a clan, adding an admin, clearing data

- **"+ Clan"** opens a small form (clan name + clan tag) and registers a new family clan with an empty roster.
- **"Add admin"** lets any already-logged-in admin create a new username/password login for someone else — there's no tiered permission system; every admin account can do everything.
- **"Clear data"** is the nuclear option — it wipes every player from every clan's roster across the entire family (typing the word "CLEAR" is required to enable the button). The 4 founding "seed" clans survive, emptied, ready for a fresh import; anything else gets deleted outright. It's logged in History so it's at least traceable after the fact, but there's no undo.

### 4.6 "Import from ClashCWL" vs "Check for updates" — the two ways to pull in the algorithm's opinion

Both features call out to ClashCWL's own ranking service, which looks at a clan's members and their recent ranked-battle logs and produces an opinion on who's worth fielding. They differ in how destructive they are:

- **Import from ClashCWL** is the blunt, one-shot option, only offered while a clan's roster is completely empty. It fetches the clan's full member list and battle logs, runs the ranking model, and simply takes the ranking's top 15 (or 30) players as "main," the next 4 as "sub," and dumps everyone else into "pool" — wholesale replacing anything that was there. It's explicitly a destructive action (though recoverable in spirit via the History log, not literally undoable).

- **Check for updates** is the gentle, repeatable option, offered once a clan already has a roster. It runs the exact same ranking underneath, but instead of overwriting anything, it just shows you a list of *every untracked player in that clan* — anyone who isn't already on that clan's main, subs, or not-selected — regardless of league or score. (This is scoped to the current clan only: a player already tracked under a different family clan or sitting in the family-wide Not-Selected pool is not deduplicated against here, so they can still turn up as a "candidate" if ClashCWL also reports them as a member of the clan being checked.) Nothing is written until you personally click a slot button for a specific candidate, **or until you close the panel** — closing without deciding is treated as "not reviewed yet," not "no," so whoever's left in the list gets written to that clan's Not-selected automatically (status `legend` for Legend-league players, `not-selected` for everyone else; see `doDismissSuggested_` in `Code.gs`).
  - **Any untracked player currently in a Legend league** is flagged with a gold "Legend" pill regardless of score, and gets a genuinely open choice of Main/Sub/Not-selected — reaching Legend league is treated as a harder-won signal than a few days of recent form.
  - **Every other untracked player** also shows up now (not filtered down to the model's top-15/30 pick anymore), with an explicit note that they default to Not-selected unless placed elsewhere, and the model's own recommended slot gets a little checkmark.

### 4.7 "Add a player" (two-step, with a preview)

This is for adding someone who isn't currently tracked in any clan at all — a free agent or a new recruit. It's a two-step flow: first you enter a player tag and click **"Look up"**, which fetches that player's live info (name, Town Hall, league, hero total) and shows you a preview card — including a Legend pill if they qualify — **without saving anything yet**. Only after seeing the preview do you pick where to actually place them (any clan's Main or Sub, or Not-Selected), using the same clan/slot picker as "Move player." This was specifically redesigned (previously it looked the player up and immediately dumped them into Not-Selected in one step with no confirmation) so an admin can see who they're about to add and decide the destination deliberately.

### 4.8 The Player Info panel — deep dive on one player

Clicking "View info" on any card opens a big bottom sheet with 4 tabs, pulling in data from two different external sources beyond this app's own backend:

- **Overview** — known stats from this app's own roster row (Town Hall, league, hero sum, ranked score), plus lifetime totals (wars played, CWL seasons, average war stars) and a "time spent in recent clans" bar chart.
- **War** — regular Clan War stats: attacks used vs. allowed, average stars/destruction/duration for both attacking and defending, a star-distribution breakdown (how many 0★/1★/2★/3★ attacks), and a month-by-month trend chart.
- **CWL** — the same shape of stats but specifically for Clan War League participation, plus a season-by-season list. Notably, the public CWL history API doesn't include *defensive* stats directly, so this app reconstructs them itself by re-fetching each season's full war group and scanning for attacks landing on this specific player — capped to the most recent 12 seasons for performance, with a note if there's more history than that.
- **Clan history** — a full list of every clan this player has spent meaningful time in recently, as a bar chart by time spent.

All of this historical war/CWL/clan-history data comes from a free, community-run service called **ClashKing** (`api.clashk.ing`), called directly from the browser (no API key needed, no backend involvement) — credited at the bottom of the panel. It's cached in memory for 10 minutes per player per browser session so reopening the same player's panel doesn't re-fetch everything.

---

## 5. `lineup.html` — the public, read-only lineup viewer

This is the "player view" — what a regular clan member (not an admin) sees. It shares almost all of its visual design and even a lot of its actual code with `cwl-roster.html`, but with every edit/admin capability stripped out.

**What's the same as the admin page:** the same visual theme, the same clan chips navigation, the same search bar and search-results view, the same Not-Selected view, and — importantly — an almost byte-identical copy of the Player Info panel (same 4 tabs, same ClashKing data sources, same charts).

**What's different / missing, deliberately:**
- **No login at all.** There's no username/password anywhere in this page's code — it calls the backend's public, no-token endpoints only.
- **No write actions of any kind.** Nothing here can move a player, add a player, change a clan, or edit anything — this page is 100% read-only.
- **A simpler player card.** The code's own comment is explicit about this: no signal badge, no note field, no "last updated by" stamp, and exactly one action button — **View info**. The reasoning given in the code itself: "leaders own that context, not players" — regular members don't need to see internal admin bookkeeping, just who's in the lineup.
- **No History log, no unread-activity badge** — there's nothing to track since nothing can be edited here.
- **Auto-refreshing** — this page polls the backend every 30 seconds automatically (the admin page's poll pauses while you're mid-edit; this page has no edits to worry about, so it just refreshes on a plain timer).
- **A shareable deep link** — you can link directly into a specific clan's tab via a `?clan=<key>` URL parameter, useful for a "Sumkindofwonder's lineup" link from elsewhere on the site or in Discord.
- It's meant to be publicly indexed by search engines (the admin page presumably is not, though that wasn't directly verified).

---

## 6. The backend (`backend/Code.gs` + `backend/roster-scoring.gs`)

This is a **Google Apps Script** project — Google's platform for running server-side JavaScript that's tightly bound to a Google Sheet, which acts as the entire database here. It has to be manually pasted into the Apps Script web editor and redeployed after any change (see `backend/SETUP.md`); there's no CI/CD for it.

### 6.1 How requests work (and a real historical quirk worth knowing)

Every frontend page talks to **one single URL** (the Apps Script "Web App" `/exec` URL), sending an `action` parameter that tells the backend what to do, plus whatever other parameters that action needs. Both `GET` and `POST` are technically supported, but there's a known quirk: on this particular Google account, Apps Script's POST responses issue a redirect that occasionally breaks (a stale parameter causes a 405 error), so **the frontend deliberately sends every request — even ones that write data — as a GET request with everything packed into the URL's query string.** This is why you'll see write actions like "move a player" or "add a note" going out as ordinary `fetch()` GET calls in the frontend code; it's not a mistake, it's a documented workaround.

Read-only requests (fetching the current state, looking up a player, checking the current war) are handled immediately. Anything that writes data goes through a single global lock (so two admins editing at the exact same moment can't corrupt each other's changes) and requires a valid login token.

**Login/auth model**: usernames and salted-hash passwords are stored directly in the Google Sheet's "Accounts" tab (no external identity provider). A successful login produces a token that's valid for about 30 days. Any logged-in admin can create additional admin accounts — there's no tiered permission system; everyone with a login can do everything. This is explicitly documented in the code as "light gatekeeping, not real security" — anyone who has the `/exec` URL and valid credentials can reach the whole API.

### 6.2 The data model — one flat spreadsheet is the entire database

There's a hidden internal sheet tab called `_Roster` that is the single source of truth — one row per tracked player, using these columns: `tag, name, clan, slot, position, status, th, heroSum, rankedScore, league, signal, note, updatedBy, updatedAt`. (There's also a clever reuse trick where a clan itself is represented as a special row in this same sheet, with a made-up tag like `@clan/sumkindofwonder`, so the whole family registry lives in one flat table without needing a second sheet.)

Every time something changes, the backend regenerates a set of human-readable, presentation-only sheet tabs from that one source of truth: one tab per clan (showing its main 15 + subs 4 in a clean grid), a shared "Not Selected" tab (split into a "substitutes" section for Legend/not-selected players and a separate "confirmed unavailable" section for `out` players), a "History" tab (append-only audit log — who did what, when), and an "Accounts" tab (logins). **You're not supposed to hand-edit any of the generated tabs** — they get silently overwritten on the next change; only the hidden `_Roster` tab is real.

### 6.3 The scoring/ranking model (`roster-scoring.gs`)

This file is a vendored (copy-pasted, not live-imported) snapshot of a shared ranking algorithm from a related project. Given a clan's player list and their recent battle logs, it computes, per player:

- **A league tier rank** (0 for Unranked up to 36 for Legend I), using the full 37-tier ladder table described in `PROJECT_BACKGROUND.md`.
- **A "form" score** — roughly, how well this player has actually been performing lately: are they attacking as often as their league allows, are they earning close to the expected trophy gain for their tier, are they landing a healthy rate of 3-stars. A player with zero recent battle-log data is treated as "unrated" rather than automatically penalized — the model explicitly avoids conflating "we have no data on this person" with "this person is bad."
- **A confidence level** — how much battle history backs up that form score. Fewer than ~10 recorded attacks means low confidence, and the model deliberately discounts the final score toward a floor rather than fully trusting a score built on thin data.
- **A final 0–100 score** and a color-coded verdict (green/amber/red in the UI) plus a short plain-English rationale sentence explaining *why* — e.g. noting if someone's been quiet lately (explicitly not counted against them, since a defense "happens to a base whether or not anyone is playing"), or if they're a strong defensive anchor.
- **A priority "band"** — a rough tier of *how badly this clan should want to field this player*, roughly: (1) genuine Legend I players, (2) maxed-out defensive anchors, (3) strong Legend II/III attackers, (4) everyone else. If a clan doesn't have anyone in Legend league at all, these bands automatically recalibrate relative to that clan's own strongest players, so the model still gives useful guidance to a lower-level clan instead of dumping everyone into "band 4."

This same scoring engine powers both "Import from ClashCWL" and "Check for updates" in the admin app, and the "Overview" ranked-score pill shown on every player card everywhere.

**This is exactly the kind of logic covered by the standing instruction at the top of this file — if you change any of the above (weights, thresholds, what counts as Legend, band definitions, what makes it into a "suggested" roster), update this section.**

### 6.4 External services this backend talks to

- **ClashCWL's own API** (`api.clashcwl.com`) — the primary data source. Provides full clan rosters with stats, per-member battle logs (used for the scoring model above), and single-player lookups (used by "Add a player," "Look up," and the Player Info panel's live-profile tab). Note: the single-player endpoint returns data shaped like the raw, official Clash of Clans API (Town Hall level under a different field name, league as a nested object instead of a plain name, and hero levels as a detailed list instead of one summed number) — the backend normalizes all of that into the same flat shape the clan-wide endpoint already uses, so the rest of the code doesn't have to care which endpoint the data originally came from.
- **A small self-hosted relay in front of the official Clash of Clans API** — used only for the "Current War" feature, because Apps Script doesn't have a fixed outbound IP address that could be allow-listed against Supercell's official API key restrictions, so a separate relay server holds the real API key and this backend calls that relay instead of Supercell directly.
- **ClashKing** (`api.clashk.ing`) — not called by the backend at all; both frontend pages call this directly from the browser for the Player Info panel's historical charts, since it's free and requires no API key.

### 6.5 Maintenance-only functions

A few functions exist purely to be run manually from inside the Apps Script editor (not reachable over the web at all): `seed()` (wipes everything back to a fresh empty state with the 4 founding clans and two default logins — safe to re-run intentionally, dangerous to run by accident), `migrateV2toV3()` (a non-destructive upgrade path for an older version of this same tool), and a couple of diagnostic/troubleshooting functions (`DIAGNOSE`, `PROBE_DEPLOYMENT`, `FORCE_AUTH`) used when setting up or debugging a deployment.

---

## 7. If you're asked to make a change here

A few practical notes given the shape of this codebase:

- There's no local dev server needed for the two static frontend pages beyond opening the file directly or using a simple preview — they're plain HTML/CSS/JS with no build step.
- Any backend change requires the user to manually paste the updated `backend/Code.gs` into the Google Apps Script editor and deploy a new version — you cannot deploy it yourself, and it's easy to forget this step after editing the file locally.
- The three HTML files are large single-file apps by design (thousands of lines each), but they're consistently organized with clear section-comment dividers — searching for the right section header or function name is almost always faster and more accurate than reading the whole file top to bottom.
- Because `cwl-roster.html` and `lineup.html` share a lot of visual/structural DNA (especially the Player Info panel), a change to shared behavior in one often needs to be mirrored in the other — check both when touching anything that looks copy-pasted between them.
- **Remember the standing instruction above**: any logic/strategy/priority/eligibility change (scoring, banding, what counts as Legend, roster-building rules) needs a matching update to this file or `PROJECT_BACKGROUND.md` as part of the same change.
