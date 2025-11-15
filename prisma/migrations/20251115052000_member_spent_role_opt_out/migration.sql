-- Add opt-out flag for auto-spent roles
ALTER TABLE "Member"
ADD COLUMN IF NOT EXISTS "VIPRoleOptOut" BOOLEAN NOT NULL DEFAULT false;
