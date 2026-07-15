-- CreateTable
CREATE TABLE "SecuritySettings" (
    "guildId" TEXT NOT NULL,
    "antiRaidEnabled" BOOLEAN NOT NULL DEFAULT true,
    "raidJoinThreshold" INTEGER NOT NULL DEFAULT 10,
    "raidWindowSeconds" INTEGER NOT NULL DEFAULT 10,
    "raidAction" TEXT NOT NULL DEFAULT 'lockdown',
    "lockdownMinutes" INTEGER NOT NULL DEFAULT 10,
    "antiNukeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nukeActionThreshold" INTEGER NOT NULL DEFAULT 5,
    "nukeWindowSeconds" INTEGER NOT NULL DEFAULT 60,
    "nukeAction" TEXT NOT NULL DEFAULT 'strip_roles',
    "trustedRoleId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecuritySettings_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "SecurityIncident" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityIncident_guildId_type_idx" ON "SecurityIncident"("guildId", "type");
