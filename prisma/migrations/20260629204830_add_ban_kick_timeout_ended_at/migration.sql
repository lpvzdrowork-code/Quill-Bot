-- AlterTable
ALTER TABLE "Timeout" ADD COLUMN     "endedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Ban" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "deleteDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ban_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kick" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Kick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Ban_guildId_userId_idx" ON "Ban"("guildId", "userId");

-- CreateIndex
CREATE INDEX "Kick_guildId_userId_idx" ON "Kick"("guildId", "userId");
