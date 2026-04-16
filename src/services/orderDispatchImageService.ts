import prisma from '../db/prisma.js';

function normalizeHttpUrl(value: string | null | undefined) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

export async function getDispatchImageUrlForOwner(ownerId: string) {
  try {
    const profile = await prisma.vipBenefitProfile.findUnique({
      where: { discordUserId: ownerId },
      select: { dispatchImageUrl: true },
    });

    return normalizeHttpUrl(profile?.dispatchImageUrl);
  } catch (err) {
    console.warn('[order-dispatch-image] failed to load dispatch image, falling back to default', {
      ownerId,
      err,
    });
    return null;
  }
}
