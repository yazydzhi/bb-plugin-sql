-- @conn docker-bb-sql-test
-- Smoke for multi-statement editor (0.4.1):
-- caret + Run → one statement under the caret.
-- select several statements + Run → each runs separately, in order
-- (one result tab per statement; stops on first error).

SELECT 1 AS first;

-- semicolon inside a string must stay in this statement
SELECT 'semi;inside' AS second;

SELECT 3 AS third;

-- line comment with a fake ; should not split
SELECT 'after-comment' AS fourth; -- ignore; me

/* block comment; with semicolon
   still one statement */
SELECT 5 AS fifth;

-- dollar-quote body may contain ;
SELECT $$hello; world$$ AS sixth;

SELECT $tag$
line 1;
line 2;
$tag$ AS seventh;

-- works against the docker smoke table
SELECT id, note
FROM smoke
ORDER BY id
LIMIT 10;

SELECT count(*)::int AS smoke_rows
FROM smoke;

SELECT current_database() AS db,
       current_user AS usr,
       now() AS ts;
