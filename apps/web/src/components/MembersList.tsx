import {
  breakRemainingMs,
  displayMemberStatus,
  formatCountdown,
  type MemberStatusDto,
  type RoomStatus,
} from '@studysync/shared';

const STATUS_META: Record<RoomStatus, { icon: string; label: string; tone: string }> = {
  STUDYING: { icon: '🟢', label: 'Studying', tone: 'text-emerald-700' },
  ON_BREAK: { icon: '🟡', label: 'On Break', tone: 'text-amber-700' },
  IDLE: { icon: '⚪', label: 'Idle', tone: 'text-slate-600' },
  OFFLINE: { icon: '⚫', label: 'Offline', tone: 'text-slate-400' },
};

interface Props {
  members: MemberStatusDto[];
  myUserId: string;
  now: number;
}

/** Each member's OWN status, rendered from their own data. There is no room timer (R2). */
export function MembersList({ members, myUserId, now }: Props) {
  return (
    <section aria-labelledby="members-heading" className="rounded-lg bg-white p-4 shadow-sm">
      <h2
        id="members-heading"
        className="text-xs font-semibold uppercase tracking-wide text-slate-500"
      >
        Members
      </h2>
      <ul className="mt-2 divide-y divide-slate-100" data-testid="members-list">
        {members.map((m) => {
          const status = displayMemberStatus(m, now);
          const meta = STATUS_META[status];
          const countdown =
            status === 'ON_BREAK' && m.breakEndsAt
              ? ` ${formatCountdown(breakRemainingMs(m.breakEndsAt, now))}`
              : '';
          return (
            <li
              key={m.user.id}
              data-testid="member-row"
              data-user-name={m.user.name}
              data-status={status}
              className="flex items-center justify-between py-2"
            >
              <span className="flex items-center gap-2 text-slate-900">
                <span aria-hidden="true">{meta.icon}</span>
                <span className="font-medium">{m.user.name}</span>
                {m.user.id === myUserId && <span className="text-xs text-slate-400">(you)</span>}
              </span>
              <span className={`text-sm ${meta.tone}`} data-testid="member-status">
                {meta.label}
                {countdown}
                {m.reconnecting && (
                  <span className="ml-1 text-xs text-slate-400">· reconnecting…</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
