/** When the nudge banner appears, and why that number.
 *
 * `heat_score` has been produced by the analyzer since Phase 1 and displayed nowhere
 * until now, so there was no existing threshold to inherit. Phase 3 explicitly refused
 * to tune the frustrated/angry cutoffs against the 45-message corpus, on the grounds
 * that it "would produce a fit reported as a measurement". The same rule applies here,
 * so the corpus was used to *bound the range*, not to pick the value.
 *
 * All 45 fixtures scored through `multilingual_local` (real run, lexicon on):
 *
 *     expected      n    min   median   max
 *     calm          9   0.00     0.09   0.22
 *     neutral       9   0.02     0.16   0.22
 *     frustrated   12   0.22     0.42   0.61
 *     angry        15   0.12     0.37   0.77
 *
 * Sweeping the cutoff, counting frustrated|angry (n=27) as "should fire" and
 * calm|neutral (n=18) as "should not":
 *
 *     threshold   fired   correct   wrong    recall
 *          0.20      29     26/27    3/18      0.96
 *          0.23      24     24/27    0/18      0.89
 *          0.30      17     17/27    0/18      0.63
 *     ->   0.35      15     15/27    0/18      0.56
 *          0.40      13     13/27    0/18      0.48
 *          0.50       7      7/27    0/18      0.26
 *
 * Three things decided 0.35:
 *
 * 1. 0.23 is the fitted optimum and is deliberately NOT used. Its margin over the
 *    highest-scoring calm fixture is 0.01 — one fixture. That is a fit, not a
 *    threshold, and it would very likely not survive a 46th message.
 * 2. Wrong-fires are zero everywhere from 0.23 to 0.50, so the choice is insensitive
 *    across the whole band and only trades recall. The real question is therefore not
 *    "where is the boundary" but "how much under-warning is acceptable" — a product
 *    judgement, not a fitted parameter.
 * 3. 0.35 is chosen to UNDER-warn. A banner that interrupts a message which was
 *    actually fine costs the user more than a missed warning does: a miss leaves them
 *    exactly where they'd be without the feature. This is the same instinct as the
 *    avatar's frustrated/angry restraint — where the pipeline is least reliable, the
 *    interface should be least emphatic. The `angry` fixtures scatter from 0.12 to
 *    0.77, which is the known `angry` 6/15 weakness showing up in the heat signal too:
 *    three genuinely angry messages score below every threshold in the table.
 *
 * UPDATE 2026-07-29 - the caveat below came true, and it is left in place above rather
 * than rewritten, because the prediction being correct is the point.
 *
 * Six apologetic fixtures were added after the live app scored "i really apologize" as
 * angry / heat 0.60. The zero-wrong-fires column does NOT survive them: on 51 fixtures
 * it is 4/24, not 0/18. Four apologies clear 0.35 and would wrongly interrupt someone
 * mid-repair. See Step 12 in docs/phase3-results.md.
 *
 * The threshold is deliberately NOT re-tuned. Clearing those four needs a cutoff above
 * 0.60, which would drop the banner from 15 of 27 heated messages to 7 - gutting the
 * feature to patch a symptom whose cause is the analyzer's reading of apology, not the
 * cutoff. Fixing it at the threshold would also be tuning against the very fixtures
 * written to expose it.
 *
 * Limits, so this is not read as stronger than it is: validated against the same 45
 * self-authored messages Phase 3 already calls a small corpus, not held out, and the
 * clean zero-wrong-fires column is partly a property of a corpus whose calm messages
 * are unambiguously calm. Real typing will not be that tidy.
 *
 * The extension carries the same constant in `extension/config.js`, which points here.
 * If this number changes, that one changes with it.
 */
export const HEAT_NUDGE_THRESHOLD = 0.35;

/** Moods the banner is willing to render an accent for. Anything else gets the
 *  restrained default — the banner never invents a state the pipeline cannot emit. */
export type NudgeTone = 'frustrated' | 'angry';

/**
 * Whether a message warrants a nudge.
 *
 * Deliberately requires a real number: a null `heat_score` (analysis pending, failed,
 * or never run) is not a low score, and must never be treated as one. Same rule the
 * avatar follows — no state without backing data.
 */
export function shouldNudge(heatScore: number | null | undefined): boolean {
  return typeof heatScore === 'number' && heatScore >= HEAT_NUDGE_THRESHOLD;
}

/** Map the pipeline's mood onto the banner's two accents, defaulting to the milder one. */
export function nudgeTone(mood: string | null | undefined): NudgeTone {
  return mood === 'angry' ? 'angry' : 'frustrated';
}
