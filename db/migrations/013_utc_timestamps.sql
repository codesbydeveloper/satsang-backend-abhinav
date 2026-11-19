-- All DATETIMEs are UTC (19 Nov 2026). Until now the pool did not set the MySQL session time zone, so every value
-- filled by DEFAULT CURRENT_TIMESTAMP / ON UPDATE CURRENT_TIMESTAMP (created_at, updated_at, requested_at) was
-- stored in the database server's local zone (IST on the dev machine: 5h30 ahead), while values the code writes
-- with UTC_TIMESTAMP() or toSql() were already UTC. That showed e.g. REQUESTED 23:02 vs HANDLED 17:32 for one moment.
-- src/db.js now sets time_zone = '+00:00' on every connection. This migration moves the existing default-filled
-- values from the server's zone to UTC. scripts/migrate.js does not set the session zone, so @@session.time_zone is
-- the server default the old rows were written in; on a server already running in UTC this changes nothing.
-- Run `npm run migrate` BEFORE starting the new server code, or rows it writes in UTC would be shifted again.
-- Columns the code always writes in UTC (decided_at, consent_at, expires_at, client_at, ...) are not touched.
-- updated_at is assigned explicitly in each UPDATE so ON UPDATE CURRENT_TIMESTAMP does not overwrite it.

SET @from_tz = @@session.time_zone;

UPDATE accounts SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00'), updated_at = CONVERT_TZ(updated_at, @from_tz, '+00:00');
UPDATE profiles SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00'), updated_at = CONVERT_TZ(updated_at, @from_tz, '+00:00');
UPDATE email_codes SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE refresh_tokens SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE blocked_words SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE admins SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE audit_log SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE profile_daily_activity SET updated_at = CONVERT_TZ(updated_at, @from_tz, '+00:00');
UPDATE account_deletion_requests SET requested_at = CONVERT_TZ(requested_at, @from_tz, '+00:00');
UPDATE signup_bonuses SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE explore_imports SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE explore_import_items SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE referrals SET created_at = CONVERT_TZ(created_at, @from_tz, '+00:00');
UPDATE app_settings SET updated_at = CONVERT_TZ(updated_at, @from_tz, '+00:00');
