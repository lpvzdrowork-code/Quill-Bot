-- CreateTable
CREATE TABLE "Flag" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Flag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Flag_guildId_userId_idx" ON "Flag"("guildId", "userId");

-- CreateIndex
CREATE INDEX "Flag_guildId_userId_active_idx" ON "Flag"("guildId", "userId", "active");
