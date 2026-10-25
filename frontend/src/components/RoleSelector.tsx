"use client";

import { Bot, Code2, Kanban, LineChart, Lock, Shield, type LucideIcon } from "lucide-react";
import type { RoleConfig } from "@/lib/api";

export type InterviewMode = "behavioral" | "technical";

interface RoleSelectorProps {
  roles: RoleConfig[];
  selectedRole: string;
  mode: InterviewMode;
  onRoleChange: (role: string) => void;
  onModeChange: (mode: InterviewMode) => void;
}

const ROLE_META: Record<string, { icon: LucideIcon; blurb: string }> = {
  "Software Engineer": {
    icon: Code2,
    blurb: "Incidents, design tradeoffs, and the path a request takes.",
  },
  "Data Scientist": {
    icon: LineChart,
    blurb: "Metrics, experiments, and decisions that came from evidence.",
  },
  "AI Engineer": {
    icon: Bot,
    blurb: "Models, latency, and answers you can actually evaluate.",
  },
  "Product Manager": {
    icon: Kanban,
    blurb: "Scope, customers, and whether the feature worked.",
  },
};

export default function RoleSelector({
  roles,
  selectedRole,
  mode,
  onRoleChange,
  onModeChange,
}: RoleSelectorProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-medium text-slate-100">Choose a role</h2>
          <p className="text-sm text-slate-400">Built-in questions, plus any the interviewer adds below.</p>
        </div>
        <div
          role="radiogroup"
          aria-label="Question mode"
          className="inline-flex rounded-full border border-white/10 bg-slate-950/70 p-1"
        >
          {(["behavioral", "technical"] as const).map((item) => {
            const selected = mode === item;
            return (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onModeChange(item)}
                className={`rounded-full px-4 py-2 text-sm capitalize ${
                  selected ? "bg-indigo-500 text-white" : "text-slate-300"
                }`}
              >
                {item}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {roles.map((item) => {
          const selected = item.role === selectedRole;
          const meta = ROLE_META[item.role];
          const Icon = meta?.icon ?? Code2;
          return (
            <button
              key={item.role}
              type="button"
              aria-pressed={selected}
              onClick={() => onRoleChange(item.role)}
              className={`rounded-3xl border p-4 text-left shadow-lg shadow-black/20 backdrop-blur transition ${
                selected
                  ? "border-emerald-400/60 bg-emerald-400/10"
                  : "border-white/10 bg-white/5 hover:border-indigo-400/40"
              }`}
            >
              <span
                className={`mb-3 flex h-10 w-10 items-center justify-center rounded-2xl ${
                  selected ? "bg-emerald-500 text-slate-950" : "bg-slate-950/80 text-indigo-300"
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="block text-base font-medium text-slate-100">{item.role}</span>
              <span className="mt-1 block text-sm text-slate-400">
                {meta?.blurb ?? "Questions added by the interviewer."}
              </span>
              <span className="mt-3 block text-xs uppercase tracking-wide text-slate-500">
                {item.behavioral.length} behavioral · {item.technical.length} technical
              </span>
            </button>
          );
        })}
      </div>

      <aside className="rounded-3xl border border-indigo-400/30 bg-indigo-500/10 p-5 backdrop-blur">
        <div className="flex items-center gap-2 text-indigo-200">
          <Shield className="h-4 w-4" aria-hidden />
          <h3 className="text-sm font-medium uppercase tracking-wide">Open-Source AI Architecture</h3>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-200">
          The recording stays in this browser. Groq scores the transcript text when an API key is set. Gemma 2B
          through local Ollama is the fallback once that model is installed.
        </p>
        <p className="mt-3 flex items-center gap-2 text-xs text-indigo-200">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Audio stays in the browser · Groq sees the transcript text
        </p>
      </aside>
    </section>
  );
}
