import { useEffect, useState } from 'react';
import type { AvatarState } from './avatarState';
import type { AnalysisStatus } from '../../types/message';

/** The only four mood strings `multilingual_local` can emit. Anything else is unknown
 *  data, and unknown data does not get a face — see `resolveAvatarState`. */
const MOOD_TO_STATE: Record<string, AvatarState> = {
  calm: 'idle',
  neutral: 'neutral',
  frustrated: 'frustrated',
  angry: 'angry',
};

/**
 * How long the avatar will sit in `analyzing` before giving up and showing `idle`.
 *
 * Measured send -> `complete` is 422-638ms (Phase 3) and the poll runs every 500ms, so a
 * healthy request resolves inside ~1.1s. 3s leaves roughly 3x margin over the real
 * distribution: comfortably above anything a working pipeline produces, comfortably below
 * the point where a user concludes the app is broken. Changing it means restating that
 * reasoning — it is derived from a measurement, not picked for feel.
 */
export const ANALYZING_TIMEOUT_MS = 3_000;

/**
 * Pipeline output -> avatar state. Pure, and exported so it can be reasoned about (and
 * later tested) without rendering anything.
 *
 * The bias is deliberate and one-directional: anything that is not a mood the pipeline
 * actually returned resolves to `idle`. A failed analysis, a null mood, a mood string
 * this build does not recognise (a re-enabled Gemini returning `warm` or `hurt`, which is
 * a live risk recorded in docs/progress.md) — all of them show the resting face rather
 * than a guess. Showing `neutral` for unknown data would be the more natural default and
 * is the wrong one: `neutral` is a real verdict the analyzer can reach, so using it as a
 * fallback would put a claim on screen that nothing produced.
 */
export function resolveAvatarState(
  mood: string | null | undefined,
  analysisStatus: AnalysisStatus | null | undefined,
): AvatarState {
  if (analysisStatus === 'pending') {
    return 'analyzing';
  }
  if (analysisStatus !== 'complete') {
    return 'idle';
  }
  return (mood && MOOD_TO_STATE[mood]) || 'idle';
}

/**
 * `resolveAvatarState` plus a client-side deadline on the `analyzing` state.
 *
 * This exists because of a real defect one layer down, not a hypothetical one:
 * `pollAnalysis` in useChat.ts abandons its loop on a thrown fetch error without
 * rescheduling and without moving `analysisStatus` off `pending`, so a single transient
 * failure strands a message in `pending` for the rest of the session. That was invisible
 * until Phase 4, because nothing rendered `pending`. The avatar renders it as a spinner,
 * which would turn a momentary network blip into a permanent one on screen.
 *
 * The timeout is containment, not a fix. It deliberately does not touch the poll loop —
 * the root cause is a retry policy question that belongs to useChat and is tracked
 * separately in docs/progress.md. All this does is stop trusting `pending` after 3s.
 *
 * Everything is keyed on `messageId` because the avatar shows whichever message was sent
 * most recently, and a deadline that outlived its message would be its own bug: a timer
 * started for message A must not force message B's fresh `analyzing` state to idle.
 */
export function useAvatarState(
  messageId: string | null | undefined,
  mood: string | null | undefined,
  analysisStatus: AnalysisStatus | null | undefined,
): AvatarState {
  // Which message, if any, has already blown its deadline. Storing the id rather than a
  // boolean is what scopes the latch: a new message has a new id, so it starts clean
  // without needing an explicit reset.
  const [timedOutId, setTimedOutId] = useState<string | null>(null);

  useEffect(() => {
    if (!messageId || analysisStatus !== 'pending') {
      return;
    }
    const timer = setTimeout(() => setTimedOutId(messageId), ANALYZING_TIMEOUT_MS);
    // Runs when the status leaves `pending` (the healthy path, every time) and when the
    // message being displayed changes. Either way the deadline is cancelled before it can
    // fire, so this is invisible on a working request.
    return () => clearTimeout(timer);
  }, [messageId, analysisStatus]);

  // Chosen behaviour for a late result (Step 6c, option (a)): once a message has timed
  // out, its analysis is ignored for good and the avatar stays idle, even if a real mood
  // turns up afterwards. Taking the claim back a second later — settling to idle and then
  // snapping to `angry` — reads as a glitch and undermines the one thing the avatar is
  // supposed to be, which is a truthful indicator. The latch is per-message, so the next
  // message the user sends is completely unaffected.
  if (messageId && timedOutId === messageId) {
    return 'idle';
  }

  return resolveAvatarState(mood, analysisStatus);
}
