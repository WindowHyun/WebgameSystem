'use strict';

/**
 * 갈팡질팡 서버 쪽(web/galpang-room.js + web/game-server.js) - 방 단위 + 실제 WebSocket.
 *
 *   [참가]   들어온 사람이 모두에게 보이고, 다른 카드 게임처럼 준비 → 게임 시작으로 한 판을 같이 한다.
 *            준비 안 한 사람·중간에 들어온 사람은 구경한다. 혼자 접속해 있으면 준비 없이 바로 시작한다
 *   [동의]   후보 제거·정답 제출·다음 라운드·포기는 제안이 되고, 접속 중인 참가자의 과반수가 찬성해야 실행된다.
 *            반대가 많거나 시간이 지나면 취소되고, 접속 인원이 바뀌면 다시 센다
 *   [비공개] 어떤 상태 메시지에도 정답·해설·후보의 특징·seed가 없다(끝나기 전). 제안 단계에서도 지우려는 후보가
 *            정답인지 새지 않는다. 끝난 뒤에는 정답과 해설이 간다. 관리 로그에도 정답 이름이 남지 않는다
 *   [서버]   잘못된 요청은 거절하고, 포털에 인원·상태가 나오며, 보스 키가 퍼진다
 *
 * 실행: node test/galpang-room-test.js
 */

const WebSocket = require('ws');
const { createGalpangRoom, MAX_PLAYERS, ROOM_CAPACITY } = require('../web/galpang-room');
const { createGameServer } = require('../web/game-server');
const { GameEngine } = require('../web/galpang/engine');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 정답 후보를 지우면 게임이 끝나므로, 정해 둔 번호를 지우는 시험은 그 번호에 정답이 없는 판에서 해야 한다.
// 조건에 맞는 seed를 올려 가며 찾으므로, 데이터가 바뀌어 정답이 달라져도 시험이 깨지지 않는다.
const answerOf = (seed) => new GameEngine({ seed }).state.answer;
const seedWhere = (ok, from) => { for (let candidate = from; ; candidate += 1) if (ok(candidate)) return candidate; };
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SECRETS = ['answer', 'reason', 'plan', 'tags', 'category', 'parents', 'seed', 'side', 'axis', 'tier'];
/** 객체를 샅샅이 뒤져 비공개 키가 있으면 그 경로를 돌려준다. */
function findSecret(value, trail) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, inner] of Object.entries(value)) {
    if (SECRETS.includes(key)) return `${trail || ''}.${key}`;
    const found = findSecret(inner, `${trail || ''}.${key}`);
    if (found) return found;
  }
  return null;
}
const NO_KEYS = ['tags', 'category', 'parents', 'seed', 'plan', 'side', 'axis'];
const hasNoInternals = (state) => NO_KEYS.every((k) => !JSON.stringify(state).includes(`"${k}"`));
const IDS = Array.from({ length: 16 }, (_, i) => i + 1);

// 첫 판의 정답이 1~6번이 아닌 seed(아래 시험이 지우는 번호에 정답이 걸리지 않게). 두 번째 판은 `${SEED}#1`.
const SEED = seedWhere((c) => ![1, 2, 3, 4, 5, 6].includes(answerOf(c).id), 100);
const FIRST = answerOf(SEED);

/** 방과 도우미. 참가자는 { playerId, token, name }. */
function setup(extra) {
  const changes = [];
  const logs = [];
  const room = createGalpangRoom({ seed: SEED, onChange: (id) => changes.push(id), onAction: (who, what) => logs.push(`${who} ${what}`), ...(extra || {}) });
  const person = (name) => { const joined = room.join({ nickname: name }); return { ...joined, name }; };
  const st = (p) => room.stateFor(p.playerId);
  const ready = (...ps) => ps.forEach((p) => room.setReady(p.playerId, true));
  const answer = () => room._debug().session.engine.state.answer;
  const cmd = (p, line) => room.command(p.playerId, line);
  const vote = (p, agree) => room.vote(p.playerId, st(p).proposal && st(p).proposal.id, agree);
  /** 지금 판의 정답이 아닌 후보 번호들. */
  const notAnswer = (count) => IDS.filter((id) => id !== answer().id).slice(0, count);
  return { room, changes, logs, person, st, ready, answer, cmd, vote, notAnswer };
}

(async () => {
  // ── 참가: 누가 들어왔는지 보이고, 준비 → 게임 시작 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const lobby = t.st(a);
      check('입장하면 대기실이다(판이 아직 없고 후보·힌트도 없다)', lobby.type === 'galpangState' && lobby.phase === 'lobby' && lobby.status === 'LOBBY' && lobby.candidates.length === 0
        && lobby.hints.length === 0 && lobby.summary === null && lobby.round === 0 && lobby.you.inGame === false && lobby.pendingQuit === false);
      check('들어온 사람이 참가자 목록에 나온다(이름·접속·준비)', same(lobby.players.map((p) => [p.nickname, p.connected, p.ready, p.inGame]), [['김하늘', true, false, false]]));
      check('혼자 접속해 있으면 준비 없이 바로 시작할 수 있다(alone, canStart)', lobby.alone === true && lobby.canStart === true);
      check('빈 이름은 받지 않는다', !!t.room.join({ nickname: '   ' }).error && !!t.room.join({}).error);

      const b = t.person('박서준');
      check('다른 사람이 들어오면 먼저 있던 사람 화면의 참가자 목록에도 보인다', same(t.st(a).players.map((p) => p.nickname), ['김하늘', '박서준']) && same(t.st(b).players.map((p) => p.nickname), ['김하늘', '박서준']));
      check('둘 이상이면 준비한 사람이 있어야 시작할 수 있다(alone 아님, canStart 아님)', t.st(a).alone === false && t.st(a).canStart === false && t.st(a).readyCount === 0);
      check('준비한 사람이 없으면 시작이 거절된다', typeof t.room.begin(a.playerId) === 'string' && t.st(a).phase === 'lobby', String(t.room.begin(a.playerId)));
      t.room.setReady(b.playerId, true);
      check('준비하면 목록에 준비로 보이고 준비한 수가 오른다', t.st(a).players.find((p) => p.nickname === '박서준').ready === true && t.st(a).readyCount === 1 && t.st(a).canStart === true);
      t.room.setReady(b.playerId, false);
      check('준비를 취소할 수 있다', t.st(a).readyCount === 0 && t.st(a).canStart === false);
      check('같은 이름이 들어오면 번호를 붙여 구분한다', t.person('김하늘').name === '김하늘' && t.st(a).players.map((p) => p.nickname).includes('김하늘(2)'));
      check('알 수 없는 참가자의 준비·시작은 거절한다', !!t.room.setReady('nope', true) && !!t.room.begin('nope'));
      check('입장·준비 같은 모두의 상태는 모두에게 알린다(onChange에 참가자 id가 없다)', t.changes.length >= 4 && t.changes.every((id) => id === undefined), JSON.stringify(t.changes));
    } finally { t.room.dispose(); }
  }

  // ── 시작: 준비한 사람이 참가하고 나머지는 구경한다 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      const c = t.person('최민아');
      t.ready(a, b);
      check('준비한 2명이면 준비 안 한 사람(구경할 사람)이 눌러도 시작할 수 있다', t.room.begin(c.playerId) === null && t.room.status().phase === 'playing');
      const sa = t.st(a);
      const sc = t.st(c);
      check('시작하면 판이 만들어진다: 후보 16개·힌트 1개·1라운드', sa.phase === 'playing' && sa.status === 'PLAYING' && sa.candidates.length === 16 && sa.hints.length === 1 && sa.round === 1 && sa.remaining === 16);
      check('준비한 사람은 참가자(inGame), 안 한 사람은 구경이다', sa.you.inGame === true && t.st(b).you.inGame === true && sc.you.inGame === false
        && same(sa.players.map((p) => [p.nickname, p.inGame]), [['김하늘', true], ['박서준', true], ['최민아', false]]));
      check('구경하는 사람도 같은 판(후보·힌트)을 본다', same(sc.candidates, sa.candidates) && same(sc.hints, sa.hints));
      check('시작하면 준비는 풀린다(다음 판에 다시 준비)', sa.players.every((p) => p.ready === false));
      check('진행 중 상태 메시지에 정답·해설·특징·seed가 없다', findSecret(sa) === null && findSecret(sc) === null, findSecret(sa));
      check('구경하는 사람의 조작은 거절한다(명령어·준비)', typeof t.cmd(c, 'remove 1') === 'string' && typeof t.room.setReady(c.playerId, true) === 'string');
      check('진행 중에는 다시 시작할 수 없다', typeof t.room.begin(a.playerId) === 'string');
      const d = t.person('늦은사람');
      check('진행 중에 들어온 사람은 구경한다(다음 게임부터 참여)', t.st(d).you.inGame === false && t.st(d).phase === 'playing' && t.logs.some((l) => l.includes('늦은사람 입장 (진행 중 - 다음 게임부터)')));
      check('시작 로그에 참가자 이름이 남는다', t.logs.some((l) => l.includes('게임 시작 (2명: 김하늘, 박서준)')), t.logs.join(' | '));
      check('시작을 모두에게 알린 공통 글이 있다(누가 시작했고 누가 함께하는지 + 후보 목록)', t.st(a).output && t.st(a).output.title === '최민아님이 게임을 시작했습니다. (2명: 김하늘, 박서준)' && t.st(a).output.lines.join('\n').includes('[ROUND 1]'), JSON.stringify(t.st(a).output && t.st(a).output.title));
    } finally { t.room.dispose(); }
  }
  {
    const t = setup();
    try {
      const people = Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => t.person(`사람${i + 1}`));
      t.ready(...people);
      check(`준비한 사람이 ${MAX_PLAYERS}명을 넘으면 시작할 수 없다`, typeof t.room.begin(people[0].playerId) === 'string' && t.st(people[0]).phase === 'lobby');
      t.room.setReady(people[0].playerId, false);
      check(`${MAX_PLAYERS}명까지는 시작한다`, t.room.begin(people[1].playerId) === null && t.room.status().phase === 'playing');
    } finally { t.room.dispose(); }
  }

  // ── 과반수 동의: 2명 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);
      const [p, q, r] = t.notAnswer(3);
      check('제안이 받아들여진다(거절 사유 없음)', t.cmd(a, `remove ${p} ${q}`) === null);
      const sa = t.st(a).proposal;
      const sb = t.st(b).proposal;
      check('제안이 모두에게 보인다: 종류·제안자·대상 후보·동의 1/2·과반수 2', sa && sb && sa.id === sb.id && sa.kind === 'remove' && sa.byName === '김하늘' && same(sa.numbers, [p, q]) && sa.agreed === 1 && sa.needed === 2 && sa.total === 2
        && sa.text.startsWith('후보 제거 - ') && sa.text.includes(`${p}번`), JSON.stringify(sa));
      check('제안한 사람은 찬성으로 치고(투표 완료), 다른 사람은 투표할 수 있다', sa.yourVote === 'yes' && sb.yourVote === null && sa.canVote === true && sb.canVote === true && same(sa.waitingFor, ['박서준']));
      check('참가자 목록에 누가 찬성했는지 보인다', same(t.st(a).players.map((x) => x.vote), ['yes', null]));
      check('동의를 받기 전에는 판이 바뀌지 않는다(남은 후보 16개)', t.st(a).remaining === 16 && t.st(b).remaining === 16 && t.st(a).candidates.every((x) => !x.removed));
      check('투표 중에는 다른 제안을 받지 않는다', String(t.cmd(b, `remove ${r}`)).includes('이미 투표가 진행 중') && t.st(a).proposal.id === sa.id);
      check('종료된(다른) 투표 번호로는 투표할 수 없다', t.room.vote(b.playerId, 'nope', true) === '종료된 투표입니다.');
      check('제안한 사람이 다시 투표할 수 없다(이미 투표함)', t.room.vote(a.playerId, sa.id, true) === '이미 투표했습니다.');
      check('제안 상태에 정답·해설·특징이 없다(제안 단계에서 정답 여부가 새지 않는다)', findSecret(t.st(a)) === null && findSecret(t.st(b)) === null && hasNoInternals(t.st(a)));
      check('제안이 관리 로그에 남는다(후보는 번호만, 이름은 남기지 않는다)', t.logs.some((l) => l === `김하늘 제안 - 후보 제거 - ${p}번, ${q}번`) && t.logs.every((l) => !l.includes(t.st(a).candidates[p - 1].name)), t.logs.slice(-3).join(' | '));

      check('과반수(2/2)가 동의하면 실행된다', t.room.vote(b.playerId, sa.id, true) === null && t.st(a).remaining === 14 && t.st(b).remaining === 14 && t.st(a).proposal === null);
      const out = t.st(a).output;
      check('실행 결과가 모두에게 같은 글로 간다(통과 머리글 + N번 제거)', same(t.st(b).output, out) && out.title === '김하늘님의 제안이 통과됐습니다. (동의 2/2명)' && out.lines[0] === `${p}번 제거` && out.lines[1] === `${q}번 제거`, JSON.stringify(out));
      check('지운 후보가 모두의 판에 표시된다', t.st(a).candidates[p - 1].removed && t.st(b).candidates[q - 1].removed);
      check('끝난 투표에 다시 투표해도 소용없다', t.room.vote(b.playerId, sa.id, true) === '종료된 투표입니다.' && t.st(a).remaining === 14);
      check('통과한 제안이 관리 로그에 남는다(동의 인원 포함)', t.logs.some((l) => l.includes('후보 제거') && l.includes('동의 2/2명')), t.logs.slice(-3).join(' | '));
    } finally { t.room.dispose(); }
  }

  // ── 과반수 동의: 3명(2명이면 되고, 반대가 많으면 취소) ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      const c = t.person('최민아');
      t.ready(a, b, c);
      t.room.begin(a.playerId);
      const [p, q] = t.notAnswer(2);
      t.cmd(a, `remove ${p}`);
      check('3명이면 2명(과반수)이 동의해야 한다', t.st(a).proposal.needed === 2 && t.st(a).proposal.total === 3);
      t.vote(b, false);
      check('한 명이 반대해도 아직 과반수가 될 수 있으면 이어진다', t.st(a).proposal !== null && t.st(a).proposal.refused === 1 && t.st(c).proposal.yourVote === null && t.st(b).proposal.yourVote === 'no');
      check('반대한 사람의 투표 상태가 목록에 보인다', same(t.st(a).players.map((x) => x.vote), ['yes', 'no', null]));
      t.vote(c, false);
      check('과반수가 될 수 없을 만큼 반대가 나오면 바로 취소된다(판은 그대로)', t.st(a).proposal === null && t.st(a).remaining === 16);
      check('취소 안내가 모두에게 간다', t.st(a).output.lines[0].includes('취소됐습니다') && t.st(a).output.lines[0].includes('김하늘님의 제안(후보 제거') && same(t.st(b).output, t.st(a).output), JSON.stringify(t.st(a).output));
      check('취소가 관리 로그에 남는다', t.logs.some((l) => l.includes('제안 취소')), t.logs.slice(-3).join(' | '));

      t.cmd(b, `remove ${q}`);
      t.vote(c, true);
      check('찬성이 과반수가 되면 나머지 한 명이 투표하기 전에 실행된다', t.st(a).remaining === 15 && t.st(a).proposal === null && t.st(a).output.title.includes('(동의 2/3명)'));
      check('이미 끝난 투표에 늦게 투표하면 거절한다', t.room.vote(a.playerId, 'x', true) === '종료된 투표입니다.');
      check('실행 뒤 새 제안을 낼 수 있다', t.cmd(c, `remove ${t.notAnswer(5).filter((id) => id !== p && id !== q)[0]}`) === null && t.st(a).proposal && t.st(a).proposal.byName === '최민아');
    } finally { t.room.dispose(); }
  }

  // ── 시간 초과 ──
  {
    const t = setup({ proposalTimeoutMs: 60 });
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);
      t.cmd(a, `remove ${t.notAnswer(1)[0]}`);
      const before = t.changes.length;
      await wait(180);
      check('답이 없으면 시간이 지나 제안이 취소된다(판은 그대로)', t.st(a).proposal === null && t.st(a).remaining === 16 && t.st(a).output.lines[0].includes('시간이 지나 취소됐습니다'), JSON.stringify(t.st(a).output));
      check('취소를 모두에게 알린다', t.changes.length > before);
      check('시간이 지난 투표에는 투표할 수 없다', typeof t.room.vote(b.playerId, 'x', true) === 'string');
    } finally { t.room.dispose(); }
  }

  // ── 접속자 기준: 끊기면 투표 인원에서 빠진다 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      const c = t.person('최민아');
      t.ready(a, b, c);
      t.room.begin(a.playerId);
      const [p, q] = t.notAnswer(2);
      t.cmd(a, `remove ${p}`);
      t.room.disconnect(b.playerId);
      const sa = t.st(a).proposal;
      check('투표 중에 한 명이 끊기면 접속자 2명이 기준이 된다(과반수 2명, 동의 1)', sa && sa.total === 2 && sa.needed === 2 && sa.agreed === 1 && t.st(a).voters === 2);
      check('끊긴 사람은 참가자 목록에 끊김으로 남는다(이번 판 참가자라서)', t.st(a).players.find((x) => x.nickname === '박서준').connected === false && t.st(a).players.length === 3);
      t.vote(c, true);
      check('남은 접속자의 과반수(2/2)가 동의하면 실행된다', t.st(a).remaining === 15 && t.st(a).proposal === null && t.st(a).output.title.includes('(동의 2/2명)'));
      const back = t.room.join({ nickname: '박서준', token: b.token });
      check('끊겼던 사람이 같은 토큰으로 돌아오면 같은 자리(이번 판 참가자)다', back.restored && back.playerId === b.playerId && t.st(b).you.inGame === true && t.st(b).remaining === 15);
      check('돌아오면 투표 인원이 다시 3명이다', t.st(a).voters === 3 && t.st(a).needed === 2);

      t.room.disconnect(b.playerId);
      t.room.disconnect(c.playerId);
      check('접속자가 혼자 남으면 그 한 명이 곧 과반수라 바로 실행된다(머리글 없음)', t.cmd(a, `remove ${q}`) === null && t.st(a).remaining === 14 && t.st(a).proposal === null && t.st(a).output.title === null && t.st(a).voters === 1);

      t.room.join({ nickname: '박서준', token: b.token });
      t.cmd(a, `remove ${t.notAnswer(8).filter((id) => ![p, q].includes(id))[0]}`);
      check('제안이 걸린 채 제안한 사람이 끊기면 제안은 취소된다', t.st(b).proposal !== null && (t.room.disconnect(a.playerId), t.st(b).proposal === null) && t.st(b).output.lines[0].includes('제안한 사람이 자리를 비워'), JSON.stringify(t.st(b).output));
    } finally { t.room.dispose(); }
  }

  // ── 정답 제출·다음 라운드·포기도 같은 방식 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);

      t.cmd(a, 'next');
      check('다음 라운드도 제안이 된다(동의 전에는 1라운드 그대로)', t.st(a).proposal && t.st(a).proposal.kind === 'next' && t.st(a).proposal.text === '다음 라운드로 넘어가기' && t.st(a).round === 1 && t.st(a).hints.length === 1);
      t.vote(b, true);
      check('동의하면 다음 힌트가 모두에게 나온다', t.st(a).round === 2 && t.st(b).hints.length === 2 && t.st(a).output.lines.join('\n').includes('[ROUND 2]'));

      const wrong = t.notAnswer(1)[0];
      t.cmd(b, `guess ${wrong}`);
      const pending = t.st(a);
      check('정답 제출도 제안이다: 동의 전에는 게임이 이어지고 정답은 없다', pending.proposal.kind === 'guess' && pending.proposal.text.startsWith(`정답 제출 - ${wrong}번`) && same(pending.proposal.numbers, [wrong])
        && pending.status === 'PLAYING' && pending.summary === null && findSecret(pending) === null && !JSON.stringify(pending).includes('정답:'));
      t.vote(a, true);
      const ended = t.st(a);
      check('동의하면 제출되고 틀리면 그 자리에서 끝난다: 정답·낸 답·해설(2개)이 모두에게 간다', ended.phase === 'result' && ended.status === 'LOST' && ended.summary.how === 'wrong' && ended.summary.guessed.id === wrong
        && ended.summary.answer.id === t.answer().id && ended.summary.explanations.length === 2 && same(t.st(b).summary, ended.summary), JSON.stringify(ended.summary && ended.summary.how));
      check('끝난 상태에도 후보의 특징·seed·계획은 없다', hasNoInternals(ended) && findSecret({ ...ended, summary: null }) === null);
      check('끝나면 준비가 풀리고 다시 준비해야 한다(목록·시작 가능 여부)', ended.players.every((x) => x.ready === false) && ended.canStart === false && ended.alone === false);
      check('끝난 뒤의 조작 명령은 종료 안내만 받고 판은 그대로다', t.cmd(a, 'remove 1') === null && t.st(a).reply.lines[0] === '게임이 종료되었습니다.' && t.st(a).status === 'LOST' && t.st(a).round === 2);
      check('끝난 뒤 도움말·목록·기록은 볼 수 있다', t.cmd(a, 'history') === null && t.st(a).reply.lines[0] === '[힌트 기록]' && t.cmd(a, 'list all') === null && t.st(a).reply.lines[0] === '[전체 후보]');
      check('오답으로 끝난 로그에 정답 이름이 남지 않는다', t.logs.some((l) => l.includes('오답으로 종료 (2라운드)')) && t.logs.every((l) => !l.includes(t.answer().name)), t.logs.slice(-4).join(' | '));

      // 다시 시작: 준비 → 시작
      check('준비한 사람이 없으면 다시 시작할 수 없다', typeof t.room.begin(a.playerId) === 'string');
      t.ready(a, b);
      check('둘 다 준비하고 restart 명령으로 새 판을 시작한다(두 번째 판은 `seed#1`)', t.cmd(b, 'restart') === null && t.st(a).status === 'PLAYING' && t.st(a).phase === 'playing' && t.st(a).summary === null && t.st(a).remaining === 16 && t.st(a).round === 1
        && t.st(a).candidates.every((x) => !x.wrong) && t.answer().id === answerOf(`${SEED}#1`).id);
    } finally { t.room.dispose(); }
  }
  {
    // 포기: 확인(제안자에게만) → 동의
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);
      t.cmd(a, 'quit');
      check('포기하면 먼저 제안자에게만 종료 확인(pendingQuit)을 묻는다', t.st(a).pendingQuit === true && t.st(b).pendingQuit === false && t.st(a).proposal === null && t.st(a).reply.lines[0] === '게임을 종료하시겠습니까? (y/n)');
      t.cmd(a, 'n');
      check('아니오면 계속한다(제안 없음)', t.st(a).pendingQuit === false && t.st(a).proposal === null && t.st(a).reply.lines[0] === '게임을 계속합니다.');
      t.cmd(a, 'quit');
      t.cmd(a, '글쎄');
      check('y/n이 아닌 대답은 다시 묻는다', t.st(a).pendingQuit === true && t.st(a).reply.lines[0] === 'y 또는 n 으로 답해주세요. (y/n)');
      t.cmd(a, 'y');
      check('예라고 하면 포기 제안이 되어 과반수 동의를 받는다', t.st(a).pendingQuit === false && t.st(a).proposal && t.st(a).proposal.kind === 'quit' && t.st(a).proposal.text === '게임 포기(종료)' && t.st(a).status === 'PLAYING');
      t.vote(b, true);
      check('동의하면 포기로 끝나고 정답은 공개되지 않는다', t.st(a).status === 'QUIT' && t.st(a).phase === 'result' && t.st(a).summary === null && findSecret(t.st(b)) === null);
      check('포기가 관리 로그에 남는다', t.logs.some((l) => l.includes('김하늘 포기')));
    } finally { t.room.dispose(); }
  }
  {
    // 마지막 라운드에서 다음 → 5라운드 종료
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);
      for (let round = 1; round < 5; round += 1) { t.cmd(a, 'next'); t.vote(b, true); }
      check('마지막 라운드의 다음 제안은 "마지막 라운드 끝내기"라고 알린다', t.st(a).round === 5 && (t.cmd(a, 'next'), t.st(a).proposal.text === '마지막 라운드 끝내기'));
      t.vote(b, true);
      check('동의하면 5라운드가 끝나 진다(정답 공개)', t.st(a).status === 'LOST' && t.st(a).summary.how === 'rounds' && t.st(a).summary.explanations.length === 5 && t.logs.some((l) => l.includes('실패 (5라운드 종료)')));
    } finally { t.room.dispose(); }
  }

  // ── 정답 후보 제거도 제안 → 동의 → 끝, 그리고 제안 단계에서는 정답 여부가 새지 않는다 ──
  {
    const proposeRemoval = (pickAnswer) => {
      const t = setup();
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);
      const target = pickAnswer ? t.answer().id : t.notAnswer(1)[0];
      t.cmd(a, `remove ${target}`);
      return { t, a, b, target };
    };
    const hit = proposeRemoval(true);
    const miss = proposeRemoval(false);
    try {
      const view = (x) => { const s = x.t.st(x.b); return { ...s, candidates: s.candidates.length, proposal: { ...s.proposal, id: 0, numbers: 0, text: 0 }, output: s.output && { ...s.output, lines: s.output.lines.length }, players: s.players.map((p) => ({ ...p, id: 0 })), you: { ...s.you, id: 0 } }; };
      const shape = (v) => JSON.stringify(Object.keys(v).sort());
      check('정답을 지우자는 제안과 아닌 후보를 지우자는 제안은 투표 중 구경할 수 있는 상태가 같다(정답 여부가 새지 않는다)',
        hit.t.st(hit.b).status === 'PLAYING' && miss.t.st(miss.b).status === 'PLAYING' && hit.t.st(hit.b).summary === null && shape(view(hit)) === shape(view(miss)) && same(view(hit).players, view(miss).players)
        && hit.t.st(hit.b).remaining === 16 && miss.t.st(miss.b).remaining === 16 && findSecret(hit.t.st(hit.b)) === null, JSON.stringify(view(hit)) + ' / ' + JSON.stringify(view(miss)));
      // 후보 목록(이름이 다 나와 있다)과 제안 문구·시작 글(후보 이름이 나온다)을 빼면, 정답 이름이 상태 어디에도 없어야 한다.
      const bare = (x) => { const s = x.t.st(x.b); return JSON.stringify({ ...s, candidates: null, output: null, proposal: s.proposal && { ...s.proposal, text: null } }); };
      check('제안·투표 중 상태에는(후보 목록·제안 문구를 빼면) 정답 이름이 어디에도 없다', [hit, miss].every((x) => !bare(x).includes(x.t.answer().name)), bare(hit));
      hit.t.vote(hit.b, true);
      miss.t.vote(miss.b, true);
      const lost = hit.t.st(hit.a);
      check('정답 후보를 지우는 제안이 통과되면 그 자리에서 끝나고 정답·해설이 모두에게 간다', lost.status === 'LOST' && lost.summary.how === 'removed' && lost.summary.answer.id === hit.target && lost.summary.explanations.length === 1
        && lost.candidates[hit.target - 1].removed && same(hit.t.st(hit.b).summary, lost.summary) && lost.output.lines.join('\n').includes('정답 후보를 지웠습니다.'));
      check('아닌 후보를 지우는 제안이 통과되면 게임은 이어지고 정답은 없다', miss.t.st(miss.a).status === 'PLAYING' && miss.t.st(miss.a).remaining === 15 && miss.t.st(miss.a).summary === null);
      check('관리 로그에 정답 후보를 지워서 종료한 것이 남고 정답 이름은 남지 않는다', hit.t.logs.some((l) => l.includes('정답 후보를 지워서 종료 (1라운드)')) && hit.t.logs.every((l) => !l.includes(hit.t.answer().name)), hit.t.logs.slice(-4).join(' | '));
    } finally { hit.t.room.dispose(); miss.t.room.dispose(); }
  }

  // ── 명령어: 제안 전에 걸러지는 입력, 나에게만 오는 답 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      check('판이 없을 때 조작 명령은 시작 안내를 받는다', t.cmd(a, 'remove 3') === null && t.st(a).reply.lines[0] === '아직 게임이 시작되지 않았습니다.' && t.cmd(a, 'list') === null && t.st(a).reply.lines[0] === '아직 게임이 시작되지 않았습니다.');
      t.ready(a, b);
      t.room.begin(a.playerId);
      t.changes.length = 0;
      t.cmd(a, 'help');
      check('도움말·목록·입력 오류는 그 사람에게만 답한다(상태도 그 사람에게만 알린다)', t.st(a).reply.lines[0] === '사용 가능한 명령어' && t.st(b).reply === null && same(t.changes, [a.playerId]), JSON.stringify(t.changes));
      check('list는 남은 후보를 보여 준다', t.cmd(a, 'list') === null && t.st(a).reply.lines[0] === '[남은 후보]' && t.st(a).reply.lines.length === 18);
      check('알 수 없는 명령어·숫자 아닌 번호는 안내만 받고 제안이 생기지 않는다', t.cmd(a, 'bogus') === null && t.st(a).reply.lines[0] === '알 수 없는 명령어입니다.' && t.cmd(a, 'remove abc') === null && t.st(a).reply.lines[0] === '후보 번호는 숫자로 입력해주세요.' && t.st(a).proposal === null);
      check('범위 밖 번호는 하나라도 섞이면 제안하지 않고 안내만 한다(원자적)', t.cmd(a, 'remove 1 99') === null && t.st(a).reply.lines[0] === '잘못된 후보 번호입니다.' && t.st(a).proposal === null && t.cmd(a, 'guess 0') === null && t.st(a).reply.lines[0] === '잘못된 후보 번호입니다.' && t.st(a).proposal === null);
      check('빈 줄은 아무 글도 만들지 않는다', (() => { const seq = t.st(a).reply.seq; t.cmd(a, ''); return t.st(a).reply.seq === seq; })());
      check('알 수 없는 참가자·글자 아닌 명령·너무 긴 명령은 거절한다', !!t.room.command('nope', 'next') && !!t.cmd(a, 5) && !!t.cmd(a, 'x'.repeat(101)) && t.cmd(a, 'x'.repeat(100)) === null);
      const [p] = t.notAnswer(1);
      t.cmd(a, `remove ${p} ${p}`);
      check('같은 번호를 두 번 써도 하나로 제안한다', same(t.st(a).proposal.numbers, [p]));
      t.vote(b, true);
      check('이미 지운 후보만 다시 지우려 하면 제안하지 않고 안내한다', t.cmd(a, `remove ${p}`) === null && t.st(a).reply.lines[0] === `${p}번 후보는 이미 제거되었습니다.` && t.st(a).proposal === null);
      check('이미 지운 후보는 정답으로 낼 수 없다(제안하지 않는다)', t.cmd(a, `guess ${p}`) === null && t.st(a).reply.lines[0] === `${p}번 후보는 이미 제거한 후보입니다.` && t.st(a).proposal === null);
      const [x, y] = t.notAnswer(3).filter((id) => id !== p);
      t.cmd(a, `remove ${p} ${x} ${y}`);
      check('이미 지운 후보가 섞여 있으면 빼고 제안한다', same(t.st(a).proposal.numbers, [x, y]));
    } finally { t.room.dispose(); }
  }

  // ── 나가기·정리·재접속·정원 ──
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      const c = t.person('최민아');
      const d = t.person('구경꾼');
      t.ready(a, b, c);
      t.room.begin(a.playerId);
      check('접속한 4명(참가자 3 + 구경 1)이 포털 인원으로 센다', t.room.status().playerCount === 4 && t.room.status().phase === 'playing');
      t.cmd(a, `remove ${t.notAnswer(1)[0]}`);
      t.room.leave(c.playerId);
      check('참가자가 나가면 투표 인원이 줄고(2/2) 목록에서 빠진다', t.st(c) === null && t.st(a).voters === 2 && t.st(a).proposal.total === 2 && t.st(a).players.length === 3);
      check('나간 사람의 명령·투표는 거절한다', !!t.cmd(c, 'next') && !!t.room.vote(c.playerId, 'x', true));
      t.room.leave(b.playerId);
      check('투표하던 제안의 남은 참가자가 혼자가 되면(제안자) 바로 실행된다', t.st(a).proposal === null && t.st(a).remaining === 15 && t.st(a).voters === 1);
      t.room.leave(a.playerId);
      check('참가자가 모두 나가면 판을 마치고 구경하던 사람은 대기실로 돌아간다', t.st(d).phase === 'lobby' && t.st(d).status === 'LOBBY' && t.st(d).candidates.length === 0 && t.st(d).alone === true && t.room.status().phase === 'lobby'
        && t.logs.some((l) => l.includes('참가자가 모두 나가 게임을 마침')));
      t.room.leave(d.playerId);
      check('모두 나가면 방이 처음 상태로 돌아간다', t.room.status().playerCount === 0 && t.room._debug().players.length === 0 && t.room._debug().session === null);
      const again = t.person('다시옴');
      check('빈 방에 다시 들어오면 새 대기실이다', t.st(again).phase === 'lobby' && t.st(again).players.length === 1);
      t.room.begin(again.playerId);
      check('방이 비워진 뒤의 첫 판도 처음 seed다(판 수가 처음부터 다시 센다)', t.answer().id === FIRST.id);
    } finally { t.room.dispose(); }
  }
  {
    const t = setup({ idleMs: 60 });
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      t.ready(a, b);
      t.room.begin(a.playerId);
      t.cmd(a, `remove ${t.notAnswer(1)[0]}`);
      t.room.disconnect(b.playerId);
      // 접속자가 혼자라 바로 실행되지 않게 하려고 제안 전에 끊는다
      check('끊기면 곧바로 참가자에서 빠지지 않는다(돌아올 수 있다)', t.st(b) !== null && t.st(a).players.length === 2);
      await wait(150);
      check('끊긴 채 오래 두면(idleMs) 자리를 정리하고 참가자에서도 뺀다', t.st(b) === null && t.room._debug().roster.length === 1 && t.st(a).players.length === 1);
      const r = t.room.join({ nickname: '박서준', token: b.token });
      check('정리된 자리의 토큰으로 돌아오면 새 사람이다(구경)', !r.restored && t.room.stateFor(r.playerId).you.inGame === false);
    } finally { t.room.dispose(); }
  }
  {
    const t = setup({ idleMs: 60 });
    try {
      const a = t.person('김하늘');
      t.room.disconnect(a.playerId);
      await wait(30);
      t.room.join({ nickname: '김하늘', token: a.token });
      await wait(100);
      check('유예 안에 돌아오면 정리 타이머가 취소된다', t.st(a) !== null && t.room.status().playerCount === 1);
    } finally { t.room.dispose(); }
  }
  {
    const t = setup();
    try {
      const people = Array.from({ length: ROOM_CAPACITY }, (_, i) => t.person(`사람${i + 1}`));
      check(`정원(${ROOM_CAPACITY}명)이 차고 모두 접속 중이면 새로 들어올 수 없다`, !!t.room.join({ nickname: '넘침' }).error && t.room.status().playerCount === ROOM_CAPACITY);
      t.room.disconnect(people[3].playerId);
      const next = t.room.join({ nickname: '새사람' });
      check('끊긴 대기실 자리가 있으면 그 자리를 비우고 받는다', !next.error && t.st(people[3]) === null && t.room.status().playerCount === ROOM_CAPACITY);
      check('토큰으로 돌아온 사람은 정원이 차 있어도 자기 자리로 돌아온다', t.room.join({ nickname: '사람1', token: people[0].token }).restored === true);
    } finally { t.room.dispose(); }
  }
  {
    const t = setup();
    try {
      const a = t.person('김하늘');
      const b = t.person('박서준');
      check('보스 키로 화면을 가려도 아무 일이 없다(제한시간이 없는 게임)', t.room.setCovered(a.playerId, true) === undefined && t.st(a).phase === 'lobby');
      t.ready(a, b);
      t.room.begin(a.playerId);
      t.cmd(a, `remove ${t.notAnswer(1)[0]}`);
      t.room.setCovered(b.playerId, true);
      check('가려도 제안은 그대로 남는다', t.st(b).proposal !== null && t.st(b).status === 'PLAYING');
    } finally { t.room.dispose(); }
  }

  // ── 실제 서버(WebSocket) ──
  const port = 4812;
  const original = console.error;
  console.error = () => {};
  // 테스트에서만: 모든 판을 고정한다. 정답을 맞히거나 지우는 길을 보려면 정답을 알아야 한다.
  const server = createGameServer({ port, host: '127.0.0.1', galpangSeed: SEED });
  await server.start();
  try {
    const open = async (game, nickname, token) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?game=${game}`);
      const inbox = [];
      ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      if (nickname) ws.send(JSON.stringify({ type: 'join', nickname, token }));
      return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)), last: (type) => [...inbox].reverse().find((m) => m.type === type) };
    };
    const a = await open('galpang', '김하늘');
    await wait(150);
    const welcome = a.last('welcome');
    check('접속하면 welcome(토큰)과 대기실 상태가 온다', !!welcome && !!welcome.token && a.last('galpangState').phase === 'lobby' && a.last('galpangState').players.length === 1);

    const b = await open('galpang', '박서준');
    await wait(150);
    check('다른 사람이 들어오면 먼저 있던 사람 화면에 실시간으로 나타난다', same(a.last('galpangState').players.map((p) => p.nickname), ['김하늘', '박서준']) && b.last('galpangState').players.length === 2);
    const c = await open('galpang', '최민아');
    await wait(150);

    a.send({ type: 'ready', ready: true });
    b.send({ type: 'ready', ready: true });
    await wait(150);
    check('준비한 상태가 모두에게 보인다', a.last('galpangState').readyCount === 2 && c.last('galpangState').players.filter((p) => p.ready).length === 2 && a.last('galpangState').canStart === true);
    c.send({ type: 'start' });
    await wait(200);
    const sa = a.last('galpangState');
    check('시작하면 준비한 두 명은 참가자, 한 명은 구경이다(같은 판을 본다)', sa.phase === 'playing' && sa.you.inGame === true && c.last('galpangState').you.inGame === false && same(c.last('galpangState').candidates, sa.candidates) && sa.candidates.length === 16);

    const [p, q] = IDS.filter((id) => id !== FIRST.id);
    a.send({ type: 'command', line: `remove ${p} ${q}` });
    await wait(200);
    const pa = a.last('galpangState').proposal;
    check('제안이 참가자·구경꾼 모두에게 간다(찬성 1/2)', pa && b.last('galpangState').proposal.id === pa.id && c.last('galpangState').proposal.id === pa.id && pa.agreed === 1 && pa.needed === 2 && a.last('galpangState').remaining === 16);
    check('구경꾼은 투표할 수 없다(canVote 거짓)', c.last('galpangState').proposal.canVote === false && b.last('galpangState').proposal.canVote === true);
    const beforeWatch = c.inbox.length;
    c.send({ type: 'vote', proposalId: pa.id, agree: true });
    await wait(150);
    check('구경꾼이 투표해도 거절된다(판이 그대로)', c.inbox.slice(beforeWatch).some((m) => m.type === 'error') && a.last('galpangState').remaining === 16);
    b.send({ type: 'vote', proposalId: pa.id, agree: true });
    await wait(200);
    check('참가자가 동의하면 모두의 화면에서 지워진다(같은 공통 글)', a.last('galpangState').remaining === 14 && c.last('galpangState').remaining === 14 && a.last('galpangState').proposal === null
      && same(a.last('galpangState').output, c.last('galpangState').output) && a.last('galpangState').output.title.includes('(동의 2/2명)'));

    // 개인 답은 그 사람에게만
    const seenB = b.inbox.length;
    a.send({ type: 'command', line: 'help' });
    await wait(150);
    check('도움말은 요청한 사람에게만 간다(남의 연결에는 아무 메시지도 가지 않는다)', a.last('galpangState').reply.lines[0] === '사용 가능한 명령어' && b.inbox.length === seenB);

    // 잘못된 요청
    const before = a.inbox.length;
    a.send({ type: 'command' });
    a.send({ type: 'command', line: 'x'.repeat(101) });
    a.send({ type: 'ready', ready: 'true' });
    a.send({ type: 'vote', agree: true });
    a.send({ type: 'vote', proposalId: 'x', agree: 'yes' });
    a.send({ type: 'play' });
    a.send({ type: 'nope' });
    await wait(200);
    const errors = a.inbox.slice(before).filter((m) => m.type === 'error');
    check('형식이 틀린 요청(줄 없음·너무 긴 줄·불리언 아님·투표 번호 없음·다른 게임 요청·모르는 type)은 모두 거절한다', errors.length === 7 && errors.every((e) => e.message === '잘못된 요청입니다.') && a.inbox.slice(before).every((m) => m.type === 'error'), String(errors.length));
    a.send({ type: 'vote', proposalId: 'x'.repeat(10), agree: true });
    await wait(120);
    check('끝난 투표 번호로 보낸 투표는 안내와 함께 거절한다', a.last('error').message === '종료된 투표입니다.');

    check('서버가 보낸 모든 상태에 비공개 키·정답이 없다', [a, b, c].every((x) => x.inbox.filter((m) => m.type === 'galpangState').every((m) => findSecret(m) === null && !JSON.stringify(m).includes('정답:'))));

    // 정답 제출도 같은 방식으로: 제안 → 동의 → 정답 공개
    b.send({ type: 'command', line: `guess ${FIRST.id}` });
    await wait(200);
    check('정답 제출 제안 중에는 정답이 상태에 없다(맞는 후보를 냈어도 동의 전에는 모른다)', a.last('galpangState').proposal.kind === 'guess' && a.last('galpangState').status === 'PLAYING' && a.last('galpangState').summary === null && c.last('galpangState').summary === null);
    a.send({ type: 'vote', proposalId: a.last('galpangState').proposal.id, agree: true });
    await wait(200);
    const won = a.last('galpangState');
    check('동의하면 WON이고 정답·해설이 참가자와 구경꾼 모두에게 간다', won.status === 'WON' && won.phase === 'result' && won.summary.answer.name === FIRST.name && c.last('galpangState').summary.answer.name === FIRST.name && won.output.lines.join('\n').includes('정답입니다!'));
    check('이긴 상태에도 후보의 특징·seed·계획은 없다', hasNoInternals(won) && hasNoInternals(c.last('galpangState')));

    // 재접속: 같은 토큰이면 같은 자리
    const aToken = welcome.token;
    const second = await open('galpang', '김하늘', aToken);
    await wait(200);
    check('같은 토큰의 새 연결은 같은 자리로 돌아온다(결과 화면 유지)', second.last('galpangState') && second.last('galpangState').you.id === welcome.playerId && second.last('galpangState').phase === 'result');
    check('앞의 연결은 replaced로 밀려난다', !!a.last('replaced'));

    // 다시 시작: 모두 다시 준비
    second.send({ type: 'start' });
    await wait(150);
    check('끝난 뒤에는 준비 없이 시작할 수 없다(여럿이 있을 때)', second.last('error') && typeof second.last('error').message === 'string' && second.last('galpangState').phase === 'result');
    second.send({ type: 'ready', ready: true });
    b.send({ type: 'ready', ready: true });
    await wait(120);
    second.send({ type: 'start' });
    await wait(200);
    check('다시 준비하고 시작하면 새 판이다(남은 후보 16개·정답 비공개)', second.last('galpangState').phase === 'playing' && second.last('galpangState').remaining === 16 && second.last('galpangState').summary === null && b.last('galpangState').phase === 'playing');

    // 포털과 보스 키
    const portal = await open('portal');
    await wait(150);
    const games = portal.last('games');
    check('포털에 갈팡질팡 채널의 인원·상태가 나온다', games && games.games.galpang && games.games.galpang.label === '갈팡질팡' && games.games.galpang.playerCount === 3 && games.games.galpang.status === '진행중', JSON.stringify(games && games.games.galpang));
    second.send({ type: 'cover' });
    await wait(150);
    check('갈팡질팡에서 가린 보스 키가 포털·다른 접속자에게도 퍼진다', !!portal.last('cover') && !!b.last('cover') && !!c.last('cover'));
    second.send({ type: 'coverState', covered: true });
    await wait(100);
    check('화면을 가렸다고 알려도(coverState) 오류 없이 받는다', !second.inbox.some((m) => m.type === 'error' && m.message !== '종료된 투표입니다.' && m.message !== '잘못된 요청입니다.' && !String(m.message).includes('준비')));

    // 나가기
    c.send({ type: 'leave' });
    await wait(200);
    check('나가기: left를 받고, 남은 사람 화면의 참가자 목록에서 빠진다', !!c.last('left') && same(b.last('galpangState').players.map((x) => x.nickname), ['김하늘', '박서준']));
    check('나가면 포털 인원이 줄어든다', portal.last('games').games.galpang.playerCount === 2, JSON.stringify(portal.last('games').games.galpang));
    for (const x of [a, b, c, second, portal]) x.ws.close();
    await wait(200);

    // 이름이 길어도 잘려 들어온다
    const longName = await open('galpang', '가'.repeat(40));
    await wait(150);
    check('긴 이름은 24글자로 잘려 들어온다', longName.last('galpangState').you.nickname === '가'.repeat(24));
    longName.ws.close();
    const emptyJoin = await open('galpang');
    emptyJoin.send({ type: 'command', line: 'next' });
    await wait(120);
    check('입장하기 전의 명령은 거절한다', emptyJoin.last('error') && emptyJoin.last('error').message === '먼저 입장해 주세요.');
    emptyJoin.ws.close();
  } finally {
    await server.stop();
    console.error = original;
  }

  console.log(`\n갈팡질팡 서버: ${pass}개 통과, ${fail}개 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
