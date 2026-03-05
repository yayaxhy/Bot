CREATE INDEX IF NOT EXISTS "idx_individual_transaction_discord_time_type"
ON "IndividualTransaction" ("discordId", "timeCreatedAt", "typeOfTransaction");
