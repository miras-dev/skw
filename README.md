# skw.clashcwl.com — CWL Roster Manager

Two static pages, both deployed by `.github/workflows/deploy.yml` on every push
to `main`:

- `cwl-roster.html` → `s3://skw.clashcwl.com/index.html` — the admin app
  (login required; move players, import from ClashCWL, manage clans/admins).
- `lineup.html` → `s3://skw.clashcwl.com/lineup.html` — a read-only, no-login
  view of each clan's current lineup, for players. Linked from the admin
  header ("Player view").

`backend/` holds the Google Apps Script pieces (deployed to Google by hand — see
`backend/SETUP.md`); the workflow ignores them.
