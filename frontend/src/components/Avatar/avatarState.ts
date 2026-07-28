/** The five states the avatar can be in — four moods plus one status.
 *
 * This list is closed on purpose. The four mood values are exactly what `_mood()` in
 * `backend/app/services/multilingual_local.py` can return; adding a state here without
 * a matching analyzer output would put a face on data the pipeline never produces.
 * See `docs/phase4-scope.md`.
 */
export type AvatarState = 'idle' | 'neutral' | 'frustrated' | 'angry' | 'analyzing';

export const AVATAR_STATES: readonly AvatarState[] = [
  'idle',
  'neutral',
  'frustrated',
  'angry',
  'analyzing',
] as const;

/** Human-readable labels. Used by the debug grid; not shown in the chat UI. */
export const AVATAR_STATE_LABELS: Record<AvatarState, string> = {
  idle: 'idle (calm / no data)',
  neutral: 'neutral',
  frustrated: 'frustrated',
  angry: 'angry',
  analyzing: 'analyzing',
};
