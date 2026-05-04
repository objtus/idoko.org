-- Guestbook fields per gb/plan.md (run: wrangler d1 execute idoko-guestbook --remote --file=./migrations/0001_guestbook_plan.sql)
ALTER TABLE comments ADD COLUMN subject TEXT;
ALTER TABLE comments ADD COLUMN reply_to_id INTEGER REFERENCES comments(id);
ALTER TABLE comments ADD COLUMN poster_id TEXT;

CREATE TABLE IF NOT EXISTS gb_rate_limit (
  ip TEXT PRIMARY KEY,
  last_post_unix INTEGER NOT NULL
);

UPDATE comments SET poster_id = 'legacy-' || id WHERE poster_id IS NULL;
