import { BREAK_DURATIONS_MINUTES, type BreakMinutes } from '@studysync/shared';

interface Props {
  disabled: boolean;
  onPick: (minutes: BreakMinutes) => void;
  onCancel: () => void;
}

/** Exactly the four allowed break lengths (R4). No custom input exists. */
export function BreakPicker({ disabled, onPick, onCancel }: Props) {
  return (
    <div
      role="group"
      aria-label="Choose a break length"
      data-testid="break-picker"
      className="mt-4"
    >
      <p className="text-sm text-slate-600">How long is your break?</p>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {BREAK_DURATIONS_MINUTES.map((minutes) => (
          <button
            key={minutes}
            type="button"
            data-testid={`break-${minutes}`}
            disabled={disabled}
            onClick={() => onPick(minutes)}
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-2 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          >
            {minutes} min
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="mt-2 text-sm text-slate-500 underline hover:text-slate-700"
      >
        Cancel
      </button>
    </div>
  );
}
