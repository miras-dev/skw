# skw.clashcwl.com — CWL Roster Manager

Single-page site. `cwl-roster.html` deploys to `s3://skw.clashcwl.com/index.html` via
`.github/workflows/deploy.yml` on every push to `main`.

`backend/` holds the Google Apps Script pieces (deployed to Google by hand — see
`backend/SETUP.md`); the workflow ignores them.
