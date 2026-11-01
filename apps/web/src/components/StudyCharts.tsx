/**
 * Study charts (roadmap 3.2, 4.1): weekly / monthly stacked bars (Solo vs Rooms) and the local
 * weekday × hour heatmap. Plain HTML/CSS (no chart library): thin bars with 4 px rounded ends,
 * a 2 px gap between stacked segments, a legend, hover titles, and a table view for screen
 * readers and exact values. Colors: validated categorical slots 1–2 and the blue sequential
 * ramp (see docs/phase-3 report).
 */
import { useState } from 'react';
import type { HeatmapDto, PeriodStatsDto } from '@studysync/shared';
import { formatTotal } from './ui';

const SOLO = '#2a78d6';
const ROOMS = '#eb6834';
/** Blue sequential ramp, light → dark (magnitude). Index 0 = no study. */
const RAMP = ['#f1f5f9', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#104281'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function periodLabel(start: string, granularity: 'week' | 'month'): string {
  const month = MONTHS[Number(start.slice(5, 7)) - 1] ?? '';
  return granularity === 'month'
    ? `${month} ${start.slice(2, 4)}`
    : `${month} ${Number(start.slice(8))}`;
}

function Legend() {
  return (
    <p className="flex gap-4 text-xs text-slate-600" aria-hidden="true">
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-sm" style={{ background: SOLO }} /> Solo
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-sm" style={{ background: ROOMS }} /> Rooms
      </span>
    </p>
  );
}

/** Stacked bars per week or month; the y scale is shared by all bars (one axis). */
export function PeriodChart({ data }: { data: PeriodStatsDto }) {
  const max = Math.max(1, ...data.periods.map((p) => p.totalMs));
  const best = data.periods.reduce((b, p) => (p.totalMs > b.totalMs ? p : b), data.periods[0]!);
  return (
    <figure className="space-y-2" data-testid={`chart-${data.granularity}`}>
      <Legend />
      <div
        className="flex h-40 items-end gap-1 border-b border-slate-200"
        role="img"
        aria-label={`${data.granularity === 'week' ? 'Weekly' : 'Monthly'} study time, solo and in rooms. Exact values are in the table below.`}
      >
        {data.periods.map((p) => (
          <div
            key={p.start}
            className="flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px]"
            title={`${periodLabel(p.start, data.granularity)}: ${formatTotal(p.totalMs)} (solo ${formatTotal(p.soloMs)}, rooms ${formatTotal(p.roomsMs)}) · ${p.qualifiedDays} streak day${p.qualifiedDays === 1 ? '' : 's'}`}
            data-testid="period-bar"
            data-total-ms={p.totalMs}
          >
            {p.roomsMs > 0 && (
              <div
                className="w-full rounded-t"
                style={{ height: `${(p.roomsMs / max) * 100}%`, background: ROOMS }}
              />
            )}
            {p.soloMs > 0 && (
              <div
                className={`w-full ${p.roomsMs > 0 ? '' : 'rounded-t'}`}
                style={{ height: `${(p.soloMs / max) * 100}%`, background: SOLO }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-1 text-[10px] text-slate-500" aria-hidden="true">
        {data.periods.map((p, i) => (
          <span key={p.start} className="min-w-0 flex-1 truncate text-center">
            {i % 2 === 0 || data.periods.length <= 8 ? periodLabel(p.start, data.granularity) : ''}
          </span>
        ))}
      </div>
      {best && best.totalMs > 0 && (
        <figcaption className="text-xs text-slate-500">
          Best {data.granularity}: {periodLabel(best.start, data.granularity)} ·{' '}
          {formatTotal(best.totalMs)}
        </figcaption>
      )}
      <DataTable
        headers={[
          data.granularity === 'week' ? 'Week of' : 'Month',
          'Solo',
          'Rooms',
          'Total',
          'Streak days',
        ]}
        rows={data.periods.map((p) => [
          p.start,
          formatTotal(p.soloMs),
          formatTotal(p.roomsMs),
          formatTotal(p.totalMs),
          String(p.qualifiedDays),
        ])}
      />
    </figure>
  );
}

/** Weekday × hour grid in the user's local time (each segment's own timezone snapshot). */
export function Heatmap({ data }: { data: HeatmapDto }) {
  const cells = new Map(data.cells.map((c) => [`${c.weekday}:${c.hour}`, c.studyMs]));
  const max = Math.max(1, ...data.cells.map((c) => c.studyMs));
  const step = (ms: number) =>
    ms <= 0 ? 0 : Math.min(RAMP.length - 1, 1 + Math.floor((ms / max) * (RAMP.length - 1)));
  return (
    <figure className="space-y-2" data-testid="heatmap">
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: '2rem repeat(24, minmax(0, 1fr))' }}
        role="img"
        aria-label="Study time by weekday and hour. Exact values are in the table below."
      >
        {WEEKDAYS.map((day, w) => (
          <Row key={day} day={day}>
            {Array.from({ length: 24 }, (_, hour) => {
              const ms = cells.get(`${w + 1}:${hour}`) ?? 0;
              return (
                <div
                  key={hour}
                  className="aspect-square rounded-[2px]"
                  style={{ background: RAMP[step(ms)] }}
                  title={`${day} ${String(hour).padStart(2, '0')}:00 · ${formatTotal(ms)}`}
                  data-testid="heatmap-cell"
                  data-study-ms={ms}
                />
              );
            })}
          </Row>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="text-center text-[10px] text-slate-500" aria-hidden="true">
            {hour % 6 === 0 ? hour : ''}
          </span>
        ))}
      </div>
      <p className="flex items-center gap-1 text-xs text-slate-500" aria-hidden="true">
        Less
        {RAMP.map((c) => (
          <span key={c} className="inline-block h-3 w-3 rounded-[2px]" style={{ background: c }} />
        ))}
        More
      </p>
      <DataTable
        headers={['Weekday', 'Hour', 'Study']}
        rows={data.cells.map((c) => [
          WEEKDAYS[c.weekday - 1] ?? String(c.weekday),
          `${String(c.hour).padStart(2, '0')}:00`,
          formatTotal(c.studyMs),
        ])}
      />
    </figure>
  );
}

function Row({ day, children }: { day: string; children: React.ReactNode }) {
  return (
    <>
      <span className="self-center text-[10px] text-slate-500">{day}</span>
      {children}
    </>
  );
}

/** The table view of a chart (exact values; screen readers). */
function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="text-xs text-indigo-700 underline"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide table' : 'Show table'}
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h} className="py-1 pr-2 font-semibold text-slate-600">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} className="py-1 text-slate-500">
                    No study recorded in this range.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.join('|')} className="border-t border-slate-100">
                    {r.map((cell, i) => (
                      <td key={i} className="py-1 pr-2 font-mono">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
