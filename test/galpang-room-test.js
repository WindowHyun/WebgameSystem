'use strict';

/**
 * 갈팡질팡 서버 쪽(web/galpang-room.js + web/game-server.js) - 방 단위 + 실제 WebSocket.
 *
 *   [방]     사람마다 판이 따로다(서로 영향이 없다). 같은 토큰이면 진행 중이던 판으로 돌아온다. 나가면 판이 사라진다.
 *            끊긴 판은 오래 두면 버린다. 정원이 차면 끊긴 판부터 비우고, 모두 접속 중이면 받지 않는다
 *   [비공개] 어떤 상태 메시지에도 정답·해설·후보의 특징·seed가 없다(끝나기 전). 끝난 뒤에는 정답과 해설이 간다.
 *            관리 로그에도 정답 이름이 남지 않는다
 *   [서버]   명령어 한 줄로 모든 조작이 된다. 잘못된 요청은 거절하고, 포털에 인원·상태가 나오며, 보스 키가 퍼진다
 *
 * 실행: node test/galpang-room-test.js
 */

const WebSocket = require('ws');
const { createGalpangRoom } = require('../web/galpang-room');
const { createGameServer } = require('../web/game-server');
const { GameEngine } = require('../web/galpang/engine');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ── 방 ──
(async () => {
  {
    const changes = [];
    const logs = [];
    const room = createGalpangRoom({ onChange: (id) => changes.push(id), onAction: (who, what) => logs.push(`${who} ${what}`), seed: 100 });
    try {
      const a = room.join({ nickname: '김하늘' });
      const b = room.join({ nickname: '박서준' });
      check('입장하면 바로 새 게임이 시작된다(준비·시작 없음)', a.playerId && !a.restored && room.stateFor(a.playerId).status === 'PLAYING' && room.stateFor(a.playerId).round === 1);
      check('빈 이름은 받지 않는다', !!room.join({ nickname: '   ' }).error && !!room.join({}).error);
      check('입장·상태 알림은 그 사람에게만 간다(onChange에 참가자 id가 실린다)', same(changes, [a.playerId, b.playerId]), JSON.stringify(changes));

      const state = room.stateFor(a.playerId);
      check('상태 모양: 후보 16개·힌트 1개·라운드·남은 후보·본인·참가자', state.type === 'galpangState' && state.candidates.length === 16 && state.hints.length === 1 && state.round === 1
        && state.maxRound === 5 && state.remaining === 16 && state.you.id === a.playerId && state.players.length === 1 && state.players[0].nickname === '김하늘' && state.summary === null && state.pendingQuit === false);
      check('게임 중 상태 메시지에 정답·해설·특징·seed가 없다', findSecret(state) === null, findSecret(state));

      // 사람마다 판이 따로다.
      room.command(a.playerId, 'remove 1 2 3');
      room.command(a.playerId, 'next');
      check('A의 조작이 B의 판에 영향을 주지 않는다', room.stateFor(a.playerId).remaining === 13 && room.stateFor(a.playerId).round === 2
        && room.stateFor(b.playerId).remaining === 16 && room.stateFor(b.playerId).round === 1);
      const out1 = room.stateFor(a.playerId).output;
      check('명령 결과 글은 번호(seq)와 함께 상태에 실린다', out1 && out1.seq === 2 && out1.lines.join('\n').includes('[ROUND 2]'), JSON.stringify(out1));
      room.command(a.playerId, 'remove abc');
      check('글이 나올 때마다 번호가 하나씩 오른다', room.stateFor(a.playerId).output.seq === 3 && room.stateFor(a.playerId).output.lines[0] === '후보 번호는 숫자로 입력해주세요.');
      room.command(a.playerId, '');
      check('빈 줄은 글을 만들지 않는다(번호 그대로)', room.stateFor(a.playerId).output.seq === 3);
      check('새로 들어온 사람은 아직 결과 글이 없다', room.stateFor(b.playerId).output === null);

      check('알 수 없는 참가자·글자 아닌 명령·너무 긴 명령은 거절한다', !!room.command('nope', 'next') && !!room.command(a.playerId, 5) && !!room.command(a.playerId, 'x'.repeat(101)) && !room.command(a.playerId, 'x'.repeat(100)));

      // 재접속
      const token = a.token;
      room.disconnect(a.playerId);
      check('끊겨도 판은 그대로 남는다', room.stateFor(a.playerId).remaining === 13 && room.status().playerCount === 1);
      const back = room.join({ nickname: '김하늘', token });
      check('같은 토큰으로 돌아오면 진행 중이던 판(라운드·제거 상태)이 그대로다', back.restored && back.playerId === a.playerId && room.stateFor(a.playerId).round === 2 && room.stateFor(a.playerId).remaining === 13);
      check('토큰이 다르면 새 판이다', !room.join({ nickname: '김하늘', token: 'x'.repeat(32) }).restored);

      // 끝난 뒤에만 정답
      const win = room.join({ nickname: '정답자' });
      const debug = room._debug().players.find((p) => p.id === win.playerId);
      const answer = debug.session.engine.state.answer;
      check('게임 중에는 정답이 상태에 실리지 않는다', findSecret(room.stateFor(win.playerId)) === null && !JSON.stringify(room.stateFor(win.playerId)).includes('정답:'));
      room.command(win.playerId, 'guess ' + answer.id);
      const done = room.stateFor(win.playerId);
      check('맞히면 정답과 힌트 해설이 상태에 실린다(summary)', done.status === 'WON' && done.summary.answer.name === answer.name && done.summary.explanations.length === 1 && done.summary.explanations[0].reason.includes(answer.name));
      check('끝난 뒤에도 후보의 특징·카테고리·seed·계획은 실리지 않는다', ['tags', 'category', 'parents', 'seed', 'plan', 'side', 'axis'].every((k) => !JSON.stringify(done).includes(`"${k}"`)));
      check('관리 로그에 정답 이름이 남지 않는다', logs.length > 5 && logs.every((line) => !line.includes(answer.name)) && logs.some((line) => line.includes('정답 (1라운드)')), logs.join(' | '));
      room.command(win.playerId, 'restart');
      check('restart하면 새 판이 시작되고 상태가 초기화된다', room.stateFor(win.playerId).status === 'PLAYING' && room.stateFor(win.playerId).summary === null && room.stateFor(win.playerId).remaining === 16);

      // 오답은 한 번이면 끝이고, 그때 정답이 공개된다
      const loser = room.join({ nickname: '오답자' });
      const lostAnswer = room._debug().players.find((p) => p.id === loser.playerId).session.engine.state.answer;
      const lostWrong = lostAnswer.id === 1 ? 2 : 1;
      room.command(loser.playerId, 'next');
      check('오답을 내기 전에는 정답이 상태에 없다', findSecret(room.stateFor(loser.playerId)) === null && room.stateFor(loser.playerId).summary === null);
      room.command(loser.playerId, `guess ${lostWrong}`);
      const lost = room.stateFor(loser.playerId);
      check('오답이면 그 자리에서 끝나고(LOST) 정답·낸 답·공개된 힌트(2개)의 해설이 상태에 실린다', lost.status === 'LOST' && lost.round === 2 && lost.summary.how === 'wrong' && lost.summary.answer.name === lostAnswer.name
        && lost.summary.guessed.id === lostWrong && lost.summary.explanations.length === 2 && lost.candidates.filter((c) => c.wrong).length === 1, JSON.stringify(lost.summary && { how: lost.summary.how, n: lost.summary.explanations.length }));
      check('오답으로 끝난 상태에도 후보의 특징·카테고리·seed·계획은 실리지 않는다', ['tags', 'category', 'parents', 'seed', 'plan', 'side', 'axis'].every((k) => !JSON.stringify(lost).includes(`"${k}"`)));
      const afterLost = JSON.stringify(room.stateFor(loser.playerId).candidates);
      room.command(loser.playerId, 'next');
      room.command(loser.playerId, `guess ${lostAnswer.id}`);
      room.command(loser.playerId, 'remove 1');
      check('오답으로 끝난 뒤에는 종료 안내만 나오고 판은 그대로다(다시 맞힐 수 없다)', room.stateFor(loser.playerId).status === 'LOST' && room.stateFor(loser.playerId).round === 2
        && JSON.stringify(room.stateFor(loser.playerId).candidates) === afterLost && room.stateFor(loser.playerId).output.lines[0] === '게임이 종료되었습니다.');
      check('관리 로그에 오답 종료가 남고 정답 이름은 남지 않는다', logs.some((line) => line.includes('오답자 오답으로 종료 (2라운드)')) && logs.every((line) => !line.includes(lostAnswer.name) && !line.includes(answer.name)), logs.slice(-4).join(' | '));
      room.leave(loser.playerId);

      // 포기 확인
      room.command(b.playerId, 'quit');
      check('quit: 종료 확인 대기(pendingQuit)가 상태에 실린다', room.stateFor(b.playerId).pendingQuit === true && room.stateFor(b.playerId).status === 'PLAYING');
      room.command(b.playerId, 'y');
      check('확인하면 QUIT이고 정답은 실리지 않는다', room.stateFor(b.playerId).status === 'QUIT' && room.stateFor(b.playerId).summary === null && findSecret(room.stateFor(b.playerId)) === null);

      // 상태(포털)
      const status = room.status();
      check('status: 접속 중인 사람 수(김하늘·박서준·토큰 다른 새 판·정답자)와 진행 여부', status.playerCount === 4 && status.phase === 'playing', JSON.stringify(status));

      // 나가기
      room.leave(a.playerId);
      check('나가면 그 판이 사라진다', room.stateFor(a.playerId) === null && room.status().playerCount === 3);
      check('나간 사람의 명령은 거절한다', !!room.command(a.playerId, 'next'));
      check('보스 키로 화면을 가려도 아무 일이 없다(제한시간이 없는 게임)', room.setCovered(win.playerId, true) === undefined && room.stateFor(win.playerId).status === 'PLAYING');
    } finally { room.dispose(); }
  }

  // 정원·유휴 정리
  {
    const room = createGalpangRoom({ maxSessions: 3, idleMs: 60 });
    try {
      const ids = [1, 2, 3].map((n) => room.join({ nickname: `사람${n}` }));
      check('정원이 차고 모두 접속 중이면 새 판을 받지 않는다', !!room.join({ nickname: '넷째' }).error);
      room.disconnect(ids[1].playerId);
      const fourth = room.join({ nickname: '넷째' });
      check('끊긴 판이 있으면 그것부터 비우고 새 판을 받는다', !fourth.error && room.stateFor(ids[1].playerId) === null && room.status().playerCount === 3);
      room.disconnect(ids[0].playerId);
      await wait(150);
      check('끊긴 채 오래 두면 판을 버린다(idleMs 뒤)', room.stateFor(ids[0].playerId) === null);
      check('접속 중인 판은 유지된다', room.stateFor(ids[2].playerId) !== null && room.stateFor(fourth.playerId) !== null);
      const r = room.join({ nickname: '돌아옴', token: ids[0].token });
      check('버려진 판의 토큰으로 돌아오면 새 판이다', !r.restored);
    } finally { room.dispose(); }
  }
  {
    const room = createGalpangRoom({ idleMs: 60 });
    try {
      const a = room.join({ nickname: '김하늘' });
      room.disconnect(a.playerId);
      await wait(30);
      room.join({ nickname: '김하늘', token: a.token });
      await wait(100);
      check('유예 안에 돌아오면 정리 타이머가 취소된다', room.stateFor(a.playerId) !== null && room.status().playerCount === 1);
    } finally { room.dispose(); }
  }

  // ── 실제 서버(WebSocket) ──
  const port = 4812;
  const original = console.error;
  console.error = () => {};
  // 테스트에서만: 모든 접속의 첫 판을 seed 7로 고정한다. 정답을 맞히는 길을 보려면 정답을 알아야 한다.
  const SEED = 7;
  const firstAnswer = new GameEngine({ seed: SEED }).state.answer;
  const awayFrom = (...ids) => Array.from({ length: 16 }, (_, i) => i + 1).filter((id) => !ids.includes(id));
  const [pickA, pickB] = awayFrom(firstAnswer.id); // 정답이 아닌 후보 둘(지워도 정답 제출에 지장이 없다)
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
    const client = await open('galpang', '테스터');
    await wait(150);
    const welcome = client.last('welcome');
    check('접속하면 welcome(토큰)과 상태가 온다', !!welcome && !!welcome.token && client.last('galpangState').status === 'PLAYING');

    client.send({ type: 'command', line: `remove ${pickA} ${pickB}` });
    client.send({ type: 'command', line: 'next' });
    client.send({ type: 'command', line: 'bogus' });
    await wait(200);
    const s = client.last('galpangState');
    check('명령어로 모든 조작이 된다(remove·next·알 수 없는 명령)', s.remaining === 14 && s.round === 2 && s.hints.length === 2 && s.output.lines[0] === '알 수 없는 명령어입니다.', JSON.stringify(s.output));
    check('서버가 보낸 모든 상태에 비공개 키가 없다', client.inbox.filter((m) => m.type === 'galpangState').every((m) => findSecret(m) === null));
    check('상태 메시지 어디에도 정답 단어를 가리키는 "정답:" 글이 없다(끝나기 전)', client.inbox.filter((m) => m.type === 'galpangState').every((m) => !JSON.stringify(m).includes('정답:')));

    // 잘못된 요청
    const before = client.inbox.length;
    client.send({ type: 'command' });
    client.send({ type: 'command', line: 'x'.repeat(101) });
    client.send({ type: 'ready', ready: true });
    client.send({ type: 'start' });
    client.send({ type: 'play' });
    client.send({ type: 'nope' });
    await wait(200);
    const errors = client.inbox.slice(before).filter((m) => m.type === 'error');
    check('형식이 틀린 요청(줄 없음·너무 긴 줄·다른 게임 요청·모르는 type)은 모두 거절한다', errors.length === 6 && errors.every((e) => e.message === '잘못된 요청입니다.') && client.inbox.slice(before).every((m) => m.type === 'error'), String(errors.length));
    check('거절된 요청은 판 상태를 바꾸지 않는다', client.last('galpangState').round === 2);

    // 맞히면 정답·해설이 온다(틀린 답은 한 번이면 끝이라, 같은 판의 정답을 알고 있어야 이 길을 볼 수 있다)
    client.send({ type: 'command', line: `guess ${firstAnswer.id}` });
    await wait(150);
    const won = client.last('galpangState');
    check('정답을 내면 WON이고 정답·해설(공개된 힌트 2개)이 온다', won.status === 'WON' && !!won.summary && won.summary.answer.name === firstAnswer.name && won.summary.explanations.length === 2 && won.output.lines.join('\n').includes('정답입니다!'));
    check('이긴 상태 메시지에도 후보의 특징·seed·계획은 없다', ['tags', 'category', 'parents', 'seed', 'plan', 'axis'].every((k) => !JSON.stringify(won).includes(`"${k}"`)));
    client.send({ type: 'command', line: 'restart' });
    await wait(150);
    check('restart로 새 판이 시작된다', client.last('galpangState').status === 'PLAYING' && client.last('galpangState').summary === null && client.last('galpangState').remaining === 16);

    // 재접속: 같은 토큰이면 같은 판
    client.send({ type: 'command', line: 'remove 4 5 6' });
    await wait(100);
    const second = await open('galpang', '테스터', welcome.token);
    await wait(200);
    check('같은 토큰의 새 연결은 진행 중이던 판으로 돌아온다(제거 3개 유지)', second.last('galpangState') && second.last('galpangState').remaining === 13);
    check('앞의 연결은 replaced로 밀려난다', !!client.last('replaced'));
    second.send({ type: 'command', line: 'next' });
    await wait(100);
    check('새 연결에서 이어서 조작할 수 있다', second.last('galpangState').round === 2);

    // 다른 사람과는 판이 갈린다
    const other = await open('galpang', '다른사람');
    await wait(150);
    check('다른 사람의 판은 새 판이다(남의 진행이 보이지 않는다)', other.last('galpangState').round === 1 && other.last('galpangState').remaining === 16);
    other.send({ type: 'command', line: 'remove 1' });
    await wait(100);
    const seen = second.inbox.length;
    other.send({ type: 'command', line: 'remove 2' });
    await wait(150);
    check('남이 조작해도 내 연결에는 아무 메시지도 가지 않는다', second.inbox.length === seen);

    // 포털과 보스 키
    const portal = await open('portal');
    await wait(150);
    const games = portal.last('games');
    check('포털에 갈팡질팡 채널의 인원·상태가 나온다', games && games.games.galpang && games.games.galpang.label === '갈팡질팡' && games.games.galpang.playerCount === 2 && games.games.galpang.status === '진행중', JSON.stringify(games && games.games.galpang));
    second.send({ type: 'cover' });
    await wait(150);
    check('갈팡질팡에서 가린 보스 키가 포털·다른 접속자에게도 퍼진다', !!portal.last('cover') && !!other.last('cover'));
    second.send({ type: 'coverState', covered: true });
    await wait(100);
    check('화면을 가렸다고 알려도(coverState) 오류 없이 받는다', !second.inbox.some((m) => m.type === 'error'));

    // 나가기
    second.send({ type: 'leave' });
    await wait(150);
    check('나가기: left를 받는다', !!second.last('left'));
    await wait(100);
    check('나가면 포털 인원이 줄어든다', portal.last('games').games.galpang.playerCount === 1, JSON.stringify(portal.last('games').games.galpang));
    for (const c of [client, second, other, portal]) c.ws.close();

    // 틀린 답은 한 번이면 끝: 새 접속(같은 seed의 첫 판)으로 확인한다
    const loser = await open('galpang', '오답자');
    await wait(150);
    check('새 접속의 첫 판은 고정한 seed의 판이다(정답은 아직 상태에 없다)', loser.last('galpangState').status === 'PLAYING' && loser.last('galpangState').summary === null && findSecret(loser.last('galpangState')) === null);
    const wrongPick = firstAnswer.id === 1 ? 2 : 1;
    loser.send({ type: 'command', line: `guess ${wrongPick}` });
    await wait(150);
    const lostState = loser.last('galpangState');
    check('틀린 답을 내면 그 자리에서 LOST이고 정답이 온다(오답 안내·정답 이름·낸 답)', lostState.status === 'LOST' && lostState.summary.how === 'wrong' && lostState.summary.answer.name === firstAnswer.name
      && lostState.summary.guessed.id === wrongPick && lostState.output.lines.join('\n').includes('오답입니다.') && lostState.output.lines.join('\n').includes(`정답: ${firstAnswer.name}`));
    check('오답으로 끝난 상태 메시지에도 후보의 특징·seed·계획은 없다', ['tags', 'category', 'parents', 'seed', 'plan', 'axis'].every((k) => !JSON.stringify(lostState).includes(`"${k}"`)));
    loser.send({ type: 'command', line: `guess ${firstAnswer.id}` });
    loser.send({ type: 'command', line: 'next' });
    await wait(150);
    check('오답으로 끝난 뒤에는 정답을 다시 내도 이길 수 없다(종료 안내만 온다)', loser.last('galpangState').status === 'LOST' && loser.last('galpangState').output.lines[0] === '게임이 종료되었습니다.');
    loser.send({ type: 'command', line: 'restart' });
    await wait(150);
    check('오답으로 끝난 뒤 restart하면 새 판이다', loser.last('galpangState').status === 'PLAYING' && loser.last('galpangState').summary === null && loser.last('galpangState').candidates.every((c) => !c.wrong));
    loser.ws.close();

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
