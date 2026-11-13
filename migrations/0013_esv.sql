-- ESV is imported once from the owner's downloaded files. No remote API or expiry.
ALTER TABLE translations DROP CONSTRAINT translations_id_check;
ALTER TABLE translations ADD CONSTRAINT translations_id_check CHECK (id IN ('BSB', 'CSB', 'ESV'));
ALTER TABLE translations DROP CONSTRAINT translations_source_kind_check;
ALTER TABLE translations ADD CONSTRAINT translations_source_kind_check CHECK (source_kind IN ('aolab', 'apibible', 'files'));

ALTER TABLE users DROP CONSTRAINT users_display_translation_id_check;
ALTER TABLE users ADD CONSTRAINT users_display_translation_id_check CHECK (display_translation_id IN ('BSB', 'CSB', 'ESV'));
ALTER TABLE study_sessions DROP CONSTRAINT study_sessions_translation_id_check;
ALTER TABLE study_sessions ADD CONSTRAINT study_sessions_translation_id_check CHECK (translation_id IN ('BSB', 'CSB', 'ESV'));
ALTER TABLE questions DROP CONSTRAINT questions_translation_id_check;
ALTER TABLE questions ADD CONSTRAINT questions_translation_id_check CHECK (translation_id IN ('BSB', 'CSB', 'ESV'));

INSERT INTO translations (id, name, source_kind, license_summary, copyright_notice) VALUES
  ('ESV', 'English Standard Version', 'files', 'Owner-supplied ESV.org files for local reading.',
   'Scripture text from ESV.org. English Standard Version. Copyright Crossway.');
