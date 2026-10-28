/**
 * The one place a team id turns into colours (V3.2). Pink and blue are the show's teams; green and orange
 * were added so a game can play up to four. Every component that colours something by team — the score
 * strip, the final score bars, the lobby chips, the buzz banners, the wall panel's team bar, the monitor
 * backdrop — takes its tone from here through `teamToneStyle` (CSS custom properties the stylesheets read)
 * or `TEAM_TONES`, never from a `'pink'` / `'blue'` literal, so a fifth colour would be a one-file change.
 *
 * The values are the tokens of `styles/tokens.css` (SPEC §7) by reference, so the stylesheets and this map
 * can never disagree.
 */
import type { CSSProperties } from 'react';
import { TEAM_COLOUR_LABELS, TEAM_IDS, type TeamId } from '@only-connect/shared';

/** The monitor backdrop drawn when a team is in control (`Background` variant). Pink is purple, as in the show. */
export type TeamBackground = 'purple' | 'blue' | 'green' | 'orange';

export interface TeamTone {
  /** The team's colour name as the host sees it ("Pink", "Blue", ...). */
  label: string;
  /** Small chips (score strip, buzz banners): accent, lighter top, darker bottom. */
  chip: { light: string; mid: string; deep: string };
  /** Wide bars (final scores, lobby chips): the show's three-stop score bar. */
  bar: { top: string; mid: string; bottom: string };
  /** The monitor backdrop variant while this team is in control. */
  background: TeamBackground;
  /** Bright text on the dark backdrop ("X win!"). */
  text: string;
}

function tone(id: TeamId, background: TeamBackground): TeamTone {
  return {
    label: TEAM_COLOUR_LABELS[id],
    chip: { light: `var(--oc-team-${id}-light)`, mid: `var(--oc-team-${id})`, deep: `var(--oc-team-${id}-deep)` },
    bar: { top: `var(--oc-score-${id}-top)`, mid: `var(--oc-score-${id})`, bottom: `var(--oc-score-${id}-bot)` },
    background,
    text: `var(--oc-winner-${id})`,
  };
}

export const TEAM_TONES: Record<TeamId, TeamTone> = {
  pink: tone('pink', 'purple'),
  blue: tone('blue', 'blue'),
  green: tone('green', 'green'),
  orange: tone('orange', 'orange'),
};

/**
 * Inline custom properties for a team-coloured element: `--oc-tone-*` (chip family), `--oc-bar-*` (bar
 * family) and `--oc-tone-text`. A stylesheet then needs one rule per component, not one per team.
 */
export function teamToneStyle(id: TeamId): CSSProperties {
  const t = TEAM_TONES[id];
  return {
    '--oc-tone-light': t.chip.light,
    '--oc-tone': t.chip.mid,
    '--oc-tone-deep': t.chip.deep,
    '--oc-bar-top': t.bar.top,
    '--oc-bar-mid': t.bar.mid,
    '--oc-bar-bottom': t.bar.bottom,
    '--oc-tone-text': t.text,
  } as CSSProperties;
}

/** The backdrop variant for the team in control (`'blue'` when nobody is). */
export function teamBackground(id: TeamId | null | undefined): TeamBackground {
  return id ? TEAM_TONES[id].background : 'blue';
}

/** `ids` filtered to known team ids, in the given order (a public state's `order` / `activeTeams`). */
export function knownTeams(ids: readonly TeamId[] | null | undefined): TeamId[] {
  return (ids ?? []).filter((id) => (TEAM_IDS as readonly string[]).includes(id));
}
