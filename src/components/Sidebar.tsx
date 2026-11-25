import {
  Activity,
  Bot,
  Briefcase,
  CheckSquare,
  Code2,
  Database,
  FolderGit2,
  Globe,
  MessageSquare,
  Plus,
  Settings,
  Smartphone,
  Workflow,
  X,
} from 'lucide-react';
import React from 'react';
import type { Conversation, NavSection } from '../types/jarvis';

interface SidebarProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'workspace', label: 'Workspace', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'tasks', label: 'Tasks & Planner', icon: CheckSquare },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'memory', label: 'Memory Brain', icon: Database },
  { id: 'research', label: 'Research & Browser', icon: Globe },
  { id: 'engineer', label: 'Software Engineer', icon: Code2 },
  { id: 'business', label: 'Business Manager', icon: Briefcase },
  { id: 'automations', label: 'Automations', icon: Workflow },
  { id: 'devices', label: 'Devices', icon: Smartphone },
  { id: 'health', label: 'System Health', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({
  activeSection,
  onSelectSection,
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/25 lg:hidden"
          onClick={onCloseMobile}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-slate-50/70 transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0 bg-white' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#1F2937] text-xs font-bold text-white">
              J
            </div>
            <span className="font-display text-base font-bold tracking-tight text-[#1F2937]">
              JARVIS
            </span>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200/70 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={() => {
              onNewConversation();
              onSelectSection('workspace');
              onCloseMobile();
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#FF7A00] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#e56d00] whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>New Conversation</span>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-4" aria-label="Main navigation">
          <div className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectSection(item.id);
                    onCloseMobile();
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    active
                      ? 'bg-white font-semibold text-[#1F2937] border border-slate-200'
                      : 'text-slate-600 hover:bg-slate-200/50 hover:text-[#1F2937] border border-transparent'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${active ? 'text-[#FF7A00]' : 'text-slate-400'}`}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 border-t border-slate-200 pt-4">
            <div className="px-3 pb-2 text-xs font-medium text-slate-500">
              Recent Conversations
            </div>
            {conversations.length === 0 ? (
              <p className="px-3 py-1.5 text-xs text-slate-400">No conversations yet.</p>
            ) : (
              <div className="space-y-0.5">
                {conversations.slice(0, 12).map((conv) => {
                  const isCurrent = conv.id === activeConversationId && activeSection === 'workspace';
                  return (
                    <button
                      key={conv.id}
                      type="button"
                      onClick={() => {
                        onSelectConversation(conv.id);
                        onSelectSection('workspace');
                        onCloseMobile();
                      }}
                      className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-xs transition-colors ${
                        isCurrent
                          ? 'bg-white font-medium text-[#1F2937] border border-slate-200'
                          : 'text-slate-600 hover:bg-slate-200/50 border border-transparent'
                      }`}
                    >
                      <span className="truncate">{conv.title}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </nav>
      </aside>
    </>
  );
}
