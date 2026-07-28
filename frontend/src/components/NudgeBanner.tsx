import { useEffect, useState } from 'react';
import { nudgeTone, shouldNudge } from '../config/nudge';
import type { AnalysisStatus } from '../types/message';
import './NudgeBanner.css';

interface NudgeBannerProps {
  /** Which message this reflects. Dismissal is keyed on it, so the next message gets a
   *  fresh banner rather than inheriting the previous one's dismissal. */
  messageId: string | null;
  analysisStatus?: AnalysisStatus | null;
  mood?: string | null;
  heatScore?: number | null;
  rewriteSuggestion?: string | null;
}

/**
 * The first thing in this project to put `heat_score` on a screen.
 *
 * Threshold and its justification: `src/config/nudge.ts`. Palette and the restraint
 * rule it inherits from the avatar: `NudgeBanner.css`.
 *
 * Two rules govern what this renders, both carried over from Phase 4's avatar:
 *
 * 1. **Never show without backing data.** `pending`, `failed`, a null `heat_score` and
 *    an unrecognised mood all render nothing. A missing score is not a low score.
 * 2. **Hedge in the copy, not just in the colour.** It says a message *reads as*
 *    heated, never that it *is*. The pipeline detects `angry` at 6/15; the wording has
 *    to leave room for it to be wrong, because the user cannot check it.
 *
 * The body text is the analyzer's `rewrite_suggestion`. That field names what makes a
 * message land hard and deliberately does not attempt a rephrasing — see
 * `_suggest_rewrite` in multilingual_local.py, which declines to rewrite on the grounds
 * that a bad rewrite is worse than none. Showing it is what separates this from an
 * alarm: a banner that says only "this reads as heated" is a verdict with no reasoning
 * attached, which is the thing the product exists not to be. If the analyzer returns no
 * suggestion, a generic line stands in rather than the banner rendering headline-only.
 */
export function NudgeBanner({
  messageId,
  analysisStatus,
  mood,
  heatScore,
  rewriteSuggestion,
}: NudgeBannerProps) {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // A new message clears any previous dismissal. Without this, dismissing one banner
  // would silently suppress every later one for the session — the failure mode where
  // absence of a warning gets read as a verdict of calm.
  useEffect(() => {
    setDismissedFor((current) => (current === messageId ? current : null));
  }, [messageId]);

  const visible =
    messageId !== null &&
    analysisStatus === 'complete' &&
    shouldNudge(heatScore) &&
    dismissedFor !== messageId;

  if (!visible) {
    return null;
  }

  const tone = nudgeTone(mood);
  const body =
    rewriteSuggestion ??
    'This may land harder than you intend. Worth rereading before you send the next one.';

  return (
    <div
      className="nudge mb-3 flex items-start gap-3 rounded-2xl px-4 py-3 shadow-sm"
      data-tone={tone}
      // polite, not assertive: this interrupts a sentence someone is in the middle of
      // thinking about, and it is not urgent enough to cut across a screen reader.
      role="status"
      aria-live="polite"
    >
      <span className="nudge__mark mt-1.5 h-2 w-2 shrink-0 rounded-full" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <p className="nudge__label text-xs font-semibold uppercase tracking-[0.18em]">
          Worth a pause
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-700">{body}</p>
        <p className="mt-1.5 text-xs text-slate-500">
          {/* "reads as" throughout, and the score is shown as the intensity signal it is
              rather than as a confidence — the pipeline emits no per-message confidence,
              so any number presented as one would be invented. */}
          Reads as {tone} · heat {heatScore?.toFixed(2)}
        </p>
      </div>

      <button
        type="button"
        onClick={() => setDismissedFor(messageId)}
        className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-white/70 hover:text-slate-700"
        aria-label="Dismiss this nudge"
      >
        Dismiss
      </button>
    </div>
  );
}
