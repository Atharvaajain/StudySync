import { useState, type FormEvent } from 'react';
import type { TaskDto } from '@studysync/shared';
import { Card, ErrorNote, inputClass, primaryButton } from './ui';

interface Props {
  tasks: TaskDto[];
  error: string | null;
  onDismissError: () => void;
  onAdd: (input: {
    title: string;
    description: string | null;
    dueDate: string | null;
  }) => Promise<unknown>;
  onToggle: (taskId: string, done: boolean) => Promise<void>;
  onUpdate: (
    task: TaskDto,
    patch: { title: string; description: string | null; dueDate: string | null },
  ) => Promise<boolean>;
  onDelete: (taskId: string) => Promise<void>;
  /** Card title ("My tasks" or "Room tasks"). */
  heading?: string;
  /** Room tasks: show who added / completed each task. */
  showPeople?: boolean;
  /** Room tasks: only the task creator or the room creator may delete (I-16). */
  canDelete?: (task: TaskDto) => boolean;
}

/** Personal or room tasks (F-25–F-27, R8). Tasks never affect study time (F-28). */
export function TaskList({
  tasks,
  error,
  onDismissError,
  onAdd,
  onToggle,
  onUpdate,
  onDelete,
  heading = 'My tasks',
  showPeople = false,
  canDelete = () => true,
}: Props) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const added = await onAdd({
      title: title.trim(),
      description: description.trim() || null,
      dueDate: dueDate || null,
    });
    if (added) {
      setTitle('');
      setDueDate('');
      setDescription('');
    }
  };

  return (
    <Card title={heading} testId="tasks">
      <ErrorNote message={error} onDismiss={onDismissError} />
      <form onSubmit={(e) => void submit(e)} className="mt-2 space-y-2" aria-label="Add a task">
        <div className="flex gap-2">
          <input
            aria-label="Task title"
            data-testid="task-title-input"
            className={inputClass}
            placeholder="Add a task…"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            aria-label="Due date"
            data-testid="task-due-input"
            type="date"
            className={`${inputClass} w-40`}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <button type="submit" data-testid="task-add" className={primaryButton}>
            Add
          </button>
        </div>
        <input
          aria-label="Task description"
          className={`${inputClass} text-sm`}
          placeholder="Description (optional)"
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </form>

      {tasks.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No tasks yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100" data-testid="task-list">
          {tasks.map((task) =>
            editing === task.id ? (
              <TaskEditor
                key={task.id}
                task={task}
                onCancel={() => setEditing(null)}
                onSave={async (patch) => {
                  if (await onUpdate(task, patch)) setEditing(null);
                }}
              />
            ) : (
              <li
                key={task.id}
                data-testid="task-row"
                data-task-title={task.title}
                data-status={task.status}
                className="flex items-start justify-between gap-3 py-2"
              >
                <label className="flex flex-1 items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    data-testid="task-toggle"
                    checked={task.status === 'DONE'}
                    onChange={(e) => void onToggle(task.id, e.target.checked)}
                  />
                  <span>
                    <span
                      className={
                        task.status === 'DONE' ? 'text-slate-400 line-through' : 'text-slate-900'
                      }
                    >
                      {task.title}
                    </span>
                    {task.dueDate && (
                      <span className="ml-2 text-xs text-slate-500">due {task.dueDate}</span>
                    )}
                    {task.description && (
                      <span className="block text-xs text-slate-500">{task.description}</span>
                    )}
                    {showPeople && (
                      <span className="block text-xs text-slate-400" data-testid="task-people">
                        added by {task.createdBy.name}
                        {task.completedBy ? ` · ✓ by ${task.completedBy.name}` : ''}
                      </span>
                    )}
                  </span>
                </label>
                <span className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="text-slate-600 underline"
                    onClick={() => setEditing(task.id)}
                  >
                    Edit
                  </button>
                  {canDelete(task) && (
                    <button
                      type="button"
                      data-testid="task-delete"
                      className="text-red-700 underline"
                      onClick={() => void onDelete(task.id)}
                    >
                      Delete
                    </button>
                  )}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}

function TaskEditor({
  task,
  onSave,
  onCancel,
}: {
  task: TaskDto;
  onSave: (patch: {
    title: string;
    description: string | null;
    dueDate: string | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  return (
    <li className="space-y-2 py-2" data-testid="task-editor">
      <input
        aria-label="Edit title"
        className={inputClass}
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        aria-label="Edit description"
        className={`${inputClass} text-sm`}
        maxLength={2000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          aria-label="Edit due date"
          type="date"
          className={`${inputClass} w-40`}
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
        <button
          type="button"
          className={primaryButton}
          disabled={!title.trim()}
          onClick={() =>
            void onSave({
              title: title.trim(),
              description: description.trim() || null,
              dueDate: dueDate || null,
            })
          }
        >
          Save
        </button>
        <button type="button" className="text-sm text-slate-600 underline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </li>
  );
}
