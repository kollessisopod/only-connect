import type { ReactNode } from 'react';
import type { PublicClue, PublicWallTile, TeamId } from '@only-connect/shared';
import {
  Background,
  BuzzBanner,
  ClueRow,
  FinalScores,
  HieroglyphGrid,
  ScoreStrip,
  TeamBar,
  VowelBars,
  WallGrid,
  WallLives,
  WallTimer,
} from '../../components';
import './GalleryScreen.css';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const TEAMS: Record<TeamId, { name: string; score: number }> = {
  pink: { name: 'Nightwearers', score: 17 },
  blue: { name: 'Frenemies', score: 20 },
};

function clue(kind: PublicClue['kind'], text: string | null, revealed: boolean, mediaUrl: string | null = null): PublicClue {
  return { kind, text, mediaUrl, revealed };
}

const CONNECTIONS_CLUES: PublicClue[] = [
  clue('audio', null, true),
  clue('audio', null, true),
  clue('text', null, false),
  clue('text', null, false),
];

const ANSWER_CLUES: PublicClue[] = [
  clue('text', 'Bananas', true),
  clue('text', 'Arthur Dent', true),
  clue('text', 'Ebenezer Scrooge', true),
  clue('text', 'Wee Willie Winkie', true),
];

const SEQUENCE_CLUES = [
  clue('text', 'Martin', true),
  clue('text', 'Harper', true),
  clue('text', 'Trudeau', true),
  { ...clue('text', null, false), isQuestionMark: true },
];

const WALL_WORDS = [
  ['Ummagumma', 'Animals', 'Meddle', 'The Wall'],
  ['Poke', 'Nose', 'Pry', 'Snoop'],
  ['Plaza', 'Odeon', 'Empire', 'Ritz'],
  ['Alphabet', 'Road', 'Candle', 'Intrude'],
];

const WALL_TILES: PublicWallTile[] = WALL_WORDS.flatMap((row, r) =>
  row.map((text, c) => ({
    id: r * 4 + c,
    text,
    group: r < 2 ? r : null,
    colour: r < 2 ? r : null,
  })),
);

// ---------------------------------------------------------------------------
// Frame helper
// ---------------------------------------------------------------------------

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery__item">
      <h2 className="gallery__label">{title}</h2>
      <div className="gallery__frame">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export function GalleryScreen() {
  return (
    <div className="screen screen--scroll gallery">
      <header className="gallery__header">
        <h1>Only Connect — component gallery</h1>
        <p>Each frame is 1920×1080. Compare with the reference frames in screenshots/.</p>
      </header>

      <Frame title="1 · Hieroglyph grid (Water used)">
        <Background variant="blue">
          <div className="gallery__centre">
            <HieroglyphGrid used={['water']} />
          </div>
          <div className="gallery__corner">
            <ScoreStrip teams={TEAMS} active="blue" />
          </div>
        </Background>
      </Frame>

      <Frame title="2 · Connections question — 2 audio clues revealed, 3 Points, purple (pink team)">
        <Background variant="purple">
          <div className="gallery__bottom">
            <ClueRow clues={CONNECTIONS_CLUES} points={3} footer={<TeamBar>Nightwearers</TeamBar>} />
          </div>
          <div className="gallery__corner">
            <ScoreStrip teams={TEAMS} active="pink" />
          </div>
        </Background>
      </Frame>

      <Frame title="3 · Answer reveal — grey lower panel, answer in the bar">
        <Background variant="purple" />
        <div className="gallery__lower-panel">
          <Background variant="grey" />
        </div>
        <div className="gallery__answer">
          <ClueRow
            clues={ANSWER_CLUES}
            captions
            points={2}
            footer={<TeamBar>Characters who go to bed in their stories</TeamBar>}
          />
        </div>
      </Frame>

      <Frame title="4 · Sequences question — ? tile, 2 Points, blue team">
        <Background variant="blue">
          <div className="gallery__bottom">
            <ClueRow clues={SEQUENCE_CLUES} points={2} footer={<TeamBar>Frenemies</TeamBar>} />
          </div>
          <div className="gallery__corner">
            <ScoreStrip teams={TEAMS} active="blue" />
          </div>
        </Background>
      </Frame>

      <Frame title="5 · Connecting wall — 2 groups solved, 2 tiles selected, timer at 40 %, 3 lives">
        <Background variant="blue">
          <div className="gallery__wall">
            <div className="gallery__wall-grid">
              <WallGrid tiles={WALL_TILES} selected={[9, 14]} />
              <WallTimer progress={0.4} secondsLeft={108} />
              <div className="gallery__wall-foot">
                <TeamBar size="sm" className="gallery__wall-team">
                  Frenemies
                </TeamBar>
                <WallLives lives={3} />
              </div>
            </div>
          </div>
          <div className="gallery__corner">
            <ScoreStrip teams={TEAMS} active="blue" />
          </div>
        </Background>
      </Frame>

      <Frame title="6 · Missing vowels — category + clue bars, pink buzz banner">
        <Background variant="blue">
          <div className="gallery__buzz">
            <BuzzBanner team="pink" playerName="Mia" teamName="Nightwearers" />
          </div>
          <VowelBars category="Found on Mars" display="PL RCC P" />
          <div className="gallery__corner">
            <ScoreStrip teams={TEAMS} />
          </div>
        </Background>
      </Frame>

      <Frame title="7 · Final scores — grey panel, winners first">
        <Background variant="blue" />
        <div className="gallery__lower-panel gallery__lower-panel--final">
          <Background variant="grey" />
        </div>
        <div className="gallery__final">
          <FinalScores teams={TEAMS} />
        </div>
      </Frame>

      <Frame title="8 · Wall wrong-guess flash + resolved colours (all four groups)">
        <Background variant="blue">
          <div className="gallery__wall">
            <div className="gallery__wall-grid">
              <WallGrid
                tiles={WALL_TILES.map((t) => (t.id >= 8 ? { ...t, colour: t.id >= 12 ? 3 : 2, group: t.id >= 12 ? 3 : 2 } : t))}
                selected={[]}
                lastWrong={null}
              />
              <WallTimer progress={1} secondsLeft={0} />
              <div className="gallery__wall-foot">
                <TeamBar size="sm" className="gallery__wall-team">
                  Pink Floyd albums
                </TeamBar>
                <WallLives lives={1} />
              </div>
            </div>
          </div>
        </Background>
      </Frame>
    </div>
  );
}

export default GalleryScreen;
