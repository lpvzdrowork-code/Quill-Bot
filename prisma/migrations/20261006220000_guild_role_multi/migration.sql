-- A role slot may now hold several roles (e.g. "applications"), so uniqueness
-- moves from (guildId, roleType) to (guildId, roleType, roleId). Existing rows
-- are one role per slot, so they satisfy the new constraint unchanged.

-- DropIndex
DROP INDEX "GuildRole_guildId_roleType_key";

-- CreateIndex
CREATE UNIQUE INDEX "GuildRole_guildId_roleType_roleId_key" ON "GuildRole"("guildId", "roleType", "roleId");
