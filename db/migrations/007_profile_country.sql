-- Profile setup asks "Country / region" (client change, Oct 2026): ISO 3166-1 alpha-2, upper case ("IN", "US", "GB").
-- Belongs to the playable profile. Private like the DOB: returned only to the profile's own account (GET /me,
-- profile responses), never on leaderboards, public views or admin lists, never logged. NULL for profiles created
-- before the question existed.
ALTER TABLE profiles
  ADD COLUMN country CHAR(2) NULL AFTER mode;
