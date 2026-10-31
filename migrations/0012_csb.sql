-- CSB from API.Bible (S13): the Fair Use token each fetched chapter carries, reported by the browser on display.

ALTER TABLE chapters ADD COLUMN fums_token text;
