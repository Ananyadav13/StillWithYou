import { AvatarFace } from './AvatarFace';
import { useAvatarState } from './useAvatarState';
import type { AvatarState } from './avatarState';
import type { AnalysisStatus } from '../../types/message';

export { resolveAvatarState, ANALYZING_TIMEOUT_MS } from './useAvatarState';

/* Note the wording: "reads as", not "is". The avatar reports how a message scans to the
 * analyzer, not a fact about the sender's state — and for `angry` in particular the
 * analyzer is right 6 times in 15, so the copy must not assert more than the model knows.
 * The matching visual restraint is documented on the angry state in Avatar.css. */
const STATE_DESCRIPTIONS: Record<AvatarState, string> = {
  idle: 'Message reads as calm',
  neutral: 'Message reads as neutral',
  frustrated: 'Message reads as frustrated',
  angry: 'Message reads as angry',
  analyzing: 'Analysing your message',
};

interface AvatarProps {
  /** Identifies the message being reflected, so the analyzing deadline in
   *  `useAvatarState` can be scoped to it rather than to the component. */
  messageId?: string | null;
  mood?: string | null;
  analysisStatus?: AnalysisStatus | null;
  size?: number;
}

/**
 * The avatar as the chat UI uses it: give it the current message's analysis, it picks a
 * face. It renders no scores and no confidence — see docs/phase4-scope.md for why.
 *
 * There is no crossfade wrapper here on purpose. Because all five states are one SVG
 * driven by CSS custom properties, changing `state` retargets the running transitions on
 * the existing elements, so the character *morphs* between expressions in 220ms rather
 * than one face dissolving into another. That is both cheaper (no second subtree, no
 * opacity compositing) and a better read: it stays visibly the same character reacting,
 * which is the whole premise of the design. Measured in Phase 4 Step 5 at 0.400ms median
 * per commit, and the measurement is what closed the question of adopting Framer Motion.
 */
export function Avatar({ messageId, mood, analysisStatus, size = 72 }: AvatarProps) {
  const state = useAvatarState(messageId, mood, analysisStatus);
  return <AvatarFace state={state} size={size} label={STATE_DESCRIPTIONS[state]} />;
}
