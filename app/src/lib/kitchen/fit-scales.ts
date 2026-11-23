/**
 * Prep's list steps down through these when all folds are spent (`PrepScreen`):
 * 0.8 is its floor (24 cpx on 30 cpx rows, above the 22 cpx meta floor).
 */
export const FIT_SCALES = [1, 0.9, 0.8] as const;

/**
 * A cooking step's type steps down through these (`fitStack`, `CookFlow`) so
 * the whole step — prose, time line, and ingredient pairs — stays together on
 * one screen without splitting into "Continues ›" pages. Below 0.8, stage top
 * and foot padding compress first; 0.5 (32 cpx on 64 cpx step type, above chip
 * size) is the floor, past which the stage scrolls vertically.
 */
export const STEP_FIT_SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5] as const;

/**
 * Where the step in hand has room to spare, it steps up through these, the
 * largest first, while every line ahead stays drawn and whole (`fitStack`): a
 * tall stage, portrait above all, uses its room (DS §5, v1.13). The current
 * step only; Prep and a map card never grow.
 */
export const FIT_UP = [1.2, 1.1] as const;

