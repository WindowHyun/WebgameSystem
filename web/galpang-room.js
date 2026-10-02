'use strict';

/**
 * 갈팡질팡(혼자 하는 추리 게임)의 서버 쪽 방.
 *
 * 다른 카드 게임은 한 방에 모인 사람들이 한 판을 같이 하지만, 갈팡질팡은 사람마다 자기 판이 따로다.
 * 그래서 이 "방"은 접속한 사람마다 게임 세션(web/galpang/session.js) 하나씩을 쥐고 있다. 서버의 카드 게임
 * 공통 틀(web/game-server.js의 CARD_GAMES)에는 다른 게임과 같은 모양(join·leave·disconnect·stateFor·status…)으로
 * 끼워 넣는다.
 *
 * [정답은 서버만 안다] 정답과 힌트의 속마음(reason)은 이 프로세스 안에만 있고, 게임이 이기거나 져서 끝나기
 * 전에는 어떤 메시지에도 실리지 않는다(web/galpang/engine.js의 publicView). 브라우저는 후보 16개와 이미
 * 공개된 힌트만 받는다. seed도 내보내지 않는다 - 규칙 코드가 공개돼 있어서 seed를 알면 정답을 계산할 수 있다.
 *
 * [재접속] 새로고침·네트워크 전환으로 끊겨도 같은 토큰이면 진행 중이던 판으로 돌아온다. 끊긴 판은
 * idleMs(기본 30분)가 지나면 버린다.
 */

const crypto = require('crypto');
const { error: logError } = require('../logger');
const { cleanNickname, LIMITS } = require('./protocol');
const { createSession } = require('./galpang/session');
const { STATUS } = require('./galpang/state');

const MAX_SESSIONS = 300;
const IDLE_MS = 30 * 60 * 1000;
const MAX_LINE = LIMITS.command; // 요청 형식(web/protocol.js)과 같은 한도

function createGalpangRoom(options) {
  const opts = options || {};
  const notify = opts.onChange || (() => {});
  const onAction = opts.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : IDLE_MS;
  const maxSessions = Number.isFinite(opts.maxSessions) ? opts.maxSessions : MAX_SESSIONS;
  // 테스트에서 게임을 고정하려고 주입받는다. 실제 서버는 주지 않는다(판마다 무작위).
  const seed = opts.seed;

  const players = []; // { id, token, nickname, connected, session, seq, output, timer, joinedAt }
  const find = (id) => players.find((p) => p.id === id);
  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(16).toString('hex');

  const changed = (id) => {
    try { notify(id); } catch (err) { logError(`[갈팡질팡 상태 알림 실패] ${err && err.stack ? err.stack : err}`); }
  };

  function drop(player) {
    clearTimeout(player.timer);
    const index = players.indexOf(player);
    if (index >= 0) players.splice(index, 1);
  }

  function join({ nickname, token }) {
    const clean = cleanNickname(nickname);
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    const restored = token ? players.find((p) => p.token === token) : null;
    if (restored) {
      clearTimeout(restored.timer);
      restored.connected = true;
      restored.nickname = clean;
      act(restored.nickname, '재접속');
      changed(restored.id);
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= maxSessions) {
      // 끊긴 채 남은 가장 오래된 판부터 비운다. 모두 접속 중이면 받을 수 없다.
      const stale = players.find((p) => !p.connected);
      if (!stale) return { error: '지금은 접속이 많아 새 게임을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.' };
      drop(stale);
    }
    const player = {
      id: makeId(), token: makeToken(), nickname: clean, connected: true,
      session: createSession({ seed }), seq: 0, output: null, timer: null,
    };
    players.push(player);
    act(player.nickname, '입장 - 새 게임');
    changed(player.id);
    return { playerId: player.id, token: player.token, restored: false };
  }

  function disconnect(id) {
    const player = find(id);
    if (!player || !player.connected) return;
    player.connected = false;
    act(player.nickname, '연결 끊김');
    player.timer = setTimeout(() => {
      const still = find(id);
      if (!still || still.connected) return;
      act(still.nickname, '자리 정리 (돌아오지 않음)');
      drop(still);
      changed(id);
    }, Math.max(0, idleMs));
    if (player.timer.unref) player.timer.unref();
    changed(id);
  }

  function leave(id) {
    const player = find(id);
    if (!player) return;
    act(player.nickname, '나감');
    drop(player);
    changed(id);
  }

  /** 명령어 한 줄. 결과 글은 다음 상태(output)에 실려 간다. 거절 사유는 돌려준다. */
  function command(id, line) {
    const player = find(id);
    if (!player) return '참가자를 찾을 수 없습니다.';
    if (typeof line !== 'string') return '잘못된 명령어입니다.';
    if (line.length > MAX_LINE) return '명령어가 너무 깁니다.';
    const before = player.session.engine.status;
    const { lines, exit } = player.session.handleLine(line);
    const engine = player.session.engine;
    const after = engine.status;
    if (lines.length) { player.seq += 1; player.output = { seq: player.seq, lines }; }
    if (before !== after) {
      if (after === STATUS.WON) act(player.nickname, `정답 (${engine.round}라운드)`);
      else if (after === STATUS.LOST) act(player.nickname, player.session.engine.state.wrongGuesses.length ? `오답으로 종료 (${engine.round}라운드)` : '실패 (5라운드 종료)');
      else if (after === STATUS.QUIT) act(player.nickname, '포기');
      else if (after === STATUS.PLAYING) act(player.nickname, '새 게임');
    }
    if (exit && after !== STATUS.QUIT) act(player.nickname, '종료');
    changed(id);
    return null;
  }

  /** 제한시간이 없는 게임이라 화면을 가려도 멈출 것이 없다. */
  function setCovered() {}

  function stateFor(id) {
    const player = find(id);
    if (!player) return null;
    return {
      ...player.session.view(),
      type: 'galpangState',
      output: player.output,
      you: { id: player.id, nickname: player.nickname },
      players: [{ id: player.id, nickname: player.nickname, connected: player.connected }],
    };
  }

  function dispose() {
    for (const player of players) clearTimeout(player.timer);
    players.length = 0;
  }

  return {
    join, disconnect, leave, command, setCovered, stateFor, dispose,
    // 테스트용. 서버는 쓰지 않는다.
    _debug: () => ({ players }),
    status: () => {
      const live = players.filter((p) => p.connected);
      return { phase: live.some((p) => p.session.engine.status === STATUS.PLAYING) ? 'playing' : 'lobby', playerCount: live.length };
    },
  };
}

module.exports = { createGalpangRoom, MAX_SESSIONS, IDLE_MS, MAX_LINE };
