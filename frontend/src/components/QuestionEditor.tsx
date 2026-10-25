"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AddedQuestion } from "@/lib/api";
import type { InterviewMode } from "@/components/RoleSelector";

interface QuestionEditorProps {
  role: string;
  mode: InterviewMode;
  roles: string[];
  added: AddedQuestion[];
  onAdd: (question: AddedQuestion) => void;
  onRemove: (id: string) => void;
}

export default function QuestionEditor({ role, mode, roles, added, onAdd, onRemove }: QuestionEditorProps) {
  const [draftRole, setDraftRole] = useState(role);
  const [newRole, setNewRole] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    setDraftRole(role);
  }, [role]);

  const visible = added.filter(
    (item) => item.role.toLowerCase() === role.toLowerCase() && item.mode === mode,
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const roleName = (draftRole === "__new__" ? newRole : draftRole).trim();
    const question = text.trim();
    if (!roleName || !question) return;
    onAdd({
      id: crypto.randomUUID(),
      role: roleName,
      mode,
      text: question,
    });
    setText("");
    setNewRole("");
  }

  return (
    <section className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/20 backdrop-blur sm:p-6">
      <div>
        <h2 className="text-lg font-medium text-slate-100">Add a question</h2>
        <p className="mt-1 text-sm text-slate-400">
          Saved in this browser for the {mode} round. Built-in questions stay in place.
        </p>
      </div>

      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
          <label className="flex flex-col gap-2 text-xs uppercase tracking-wide text-slate-400">
            Role
            <select
              value={roles.includes(draftRole) ? draftRole : "__new__"}
              onChange={(event) => setDraftRole(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm capitalize text-slate-100 outline-none ring-emerald-400/40 focus:ring-2"
            >
              {roles.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
              <option value="__new__">New role</option>
            </select>
          </label>
          {draftRole === "__new__" || !roles.includes(draftRole) ? (
            <label className="flex flex-col gap-2 text-xs uppercase tracking-wide text-slate-400">
              New role name
              <input
                value={newRole}
                onChange={(event) => setNewRole(event.target.value)}
                placeholder="Customer support"
                className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-emerald-400/40 placeholder:text-slate-500 focus:ring-2"
              />
            </label>
          ) : (
            <p className="self-end pb-2 text-sm text-slate-400">
              This question is added to <span className="text-slate-100">{draftRole}</span>, {mode}.
            </p>
          )}
        </div>

        <label className="flex flex-col gap-2 text-xs uppercase tracking-wide text-slate-400">
          Question
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            required
            placeholder="Tell me about a time you handled a customer who was already upset."
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-emerald-400/40 placeholder:text-slate-500 focus:ring-2"
          />
        </label>

        <button
          type="submit"
          className="inline-flex w-fit items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add question
        </button>
      </form>

      {visible.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-2">
          {visible.map((item) => (
            <li
              key={item.id}
              className="flex items-start justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-3 py-3"
            >
              <p className="text-sm leading-6 text-slate-100">{item.text}</p>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-rose-200"
                aria-label="Remove question"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
