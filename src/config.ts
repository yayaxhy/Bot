import 'dotenv/config';

function parseCsvIds(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export const CONFIG = {
  token: process.env.DISCORD_TOKEN!,
  clientId: process.env.DISCORD_CLIENT_ID!,
  allowedRoleIds: new Set(parseCsvIds(process.env.ALLOWED_ROLE_IDS))
};

if (!CONFIG.token || !CONFIG.clientId) {
  throw new Error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
}
