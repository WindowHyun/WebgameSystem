'use strict';

/**
 * 갈팡질팡 - 한 방에 모인 사람들이 한 판을 같이 하는 추리 게임의 서버 쪽 방.
 *
 * [진행] 다른 카드 게임과 같다: 입장 → 각자 "준비" → 누구든 "게임 시작" → 진행 → 끝나면 다시 준비. 준비한
 * 사람이 그 판의 참가자고, 준비 안 한 사람과 중간에 들어온 사람은 구경한다(다음 판부터 참여). 혼자 접속해 있으면
 * 준비 없이 바로 시작할 수 있다. 후보 16개판·힌트·정답은 방 하나에 하나뿐이라 참가자 모두가 같은 화면을 본다.
 *
 * [과반수 동의] 판을 바꾸는 조작은 한 사람이 마음대로 하지 못한다. 누가 "제안"하면(후보 제거·정답 제출·다음 라운드·
 * 포기) 제안한 사람은 찬성으로 치고, 접속 중인 참가자의 과반수(절반을 넘는 수)가 찬성하면 그때 실행한다.
 * 과반수가 될 수 없을 만큼 반대가 나오거나 시간(proposalTimeoutMs)이 지나면 취소한다. 접속한 참가자가
 * 한 명뿐이면 그 한 명이 곧 과반수라 바로 실행된다. 어떤 조작에 동의를 받을지는 NEEDS_CONSENT 표 하나로 정한다.
 *
 * [정답은 서버만 안다] 정답과 힌트의 속마음(reason)은 이 프로세스 안에만 있고, 게임이 이기거나 져서 끝나기
 * 전에는 어떤 메시지에도 실리지 않는다(web/galpang/engine.js의 publicView). 브라우저는 후보 16개와 이미
 * 공개된 힌트만 받는다. seed도 내보내지 않는다 - 규칙 코드가 공개돼 있어서 seed를 알면 정답을 계산할 수 있다.
 * 제안 단계에서도 지우려는 후보가 정답인지는 보지 않는다(web/galpang/actions.js의 problem).
 *
 * [재접속] 새로고침·네트워크 전환으로 끊겨도 같은 토큰이면 같은 자리로 돌아온다. 끊긴 사람은 투표 인원에서
 * 빠지고(접속자 과반수), idleMs(기본 30분) 안에 돌아오지 않으면 자리를 정리한다.
 */

const crypto = require('crypto');
const { error: logError } = require('../logger');
const { cleanNickname, LIMITS } = require('./protocol');
const { createSession, yesNo } = require('./galpang/session');
const { parse } = require('./galpang/parser');
const render = require('./galpang/renderer');
const { problem, perform } = require('./galpang/actions');
const { STATUS } = require('./galpang/state');

const MIN_PLAYERS = 1;
const MAX_PLAYERS = 8;
// 한 판을 뛰는 인원(최대 8명)과 별개로, 다음 판을 기다리며 구경할 자리를 둔다.
const ROOM_CAPACITY = 12;
const IDLE_MS = 30 * 60 * 1000;
const PROPOSAL_MS = 30 * 1000;
const MAX_LINE = LIMITS.command; // 요청 형식(web/protocol.js)과 같은 한도

/** 판을 바꾸는 조작 중 접속자 과반수의 동의를 받을 것. false로 바꾸면 그 조작은 누구든 바로 한다. */
const NEEDS_CONSENT = { remove: true, guess: true, next: true, quit: true };

function createGalpangRoom(options) {
  const opts = options || {};
  const notify = opts.onChange || (() => {});
  const onAction = opts.onAction || (() => {});
  const act = (who, what) => { try { onAction(who, what); } catch { /* 로그 실패는 무시 */ } };
  const idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : IDLE_MS;
  const proposalMs = Number.isFinite(opts.proposalTimeoutMs) ? opts.proposalTimeoutMs : PROPOSAL_MS;
  // 테스트에서 게임을 고정하려고 주입받는다. 실제 서버는 주지 않는다(판마다 무작위).
  const seed = opts.seed;
  // 타이머 콜백에서 난 예외가 프로세스까지 올라가지 않게 감싼다(web/mind-room.js 참고).
  const safeTimeout = (fn, ms) => {
    const timer = setTimeout(() => {
      try { fn(); } catch (err) { logError(`[갈팡질팡 진행 처리 실패] ${err && err.stack ? err.stack : err}`); }
    }, ms);
    if (timer.unref) timer.unref();
    return timer;
  };

  const players = []; // { id, token, nickname, connected, ready, pendingQuit, reply, replySeq, timer }
  let phase = 'lobby'; // lobby(아직 판 없음) | playing | result(끝난 판이 남아 있음)
  let roster = [];     // 이번 판을 뛰는 사람(시작할 때 정해지고, 나가면 줄어든다)
  let session = null;  // 이번 판(web/galpang/session.js). lobby에서는 null
  let games = 0;       // 지금까지 시작한 판 수 - 테스트에서 seed를 `${seed}#${n}`으로 이어 가는 데 쓴다
  let proposal = null; // { id, cmd, byId, byName, yes: Set, no: Set, timer }
  let output = null;   // 모두에게 보이는 마지막 결과 글 { seq, title, lines }
  let outputSeq = 0;

  const makeId = () => crypto.randomBytes(8).toString('hex');
  const makeToken = () => crypto.randomBytes(16).toString('hex');
  const find = (id) => players.find((p) => p.id === id);
  const live = () => phase === 'playing';
  const changed = (id) => {
    try { notify(id); } catch (err) { logError(`[갈팡질팡 상태 알림 실패] ${err && err.stack ? err.stack : err}`); }
  };
  /** 이번 판에서 투표할 수 있는 사람: 접속 중인 참가자. */
  const voters = () => roster.map(find).filter((p) => p && p.connected);
  const seedFor = (index) => (seed === undefined ? undefined : (index === 0 ? seed : `${seed}#${index}`));

  function uniqueNickname(value, exceptId) {
    const used = new Set(players.filter((p) => p.id !== exceptId).map((p) => p.nickname));
    if (!used.has(value)) return value;
    // 글자(코드 포인트) 단위로 자른다. slice()는 UTF-16 단위라 이모지를 반으로 가른다.
    const head = (count) => Array.from(value).slice(0, count).join('');
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${head(20)}(${n})`;
      if (!used.has(candidate)) return candidate;
    }
    return `${head(18)}-${makeId().slice(0, 4)}`;
  }

  /** 모두에게 보이는 결과 글. title은 제안이 통과됐다는 알림 같은 머리글(없을 수 있다). */
  function say(title, lines) {
    outputSeq += 1;
    output = { seq: outputSeq, title: title || null, lines };
  }

  /** 한 사람에게만 보이는 답(도움말·목록·입력 오류). 상태는 그 사람에게만 보낸다. */
  function tell(player, lines) {
    player.replySeq += 1;
    player.reply = { seq: player.replySeq, lines };
    changed(player.id);
    return null;
  }

  // ───────────────────────────── 제안·투표 ─────────────────────────────

  /**
   * 제안을 사람이 읽을 글로 쓴다. 화면에는 후보 이름까지(withNames), 관리 로그에는 번호만 남긴다 - 로그에 단어가
   * 남으면, 정답 후보를 지워서 끝난 판의 로그에 정답 이름이 남는다.
   */
  function describe(cmd, withNames) {
    const state = session.engine.state;
    const name = (n) => (withNames === false ? `${n}번` : `${n}번 ${state.candidates[n - 1] ? state.candidates[n - 1].name : ''}`.trim());
    if (cmd.type === 'remove') return `후보 제거 - ${cmd.numbers.map(name).join(', ')}`;
    if (cmd.type === 'guess') return `정답 제출 - ${name(cmd.number)}`;
    if (cmd.type === 'next') return state.currentRound >= state.maxRound ? '마지막 라운드 끝내기' : '다음 라운드로 넘어가기';
    return '게임 포기(종료)';
  }
  const logText = (cmd) => describe(cmd, false);

  function clearProposal() {
    if (proposal && proposal.timer) clearTimeout(proposal.timer);
    proposal = null;
  }

  function cancel(why) {
    const gone = proposal;
    clearProposal();
    if (!gone) return;
    say(null, [`${gone.byName}님의 제안(${describe(gone.cmd)})이 ${why} 취소됐습니다.`]);
    act('투표', `제안 취소 - ${logText(gone.cmd)} (${why})`);
  }

  /** 판이 끝났다(이김·짐·포기). 준비는 다시 받는다. */
  function endGame(by) {
    clearProposal();
    phase = 'result';
    for (const p of players) p.pendingQuit = false;
    const engine = session.engine;
    if (engine.status === STATUS.WON) act(by, `정답 (${engine.round}라운드)`);
    else if (engine.status === STATUS.LOST) {
      const how = engine.summary().how;
      act(by, how === 'wrong' ? `오답으로 종료 (${engine.round}라운드)` : how === 'removed' ? `정답 후보를 지워서 종료 (${engine.round}라운드)` : '실패 (5라운드 종료)');
    } else if (engine.status === STATUS.QUIT) act(by, '포기');
  }

  /** 동의를 얻은(또는 동의가 필요 없는) 조작을 실제로 한다. tally는 { yes, total } - 여럿일 때만 머리글을 단다. */
  function run(cmd, byName, tally) {
    const engine = session.engine;
    const detail = logText(cmd);
    const done = perform(engine, cmd);
    say(tally && tally.total > 1 ? `${byName}님의 제안이 통과됐습니다. (동의 ${tally.yes}/${tally.total}명)` : null, done.lines);
    // 어떤 후보를 지웠는지·냈는지는 판 위에 다 보이는 정보다. 정답인지 여부는 따로 남기지 않는다.
    if (cmd.type !== 'quit') act(byName, tally && tally.total > 1 ? `${detail} (동의 ${tally.yes}/${tally.total}명)` : detail);
    if (engine.status !== STATUS.PLAYING) endGame(byName);
  }

  /** 지금 표로 결판이 났는지 본다: 과반수 찬성이면 실행, 과반수가 될 수 없으면 취소. 접속 인원이 바뀔 때도 다시 본다. */
  function settle() {
    if (!proposal) return;
    const connected = voters();
    const yes = connected.filter((p) => proposal.yes.has(p.id)).length;
    const no = connected.filter((p) => proposal.no.has(p.id)).length;
    const need = Math.floor(connected.length / 2) + 1;
    if (!connected.some((p) => p.id === proposal.byId)) { cancel('제안한 사람이 자리를 비워'); return; }
    if (yes >= need) {
      const passed = proposal;
      clearProposal();
      run(passed.cmd, passed.byName, { yes, total: connected.length });
      return;
    }
    if (yes + (connected.length - yes - no) < need) cancel('반대가 많아');
  }

  /** 판을 바꾸는 조작을 제안한다. 거절 사유는 돌려주고(화면에 안내), 받아들이면 null. */
  function propose(player, cmd) {
    if (!live()) return '진행 중인 게임이 없습니다.';
    if (!roster.includes(player.id)) return '이번 게임 참가자가 아닙니다. 구경 중에는 조작할 수 없습니다.';
    if (proposal) return `이미 투표가 진행 중입니다. (${proposal.byName}님: ${describe(proposal.cmd)})`;
    if (!NEEDS_CONSENT[cmd.type]) { run(cmd, player.nickname, null); changed(); return null; }
    proposal = { id: makeId(), cmd, byId: player.id, byName: player.nickname, yes: new Set([player.id]), no: new Set(), timer: null };
    act(player.nickname, `제안 - ${logText(cmd)}`);
    settle();
    if (proposal) {
      const id = proposal.id;
      proposal.timer = safeTimeout(() => {
        if (!proposal || proposal.id !== id) return;
        cancel('시간이 지나');
        changed();
      }, proposalMs);
    }
    changed();
    return null;
  }

  function vote(id, proposalId, agree) {
    if (!proposal || proposal.id !== proposalId) return '종료된 투표입니다.';
    const player = find(id);
    if (!player || !roster.includes(id)) return '이번 게임 참가자가 아닙니다.';
    if (proposal.yes.has(id) || proposal.no.has(id)) return '이미 투표했습니다.';
    (agree ? proposal.yes : proposal.no).add(id);
    act(player.nickname, `${logText(proposal.cmd)} ${agree ? '찬성' : '반대'}`);
    settle();
    changed();
    return null;
  }

  // ───────────────────────────── 참가 ─────────────────────────────

  function resetRoom() {
    clearProposal();
    phase = 'lobby'; roster = []; session = null; games = 0; output = null;
  }

  /** 자리를 정리한다(나감·돌아오지 않음). 이번 판 참가자였다면 참가자에서도 뺀다. */
  function dropSeat(player) {
    clearTimeout(player.timer);
    const index = players.indexOf(player);
    if (index >= 0) players.splice(index, 1);
    if (roster.includes(player.id)) {
      roster = roster.filter((id) => id !== player.id);
      if (live() && !roster.length) {
        // 참가자가 모두 빠져 이어 갈 사람이 없다. 구경하던 사람들을 위해 대기실로 돌린다.
        act('진행', '참가자가 모두 나가 게임을 마침');
        clearProposal();
        phase = 'lobby'; session = null; output = null;
      }
    }
    if (!players.length) resetRoom();
    else settle();
  }

  function join({ nickname, token }) {
    const clean = cleanNickname(nickname); // 글자 단위로 자른다(web/protocol.js)
    if (!clean) return { error: '닉네임을 입력해 주세요.' };
    const restored = token ? players.find((p) => p.token === token) : null;
    if (restored) {
      clearTimeout(restored.timer);
      restored.connected = true;
      restored.nickname = uniqueNickname(clean, restored.id);
      act(restored.nickname, '재접속');
      settle();
      changed();
      return { playerId: restored.id, token: restored.token, restored: true };
    }
    if (players.length >= ROOM_CAPACITY) {
      // 끊긴 채 남은 사람 중 이번 판 참가자가 아닌 가장 오래된 자리부터 비운다. 모두 접속 중이면 받을 수 없다.
      const stale = players.find((p) => !p.connected && !roster.includes(p.id));
      if (!stale) return { error: `방이 가득 찼습니다. (최대 ${ROOM_CAPACITY}명)` };
      dropSeat(stale);
    }
    const player = {
      id: makeId(), token: makeToken(), nickname: uniqueNickname(clean), connected: true, ready: false,
      pendingQuit: false, reply: null, replySeq: 0, timer: null,
    };
    players.push(player);
    act(player.nickname, `입장${live() ? ' (진행 중 - 다음 게임부터)' : ''}`);
    changed();
    return { playerId: player.id, token: player.token, restored: false };
  }

  function disconnect(id) {
    const player = find(id);
    if (!player || !player.connected) return;
    player.connected = false;
    player.pendingQuit = false;
    act(player.nickname, '연결 끊김');
    player.timer = safeTimeout(() => {
      const still = find(id);
      if (!still || still.connected) return;
      act(still.nickname, '자리 정리 (돌아오지 않음)');
      dropSeat(still);
      changed();
    }, Math.max(0, idleMs));
    settle();
    changed();
  }

  function leave(id) {
    const player = find(id);
    if (!player) return;
    act(player.nickname, '나감');
    dropSeat(player);
    changed();
  }

  // ───────────────────────────── 조작 ─────────────────────────────

  function setReady(id, ready) {
    if (live()) return '게임이 끝난 뒤에 준비할 수 있습니다.';
    const player = find(id);
    if (!player) return '참가자를 찾을 수 없습니다.';
    player.ready = !!ready;
    changed();
    return null;
  }

  /** 이번 판에 뛸 사람: 준비한 사람. 혼자 접속해 있으면 준비 없이도 그 사람이다. */
  function joining() {
    const connected = players.filter((p) => p.connected);
    return connected.length === 1 ? connected : connected.filter((p) => p.ready);
  }

  function begin(id) {
    const starter = find(id);
    if (!starter || !starter.connected) return '방에 참가한 뒤 시작할 수 있습니다.';
    if (live()) return '이미 게임이 진행 중입니다.';
    const going = joining();
    if (going.length < MIN_PLAYERS) return '준비한 참가자가 1명 이상이어야 합니다. 준비를 눌러 주세요.';
    if (going.length > MAX_PLAYERS) return `갈팡질팡은 ${MAX_PLAYERS}명까지 할 수 있습니다. 준비한 사람을 ${MAX_PLAYERS}명 이하로 맞춰 주세요.`;
    clearProposal();
    roster = going.map((p) => p.id);
    session = createSession({ seed: seedFor(games) });
    games += 1;
    phase = 'playing';
    for (const p of players) { p.pendingQuit = false; p.ready = false; }
    say(going.length > 1 ? `${starter.nickname}님이 게임을 시작했습니다. (${going.length}명: ${going.map((p) => p.nickname).join(', ')})` : null, session.intro());
    act(starter.nickname, `게임 시작 (${going.length}명: ${going.map((p) => p.nickname).join(', ')})`);
    changed();
    return null;
  }

  /** 명령어 한 줄. 판을 바꾸는 명령은 제안이 되고, 나머지는 그 사람에게만 답한다. 거절 사유는 돌려준다. */
  function command(id, line) {
    const player = find(id);
    if (!player) return '참가자를 찾을 수 없습니다.';
    if (typeof line !== 'string') return '잘못된 명령어입니다.';
    if (line.length > MAX_LINE) return '명령어가 너무 깁니다.';

    if (player.pendingQuit) {
      const answer = yesNo(line);
      if (answer === 'yes') { player.pendingQuit = false; return propose(player, { type: 'quit' }); }
      if (answer === 'no') { player.pendingQuit = false; return tell(player, ['게임을 계속합니다.']); }
      return tell(player, ['y 또는 n 으로 답해주세요. (y/n)']);
    }

    const cmd = parse(line);
    switch (cmd.type) {
      case 'empty': return null;
      case 'error': return tell(player, render.parseError(cmd));
      case 'help': return tell(player, render.help());
      case 'restart': return begin(id);
      case 'list':
      case 'history':
        if (!session) return tell(player, ['아직 게임이 시작되지 않았습니다.', '', '준비를 누르고 게임 시작을 눌러 주세요.']);
        return tell(player, cmd.type === 'list' ? render.list(session.engine.publicView(), cmd.all) : render.history(session.engine.publicView()));
      default: break;
    }
    // 여기부터는 판을 바꾸는 명령(remove·guess·next·quit)이다.
    if (!live()) {
      return tell(player, session ? render.GAME_OVER : ['아직 게임이 시작되지 않았습니다.', '', '준비를 누르고 게임 시작을 눌러 주세요.']);
    }
    if (!roster.includes(id)) return '이번 게임 참가자가 아닙니다. 구경 중에는 조작할 수 없습니다.';
    if (cmd.type === 'quit') {
      // 포기는 되돌릴 수 없어서 제안자에게 먼저 한 번 더 묻는다(혼자면 이것이 유일한 확인이다).
      player.pendingQuit = true;
      return tell(player, ['게임을 종료하시겠습니까? (y/n)']);
    }
    const bad = problem(session.engine, cmd);
    if (bad) return tell(player, bad);
    // 이미 지운 후보는 빼고 제안한다(같은 번호를 두 번 쓴 것도 하나로).
    const asked = cmd.type === 'remove'
      ? { type: 'remove', numbers: [...new Set(cmd.numbers)].filter((n) => !session.engine.state.removedCandidates.has(n)) }
      : cmd;
    return propose(player, asked);
  }

  /** 제한시간이 없는 게임이라 화면을 가려도 멈출 것이 없다. */
  function setCovered() {}

  // ───────────────────────────── 상태 ─────────────────────────────

  const EMPTY_VIEW = { status: 'LOBBY', round: 0, maxRound: 5, candidates: [], remaining: 0, hints: [], summary: null };

  function proposalFor(me) {
    if (!proposal) return null;
    const connected = voters();
    const cmd = proposal.cmd;
    return {
      id: proposal.id,
      kind: cmd.type,
      byId: proposal.byId,
      byName: proposal.byName,
      text: describe(cmd),
      // 판에서 이 후보들이 제안 대상이라고 표시하려고 보낸다(지우려는 후보가 정답인지는 알 수 없다).
      numbers: cmd.numbers ? cmd.numbers.slice() : (cmd.number ? [cmd.number] : []),
      agreed: connected.filter((p) => proposal.yes.has(p.id)).length,
      refused: connected.filter((p) => proposal.no.has(p.id)).length,
      needed: Math.floor(connected.length / 2) + 1,
      total: connected.length,
      yourVote: proposal.yes.has(me.id) ? 'yes' : proposal.no.has(me.id) ? 'no' : null,
      canVote: roster.includes(me.id) && me.connected,
      // 제안했거나 이미 투표한 사람 화면에 "누구를 기다리는지" 보여 주려고 보낸다.
      waitingFor: connected.filter((p) => !proposal.yes.has(p.id) && !proposal.no.has(p.id)).map((p) => p.nickname),
    };
  }

  function stateFor(id) {
    const me = find(id);
    if (!me) return null;
    const view = session ? session.engine.publicView() : EMPTY_VIEW;
    const connected = players.filter((p) => p.connected);
    const going = joining();
    const voting = proposal;
    return {
      ...view,
      type: 'galpangState',
      phase,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      readyCount: going.length,
      canStart: !live() && me.connected && going.length >= MIN_PLAYERS && going.length <= MAX_PLAYERS,
      alone: connected.length === 1,
      voters: voters().length,
      needed: Math.floor(voters().length / 2) + 1,
      pendingQuit: live() && me.pendingQuit && roster.includes(me.id),
      proposal: proposalFor(me),
      output,
      reply: me.reply,
      you: { id: me.id, nickname: me.nickname, ready: me.ready, inGame: live() && roster.includes(me.id) },
      players: players.filter((p) => p.connected || (live() && roster.includes(p.id))).map((p) => ({
        id: p.id,
        nickname: p.nickname,
        connected: p.connected,
        ready: p.ready,
        inGame: live() && roster.includes(p.id),
        vote: voting ? (voting.yes.has(p.id) ? 'yes' : voting.no.has(p.id) ? 'no' : null) : null,
      })),
    };
  }

  function dispose() {
    clearProposal();
    for (const player of players) clearTimeout(player.timer);
    players.length = 0;
  }

  return {
    join, disconnect, leave, setReady, begin, command, vote, setCovered, stateFor, dispose,
    // 테스트용. 서버는 쓰지 않는다.
    _debug: () => ({ players, roster, phase, session, proposal }),
    status: () => ({ phase, playerCount: players.filter((p) => p.connected).length }),
  };
}

module.exports = { createGalpangRoom, MIN_PLAYERS, MAX_PLAYERS, ROOM_CAPACITY, IDLE_MS, PROPOSAL_MS, MAX_LINE, NEEDS_CONSENT };
