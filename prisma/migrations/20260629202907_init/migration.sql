-- CreateTable
CREATE TABLE "Warn" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Warn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timeout" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Timeout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Warn_guildId_userId_idx" ON "Warn"("guildId", "userId");

-- CreateIndex
CREATE INDEX "Timeout_guildId_userId_idx" ON "Timeout"("guildId", "userId");
