import './Avatar.css';
import type { AvatarState } from './avatarState';

interface AvatarFaceProps {
  state: AvatarState;
  /** Rendered size in pixels. The artwork is vector, so this is free. */
  size?: number;
  /** Announced to screen readers. Omit for decorative use. */
  label?: string;
}

/**
 * The character itself: one SVG, one set of shapes, five sets of values.
 *
 * Every visual difference between states is expressed as a CSS custom property in
 * Avatar.css and consumed here. There is deliberately no per-state markup branch — if a
 * state needed its own shape, the "same character, different expression" guarantee in
 * docs/phase4-scope.md would quietly stop being true, and the frustrated/angry restraint
 * would stop being checkable by comparing three numbers.
 *
 * This component is presentation only and knows nothing about moods or analysis. The
 * mapping from pipeline output to `state` lives in Avatar.tsx.
 */
export function AvatarFace({ state, size = 120, label }: AvatarFaceProps) {
  return (
    <div className="avatar" data-state={state} style={{ width: size, height: size }}>
      <svg
        className="avatar__svg"
        viewBox="0 0 120 120"
        width={size}
        height={size}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        {/* Surrounding ring. Solid for the four moods; dashed while analyzing. */}
        <circle className="avatar__ring" cx="60" cy="60" r="54" />

        <circle className="avatar__head" cx="60" cy="58" r="40" />

        {/* Brows. Straight strokes, rotated about their own centres — mirrored, so one
            angle value drives both. */}
        <path className="avatar__brow avatar__brow--left" d="M 39 41 L 53 41" />
        <path className="avatar__brow avatar__brow--right" d="M 67 41 L 81 41" />

        <circle className="avatar__eye" cx="46" cy="55" r="5.5" />
        <circle className="avatar__eye" cx="74" cy="55" r="5.5" />

        {/* Mouth. Authored as a smile; --mouth-scale flips and flattens it, so smile,
            flat line and frown are one path at three values rather than three paths. */}
        <path className="avatar__mouth" d="M 47 76 Q 60 87 73 76" />

        {/* Progress dots. Present in every state, visible only while analyzing. */}
        <circle className="avatar__dot" cx="48" cy="110" r="3.5" />
        <circle className="avatar__dot" cx="60" cy="110" r="3.5" />
        <circle className="avatar__dot" cx="72" cy="110" r="3.5" />
      </svg>
    </div>
  );
}
