import { useEffect } from 'react';
import { AvatarFace } from './AvatarFace';
import { AVATAR_STATES, AVATAR_STATE_LABELS } from './avatarState';

/** Prints real rendered geometry so state deltas can be checked as numbers, not vibes. */
function useMeasurements() {
  useEffect(() => {
    const out = document.getElementById('avatar-measurements');
    if (!out) return;
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.avatar')).map((el) => {
      const state = el.dataset.state ?? '?';
      const eye = el.querySelector('.avatar__eye')!.getBoundingClientRect();
      const mouth = el.querySelector('.avatar__mouth')!.getBoundingClientRect();
      const brow = el.querySelector('.avatar__brow--left')!.getBoundingClientRect();
      const f = (n: number) => n.toFixed(1).padStart(6);
      return `${state.padEnd(11)} eye ${f(eye.width)}x${f(eye.height)}   mouth ${f(
        mouth.width,
      )}x${f(mouth.height)}   brow ${f(brow.width)}x${f(brow.height)}`;
    });
    out.textContent = lines.join('\n');
  });
}

/**
 * Dev-only state inspector, reachable at /?avatar-debug.
 *
 * Built as throwaway Step 2 scaffolding and deliberately kept. It renders all five states
 * at once and prints their measured geometry, which is the only way to check the
 * frustrated/angry restraint rule in docs/phase4-scope.md — that rule is comparative
 * ("angry stays ~1.6-1.8x frustrated's displacement from neutral"), so it cannot be
 * verified from one state in isolation, and eyeballing it was already wrong once during
 * Step 2. Both Avatar.css and the scope doc tell a future editor to re-measure here after
 * changing the state values; deleting this would leave those instructions pointing at
 * nothing.
 *
 * Not reachable from the UI and not linked anywhere — it costs a string comparison on
 * `location.search` in App.tsx.
 *
 * ?size=260&only=frustrated,angry narrows it for close comparison.
 */
export function AvatarDebugGrid() {
  useMeasurements();

  // ?size=260&only=frustrated,angry — for inspecting the restraint rule up close.
  const params = new URLSearchParams(window.location.search);
  const size = Number(params.get('size')) || 132;
  const only = params.get('only')?.split(',').filter(Boolean);
  const states = only?.length
    ? AVATAR_STATES.filter((state) => only.includes(state))
    : AVATAR_STATES;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold text-slate-900">Avatar states — Phase 4 Step 2</h1>
      <p className="mt-1 text-sm text-slate-500">
        Static render, no transitions. Temporary debug view.
      </p>

      <div
        className="mt-8 grid gap-4"
        style={{ gridTemplateColumns: `repeat(${states.length}, minmax(0, 1fr))` }}
      >
        {states.map((state) => (
          <div
            key={state}
            className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <AvatarFace state={state} size={size} label={AVATAR_STATE_LABELS[state]} />
            <span className="text-center text-xs font-medium text-slate-600">
              {AVATAR_STATE_LABELS[state]}
            </span>
          </div>
        ))}
      </div>

      <pre id="avatar-measurements" className="mt-8 text-xs text-slate-700" />
    </div>
  );
}
