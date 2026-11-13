-- begin the transaction, this will allow you to rollback any changes made during the test
BEGIN;

-- plan your test in advance, this ensures the proper number of tests have been run.
SELECT plan(1);

-- run your test
SELECT ok(true, 'test passed');

-- check the results of your test
SELECT *
FROM
    finish();

-- rollback the transaction, completing the test scenario
ROLLBACK;
