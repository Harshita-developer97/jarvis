import { Bot, CheckCircle2, Pause, Play, Plus, RotateCcw, Square } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { jarvisApi } from '../lib/api';
import type { AgentItem, TaskItem } from '../types/jarvis';

interface TasksAgentsViewProps {
  mode: 'tasks' | 'agents';
  tasks: TaskItem[];
  agents: AgentItem[];
  onRefresh: () => Promise<void>;
}

export function TasksAgentsView({ mode, tasks, agents, onRefresh }: TasksAgentsViewProps) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [creating, setCreating] = useState(false);

  const [prodItems, setProdItems] = useState<any[]>([]);
  const [overdueCount, setOverdueCount] = useState(0);
  const [prodTitle, setProdTitle] = useState('');
  const [prodType, setProdType] = useState<'task' | 'reminder' | 'event' | 'note' | 'goal'>('task');
  const [recentRuns, setRecentRuns] = useState<any[]>([]);

  const loadExtra = async () => {
    const [prod, ag] = await Promise.all([
      jarvisApi.getProductivity('all'),
      jarvisApi.listAgents(),
    ]);
    setProdItems(prod.items || []);
    setOverdueCount(prod.overdueCount || 0);
    setRecentRuns(ag.recentRuns || []);
  };

  useEffect(() => {
    void loadExtra();
  }, [mode]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !goal.trim()) return;
    setCreating(true);
    try {
      await jarvisApi.createTask({ title: title.trim(), goal: goal.trim(), priority: 2 });
      setTitle('');
      setGoal('');
      await onRefresh();
    } finally {
      setCreating(false);
    }
  };

  const handleCreateProd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prodTitle.trim()) return;
    await jarvisApi.createProductivityItem({
      itemType: prodType,
      title: prodTitle.trim(),
      priority: 'medium',
    });
    setProdTitle('');
    await loadExtra();
  };

  if (mode === 'agents') {
    return (
      <div className="space-y-8 p-6">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#1F2937]">
            Multi-Agent Intelligence Roster ({agents.length})
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Sequential 8GB-RAM-aware orchestration. Only relevant agents activate per objective.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <div key={agent.role} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-[#FF7A00]" />
                    <span className="font-display text-sm font-semibold text-[#1F2937]">
                      {agent.displayName}
                    </span>
                  </div>
                  <span
                    className={`text-xs font-medium ${
                      agent.status === 'active' ? 'text-[#FF7A00]' : 'text-slate-500'
                    }`}
                  >
                    {agent.status}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-600">{agent.description}</p>
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs text-slate-500 tabular-nums">
                  <span>Tools: {agent.allowedTools.join(', ')}</span>
                  <span>Runs: {agent.totalRuns}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-slate-200 pt-6">
          <h3 className="font-display text-base font-semibold text-[#1F2937]">
            Recent Agent Executions
          </h3>
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Agent</th>
                  <th className="px-4 py-2.5 font-medium">Step</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {recentRuns.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-4 text-slate-500">
                      No agent executions recorded yet.
                    </td>
                  </tr>
                ) : (
                  recentRuns.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-medium text-[#1F2937]">{r.agent_role}</td>
                      <td className="px-4 py-2.5 text-slate-600">{r.input_summary}</td>
                      <td className="px-4 py-2.5 text-slate-600">{r.status}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500">
                        {r.duration_ms}ms
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Launch Autonomous Task */}
        <form
          onSubmit={handleCreateTask}
          className="rounded-lg border border-slate-200 bg-white p-5"
        >
          <h2 className="font-display text-base font-semibold text-[#1F2937]">
            Launch Autonomous Multi-Step Task
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Creates a checkpointed SQLite task plan and executes assigned agents sequentially.
          </p>
          <div className="mt-4 space-y-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title (e.g., Audit workspace and run tests)"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            <textarea
              rows={2}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Detailed objective for the orchestrator..."
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            <button
              type="submit"
              disabled={creating || !title.trim() || !goal.trim()}
              className="flex items-center gap-1.5 rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Queue &amp; Execute Task</span>
            </button>
          </div>
        </form>

        {/* Personal Productivity Quick Capture */}
        <form
          onSubmit={handleCreateProd}
          className="rounded-lg border border-slate-200 bg-white p-5"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-[#1F2937]">
              Personal Productivity
            </h2>
            <span className="text-xs text-slate-500 tabular-nums">
              Overdue: {overdueCount} · Total: {prodItems.length}
            </span>
          </div>
          <div className="mt-4 flex gap-2">
            <select
              value={prodType}
              onChange={(e) => setProdType(e.target.value as any)}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs"
            >
              <option value="task">Task</option>
              <option value="reminder">Reminder</option>
              <option value="event">Calendar Event</option>
              <option value="note">Note</option>
              <option value="goal">Goal</option>
            </select>
            <input
              value={prodTitle}
              onChange={(e) => setProdTitle(e.target.value)}
              placeholder="Add task, reminder, note, or goal..."
              className="flex-1 rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-md bg-[#1F2937] px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Add
            </button>
          </div>

          <div className="mt-4 max-h-40 space-y-2 overflow-y-auto">
            {prodItems.slice(0, 8).map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between border-b border-slate-100 pb-2 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() =>
                      void jarvisApi
                        .updateProductivityStatus(item.id, item.status === 'done' ? 'open' : 'done')
                        .then(loadExtra)
                    }
                    className="text-slate-400 hover:text-[#16A34A]"
                  >
                    <CheckCircle2
                      className={`h-4 w-4 ${item.status === 'done' ? 'text-[#16A34A]' : ''}`}
                    />
                  </button>
                  <span
                    className={`truncate ${
                      item.status === 'done' ? 'line-through text-slate-400' : 'text-[#1F2937]'
                    }`}
                  >
                    {item.title}
                  </span>
                </div>
                <span className="shrink-0 text-slate-400">
                  {item.itemType} · {item.priority}
                </span>
              </div>
            ))}
          </div>
        </form>
      </div>

      {/* Autonomous Tasks History & Step Logs */}
      <div>
        <h3 className="font-display text-base font-semibold text-[#1F2937]">
          Task Execution Ledger ({tasks.length})
        </h3>
        <div className="mt-3 space-y-3">
          {tasks.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
              No autonomous tasks executed yet.
            </div>
          ) : (
            tasks.map((task) => (
              <div key={task.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-display text-sm font-semibold text-[#1F2937]">
                      {task.title}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                      Status: {task.status} · Progress: {task.progress}% · Agents:{' '}
                      {task.assignedAgents.join(', ')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {task.status === 'running' && (
                      <button
                        type="button"
                        onClick={() => void jarvisApi.controlTask(task.id, 'pause').then(onRefresh)}
                        className="flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                      >
                        <Pause className="h-3 w-3" /> Pause
                      </button>
                    )}
                    {task.status === 'paused' && (
                      <button
                        type="button"
                        onClick={() => void jarvisApi.controlTask(task.id, 'resume').then(onRefresh)}
                        className="flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                      >
                        <Play className="h-3 w-3" /> Resume
                      </button>
                    )}
                    {(task.status === 'failed' || task.status === 'cancelled') && (
                      <button
                        type="button"
                        onClick={() => void jarvisApi.controlTask(task.id, 'retry').then(onRefresh)}
                        className="flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
                      >
                        <RotateCcw className="h-3 w-3" /> Retry
                      </button>
                    )}
                    {(task.status === 'queued' || task.status === 'running') && (
                      <button
                        type="button"
                        onClick={() => void jarvisApi.controlTask(task.id, 'cancel').then(onRefresh)}
                        className="flex items-center gap-1 rounded border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                      >
                        <Square className="h-3 w-3" /> Cancel
                      </button>
                    )}
                  </div>
                </div>

                {task.steps && task.steps.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                    {task.steps.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between text-xs text-slate-600"
                      >
                        <span>
                          {s.stepOrder}. {s.title} ({s.agentRole})
                        </span>
                        <span className="font-mono text-[11px]">{s.status}</span>
                      </div>
                    ))}
                  </div>
                )}

                {task.resultSummary && (
                  <p className="mt-2.5 text-xs text-slate-600">{task.resultSummary}</p>
                )}
                {task.errorMessage && (
                  <p className="mt-2.5 text-xs text-red-600">{task.errorMessage}</p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
