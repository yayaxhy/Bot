import prisma from '../db/prisma.js';

export type ActivityItem = { title: string; description?: string | null; type?: string | null };

export async function getActiveActivities(): Promise<ActivityItem[]> {
  try {
    const rows = await prisma.activity.findMany({
      orderBy: { title: 'desc' },
      select: { title: true, description: true, type: true },
    });
    return rows;
  } catch (err) {
    console.error('[activityService] fetch activities failed:', err);
    return [];
  }
}
