export const MIN = 60 * 1000;

export function addMinutes(date: Date, m: number) {
  return new Date(date.getTime() + m * MIN);
}

export function minutesBetweenFloor(start: Date | null | undefined, end: Date | null | undefined): number {
  if (!start || !end) return 0;
  const diff = end.getTime() - start.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / MIN);
}
