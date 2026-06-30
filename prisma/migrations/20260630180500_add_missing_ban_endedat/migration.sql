-- The migration "20260629204830_add_ban_kick_timeout_ended_at" added `endedAt`
-- to Timeout but, despite its name, never actually added it to Ban (the table
-- was created fresh in that same migration without the column). schema.prisma
-- has always declared `endedAt DateTime?` on Ban, so the generated client and
-- the real database have been out of sync since that migration ran. This
-- migration closes the gap without touching the already-applied history file.

-- AlterTable
ALTER TABLE "Ban" ADD COLUMN "endedAt" TIMESTAMP(3);
