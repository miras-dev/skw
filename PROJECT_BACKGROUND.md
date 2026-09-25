# SkW Family — Background & Known Rough Edges

This is a companion file to `PROJECT_OVERVIEW.md`. It holds the Clash of Clans domain background and a list of known small inconsistencies in the codebase — material that's useful context but not needed for most day-to-day changes. Read `PROJECT_OVERVIEW.md` first; only pull this file in when a task actually needs game-mechanics background (e.g. touching league/tier logic, CWL sizing, scoring bands) or when you want the list of known quirks before touching nearby code.

---

## Clash of Clans background you need to understand this codebase

You don't need to be a player, but you do need these concepts because they're load-bearing throughout the code.

### Town Halls, heroes, and "maxed" bases
Every player's base is built around a Town Hall (TH) level — currently up to TH18 in the game. Players also have Heroes (Barbarian King, Archer Queen, Grand Warden, Royal Champion, Minion Prince, plus a couple of Builder Base-only heroes) that level up independently and contribute to combat strength. A "maxed" TH18 hero lineup sums to roughly 480 total hero levels — this codebase treats a **hero level sum ("heroSum") of 470+** as "maxed" for practical purposes. This matters because a high-TH player with low hero levels is much weaker than their Town Hall alone suggests, and the roster-scoring logic specifically checks for maxed heroes when deciding who anchors a clan's defense.

### Ranked Battles and League tiers
Since an October 2025 update, Clash of Clans has a mode called **Ranked Battles**, separate from old-style "trophy pushing." Players sign up, get grouped with ~100 similarly-ranked players, and spend a week attacking/defending to climb a strict ladder of leagues. This is genuinely a big deal for this project because **a player's league tier is now the primary signal of how good they are** — more meaningful than raw trophy count, because trophies aren't comparable across different leagues.

The full ladder, lowest to highest (each named tier has 3 numbered sub-ranks except Legend, listed low→high):

```
Unranked
Skeleton (1–3)
Barbarian (4–6)
Archer (7–9)
Wizard (10–12)
Valkyrie (13–15)
Witch (16–18)
Golem (19–21)
P.E.K.K.A (22–24)
Titan (25–27)
Dragon (28–30)
Electro (31–33)
Legend III   ← the three "Legend" tiers are the top of the entire ladder
Legend II
Legend I     ← the single highest tier in the whole game
```

Each week, the top performers in a bracket get promoted one tier, the bottom performers get demoted one tier; there's a "league floor" tied to your Town Hall level below which you can't be demoted, and prolonged inactivity slowly demotes you. Trophies earned per attack scale with how well you 3-star (up to 40 trophies for a clean 3-star; partial stars or misses earn much less, and can even feed trophies to your defender).

**Why this matters for this codebase**: the backend has a hardcoded table of all 37 league tiers (`LeagueTiers` in `backend/roster-scoring.gs`), each with a numeric ID starting at `105000000` (rank 0 = Unranked) up through `105000036` (rank 36 = Legend I). The three Legend tiers specifically are:

| League name | Numeric ID | Ladder rank |
|---|---|---|
| Legend III | 105000034 | 34 |
| Legend II | 105000035 | 35 |
| Legend I (the best) | 105000036 | 36 (top) |

You'll see checks like "is this player's tier rank 34, 35, or 36" scattered through the backend — that's always asking "is this player in one of the three Legend leagues." A player in Legend league is, almost by definition, one of the strongest players available, regardless of how their recent week of attacks went — which is exactly why the roster tool treats Legend players specially (see `PROJECT_OVERVIEW.md` §5.6, "Check for updates").

### Clan War Leagues (CWL) — the actual competitive format this tool manages
**Clan War Leagues** is the older, clan-vs-clan team format this whole tool exists to support (distinct from the individual Ranked Battles ladder above, though both use the same "Legend" naming and the site cares about both). Once a month/season, groups of **8 clans** are placed into a league bracket together and fight a round-robin: over 8 days, each clan wars against every other clan in the group exactly once (7 wars total). Each war has one Preparation Day (choose your 15 or 30 attackers for that specific war, arrange defenses, donate reinforcements) followed by a Battle Day (each participating player gets exactly **one** attack, unlike regular Clan Wars where you get two).

Key facts that explain this tool's design:
- A clan **signs up a roster** for the whole CWL season — a fixed list of players (minimum 5, up to everyone in the clan) who are eligible to be picked for any of the 7 individual wars. You can't add someone mid-season who wasn't in the roster.
- Clans below "Master League I" can choose 15v15 or 30v30 war size; higher clans are locked to 15v15. This directly explains the tool's **"15-man CWL" vs "30-man CWL"** toggle per clan (`cwlSize` field) — it controls whether the "main roster" cap is 15 or 30.
- Clans are ranked within their group of 8 by total stars earned (with a +10 star bonus for winning each individual war), tiebroken by total destruction. Top clans get promoted a league, bottom clans get demoted.
- The highest CWL leagues (Titan III and up) apply the same kind of "difficulty modifiers" as Legend league in Ranked Battles — defenses hit harder, attacking heroes are penalized — which is part of why being well-prepared with a strong lineup matters more at the top.

**So, concretely: this tool's whole job is to help clan leaders decide the answer to "who's in our CWL roster this season" — who's in the main lineup, who's a substitute, and who's sitting out — informed by an external ranking service's opinion of who's currently playing well.**

---

## Known rough edges worth knowing about

A few small inconsistencies surfaced while building the project documentation — not urgent, just worth having on your radar if you're touching nearby code:

- The repo's `README.md` describes the deploy mapping incorrectly (says `cwl-roster.html` deploys to the site root; the actual GitHub Actions workflow sends `index.html` to the root and `cwl-roster.html` to its own path). Trust the workflow file.
- The backend's own top-of-file doc comment for the `setStatus` action only mentions `"not-selected"` and `"out"` as valid values, but the code also accepts and validates a third value, `"legend"`, which is used elsewhere in the app.
- The `playerBattlelog` action's doc comment says it returns "the last 16" battles, but the actual code fetches up to 200 and returns everything that matches, uncapped. It also only counts a battle as "ranked" if its type is literally `"ranked"` — it does not include the `"legend"` battle type the way the shared scoring engine's own battle-log parser does, so a Legend-league player's battle history shown through this specific action could under-count compared to what the scoring model sees internally.
- "Import from ClashCWL" and "Check for updates" both use the same underlying ranking, but they don't use the exact same *list* from it: Import just slices the plain best-to-worst ranking positionally (top 15/30 → main, next 4 → sub); Check for updates instead uses the model's band-aware "suggested roster" list for its non-Legend candidates. In an unusual case, this means the two features could theoretically disagree slightly on who "should" be in the main 15 — Import doesn't reorder for band priority the way Check for updates does.
