# skw.clashcwl.com — CWL Roster Manager

Two static pages, both deployed by `.github/workflows/deploy.yml` on every push
to `main`:

- `cwl-roster.html` → `s3://skw.clashcwl.com/index.html` — the admin app
  (login required; move players, import from ClashCWL, manage clans/admins).
- `lineup.html` → `s3://skw.clashcwl.com/lineup.html` — a read-only, no-login
  view of each clan's current lineup, for players. Linked from the admin
  header ("Player view").

Both public pages read the roster from `data/state.json` on the CDN, which
the backend republishes within about a minute of any change (see "Public
state file" in `backend/SETUP.md`); they fall back to calling Apps Script if
it's missing or stale, and draw the last copy from localStorage first.

Images: `assets/` holds the web-sized WebP/PNG/JPEG copies that get deployed;
`assets-src/` holds the full-size originals (not deployed). After changing an
original, run `python3 scripts/build-images.py`.

`backend/` holds the Google Apps Script pieces (deployed to Google by hand — see
`backend/SETUP.md`); the workflow ignores them.
