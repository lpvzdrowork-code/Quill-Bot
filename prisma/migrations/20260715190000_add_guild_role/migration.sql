-- CreateTable
CREATE TABLE "GuildRole" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "roleType" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuildRole_guildId_idx" ON "GuildRole"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildRole_guildId_roleType_key" ON "GuildRole"("guildId", "roleType");
