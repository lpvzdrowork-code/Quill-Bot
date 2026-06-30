-- Enforce at most one *active* Blacklist row per guildId+userId at the
-- database level. The app-layer findFirst() check in blacklist.ts is correct
-- but not race-safe under concurrent /blacklist invocations on the same user;
-- this index closes that gap by making the second concurrent insert fail
-- instead of silently creating a duplicate active row.
CREATE UNIQUE INDEX "Blacklist_guildId_userId_active_unique"
ON "Blacklist" ("guildId", "userId")
WHERE "active" = true;

-- Same rationale as above, for Flag.
CREATE UNIQUE INDEX "Flag_guildId_userId_active_unique"
ON "Flag" ("guildId", "userId")
WHERE "active" = true;
