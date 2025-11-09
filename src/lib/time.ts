export const MIN = 60 * 1000;

export function addMinutes(date: Date, m: number) {
  return new Date(date.getTime() + m * MIN);
}
