-- Independent ("adult") accounts give their date of birth first, as a neutral age gate (contract 4.1), and choose
-- their username and avatar later (POST /me/profile). The DOB waits here only until that profile is created; it is
-- then moved to profiles.dob and cleared from the account. It is never returned by any endpoint.
-- Parent accounts never store a DOB here.
ALTER TABLE accounts ADD COLUMN dob DATE NULL AFTER preferred_language;
