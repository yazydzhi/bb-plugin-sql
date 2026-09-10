-- @conn docker-bb-sql-test
-- Query parameters example (0.4.2)
-- Put the caret on a statement (or select it) and press Run / ⌘Enter.
-- A dialog asks for each :name. Session remembers last values.
--
-- Tips:
--   :name     → parameter (prompted)
--   ::int     → Postgres cast (NOT a parameter)
--   null      → SQL NULL
--   42 / true → unquoted number / boolean
--   hello     → becomes 'hello'

-- 1) Simple bind
SELECT :greeting AS message;

-- 2) Number + cast (only :min_id is prompted)
SELECT :min_id::int AS as_int;

-- 3) Filter the smoke table
SELECT id, note
FROM smoke
WHERE id >= :min_id
  AND note ILIKE '%' || :needle || '%'
ORDER BY id
LIMIT :limit_n;

-- 4) Same name reused — prompted once
SELECT :needle AS a, :needle AS b;

-- 5) :name inside a string is NOT a parameter
SELECT ':needle looks literal' AS not_a_param, :needle AS real_param;
