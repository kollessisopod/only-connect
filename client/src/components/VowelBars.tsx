import { AnswerBar } from './AnswerBar';
import { TeamBar } from './TeamBar';
import './VowelBars.css';

export interface VowelBarsProps {
  category: string;
  /** Vowel-stripped clue ("PL RCC P"); null in the category stage. */
  display?: string | null;
  /** Full answer; shown instead of `display` once revealed. */
  answer?: string | null;
  /** Absolutely positioned ~75 % wide near the bottom (default). Set false to place it yourself. */
  floating?: boolean;
  className?: string;
}

/** Missing Vowels: navy category bar above the light clue/answer bar. */
export function VowelBars({ category, display = null, answer = null, floating = true, className }: VowelBarsProps) {
  const text = answer ?? display;
  return (
    <div className={`oc-vowels${floating ? ' oc-vowels--floating' : ''}${className ? ` ${className}` : ''}`}>
      <TeamBar size="sm" className="oc-vowels__category">
        {category}
      </TeamBar>
      {text !== null && (
        <AnswerBar className={`oc-vowels__clue${answer !== null ? ' is-answer' : ''}`} spaced={answer === null}>
          {text}
        </AnswerBar>
      )}
    </div>
  );
}

export default VowelBars;
