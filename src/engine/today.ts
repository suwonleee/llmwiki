// "What day is it for the person writing this page?"
//
// The wiki is a human logbook, so every date a reader compares against their own calendar — a
// page's `date:`, a log entry, a quiz due date, a ledger stamp — has to be the local calendar
// date. `new Date().toISOString().slice(0, 10)` answers a different question (which day it is in
// UTC) and is wrong for almost everyone: in New Zealand (UTC+12) local mornings are still
// yesterday in UTC, so most of a working day gets filed under the wrong date; in California
// (UTC-7) every evening is already tomorrow. Korea and Japan (UTC+9) lose the hours before 09:00.
//
// Machine timestamps stay UTC — an instant written for a program to compare (maintenance state,
// benchmark filenames) has no calendar to be wrong about. This is only for calendar dates.
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Calendar arithmetic on a date-only string. Deliberately UTC internally: a date with no time of
// day has no DST to cross, and anchoring both ends at UTC midnight keeps "+7 days" exact.
export function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}
