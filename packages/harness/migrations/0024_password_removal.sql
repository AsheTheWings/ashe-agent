-- The owner signs in with GitHub, so the owner password and the failed
-- logins that locked it out are removed.
DROP TABLE owner;
DROP TABLE login_failures;
