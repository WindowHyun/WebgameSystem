'use strict';

/**
 * 게임 상태. 상태 전이는 GameEngine에서만 한다 - 여기에는 값과 허용되는 전이만 둔다.
 *
 *   INIT → PLAYING → WON | LOST | QUIT        (끝난 게임은 restart로 INIT부터 다시)
 */

const STATUS = Object.freeze({ INIT: 'INIT', PLAYING: 'PLAYING', WON: 'WON', LOST: 'LOST', QUIT: 'QUIT' });
const CANDIDATE_COUNT = 16;
const MAX_ROUND = 5;

const ALLOWED = {
  [STATUS.INIT]: [STATUS.PLAYING],
  [STATUS.PLAYING]: [STATUS.WON, STATUS.LOST, STATUS.QUIT],
  [STATUS.WON]: [STATUS.INIT],
  [STATUS.LOST]: [STATUS.INIT],
  [STATUS.QUIT]: [STATUS.INIT],
};

const isFinished = (status) => status === STATUS.WON || status === STATUS.LOST || status === STATUS.QUIT;

class GameState {
  constructor(seed) {
    this.seed = seed;
    this.status = STATUS.INIT;
    this.candidates = [];            // Candidate 16개
    this.answer = null;              // 숨겨진 정답(Candidate). 게임 도중 바뀌지 않는다.
    this.currentRound = 1;
    this.maxRound = MAX_ROUND;
    this.removedCandidates = new Set(); // 제거한 후보의 id
    this.hintHistory = [];           // 지금까지 공개한 힌트(삭제하지 않는다)
    this.wrongGuesses = [];          // 오답으로 제출한 후보 id(오답은 한 번이면 게임이 끝나므로 0개 또는 1개)
    this.plan = [];                  // 시작할 때 정해 둔 라운드별 힌트(공개 전에는 숨김)
  }
}

module.exports = { STATUS, GameState, CANDIDATE_COUNT, MAX_ROUND, ALLOWED, isFinished };
