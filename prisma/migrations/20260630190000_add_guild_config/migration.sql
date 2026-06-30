-- CreateTable
CREATE TABLE "LogChannel" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandChannel" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LogChannel_guildId_idx" ON "LogChannel"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "LogChannel_guildId_category_key" ON "LogChannel"("guildId", "category");

-- CreateIndex
CREATE INDEX "CommandChannel_guildId_idx" ON "CommandChannel"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "CommandChannel_guildId_channelId_key" ON "CommandChannel"("guildId", "channelId");
