import prisma from '../db/prisma.js';

export type ActivityItem = { title: string; description?: string | null };

export async function getActiveActivities(): Promise<ActivityItem[]> {
  try {
    const rows = await prisma.activity.findMany({
      orderBy: { id: 'desc' },
      select: { title: true, description: true },
    });
    return rows;
  } catch (err) {
    console.error('[activityService] fetch activities failed:', err);
    return [];
  }
}
