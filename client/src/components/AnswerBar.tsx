import type { HTMLAttributes, ReactNode } from 'react';
import './AnswerBar.css';

export interface AnswerBarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Letter-spaced uppercase (missing vowels). Default true. */
  spaced?: boolean;
}

/** Light glossy bar with navy text: the missing-vowels clue and revealed answers. */
export function AnswerBar({ children, spaced = true, className, ...rest }: AnswerBarProps) {
  return (
    <div
      className={`oc-answerbar${spaced ? ' oc-answerbar--spaced' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <span className="oc-answerbar__text">{children}</span>
    </div>
  );
}

export default AnswerBar;
