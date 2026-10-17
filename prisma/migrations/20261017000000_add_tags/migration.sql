-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tag_guildId_idx" ON "Tag"("guildId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_guildId_name_key" ON "Tag"("guildId", "name");
