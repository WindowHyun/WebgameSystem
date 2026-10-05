'use strict';

/**
 * 얼굴 보기 서버 쪽 방(web/cam-room.js).
 *
 *   [방]     방 코드는 소문자로 맞추고 형식이 틀리면 거절한다. 같은 코드는 같은 방, 다른 코드는 다른 방이다
 *   [참가]   들어오면 먼저 와 있던 사람 목록을 받고, 이름이 겹치면 번호가 붙고, 정원(6명)이 차면 거절한다
 *   [신호]   같은 방 사람끼리만 신호를 주고받을 수 있다(자기 자신·다른 방·나간 사람에게는 못 보낸다)
 *   [나가기] 나가면 남은 사람 목록을 알려 주고, 빈 방은 사라진다. 방 수에도 한도가 있다
 *   [형식]   브라우저가 보내는 요청을 검사한다(방 코드·이름·신호 종류·SDP 크기·카메라 켬 여부)
 *
 * 실행: node test/cam-room-test.js
 */

const { createCamHub, validateCamMessage, normalizeRoom, MAX_PEERS, MAX_SDP } = require('../web/cam-room');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 방 코드 ──
check('방 코드는 소문자로 맞춘다(앞뒤 공백도 뺀다)', normalizeRoom('  Room-A_1 ') === 'room-a_1');
check('3~32자의 알파벳·숫자·-·_만 받는다', normalizeRoom('abc') === 'abc' && normalizeRoom('a'.repeat(32)) === 'a'.repeat(32)
  && ['ab', 'a'.repeat(33), '-abc', 'a b c', 'a/b/c', '방코드', '', null, undefined, 123, {}].every((v) => normalizeRoom(v) === null));

// ── 참가 ──
{
  let n = 0;
  const hub = createCamHub({ makeId: () => `p${(n += 1)}` });
  const a = hub.join('Room1', '김하늘');
  check('첫 사람은 먼저 와 있던 사람이 없는 상태로 들어온다(방 코드는 소문자로)', a.peerId === 'p1' && a.room === 'room1' && a.nickname === '김하늘' && same(a.others, []));
  const b = hub.join('room1', '박서준');
  check('같은 코드(대소문자 무시)면 같은 방이고, 먼저 와 있던 사람 목록을 받는다', same(b.others, [{ id: 'p1', nickname: '김하늘' }]) && same(hub.othersOf('p1'), ['p2']));
  const c = hub.join('room1', '김하늘');
  check('이름이 겹치면 번호가 붙는다', c.nickname === '김하늘(2)');
  const other = hub.join('room2', '김하늘');
  check('다른 코드는 다른 방이다(이름이 겹쳐도 번호가 안 붙고, 서로 보이지 않는다)', other.nickname === '김하늘' && same(other.others, []) && same(hub.othersOf(other.peerId), []) && hub.othersOf('p1').length === 2);
  check('잘못된 방 코드·빈 이름은 거절한다', typeof hub.join('x', '이름').error === 'string' && typeof hub.join('room1', '   ').error === 'string' && typeof hub.join('room1', null).error === 'string');
  check('방 수·참가자 수를 센다', same(hub.counts(), { rooms: 2, peers: 4 }));
  hub.dispose();
  check('dispose하면 모두 비운다', same(hub.counts(), { rooms: 0, peers: 0 }));
}

// ── 정원 ──
{
  const hub = createCamHub();
  const joined = Array.from({ length: MAX_PEERS }, (_, i) => hub.join('full-room', `사람${i + 1}`));
  check(`한 방은 ${MAX_PEERS}명까지 들어온다(마지막 사람은 앞의 ${MAX_PEERS - 1}명을 받는다)`, joined.every((j) => !j.error) && joined[MAX_PEERS - 1].others.length === MAX_PEERS - 1);
  const over = hub.join('full-room', '넘침');
  check('정원이 차면 거절하고 안내한다', typeof over.error === 'string' && over.error.includes(`최대 ${MAX_PEERS}명`) && hub.counts().peers === MAX_PEERS);
  check('다른 방은 정원과 상관없이 들어온다', !hub.join('other-room', '넘침').error);
  hub.leave(joined[0].peerId);
  check('한 명이 나가면 다시 들어올 수 있다', !hub.join('full-room', '새사람').error);
  hub.dispose();
}

// ── 신호 ──
{
  const hub = createCamHub();
  const a = hub.join('room1', '가');
  const b = hub.join('room1', '나');
  const c = hub.join('room2', '다');
  check('같은 방 사람끼리는 신호를 보낼 수 있다', hub.sameRoom(a.peerId, b.peerId) && hub.sameRoom(b.peerId, a.peerId));
  check('다른 방 사람에게는 신호를 보낼 수 없다(남의 방으로 새지 않는다)', !hub.sameRoom(a.peerId, c.peerId));
  check('자기 자신에게는 보낼 수 없다', !hub.sameRoom(a.peerId, a.peerId));
  check('없는 사람에게는 보낼 수 없다', !hub.sameRoom(a.peerId, 'nobody') && !hub.sameRoom('nobody', a.peerId));
  hub.leave(b.peerId);
  check('나간 사람에게는 보낼 수 없다', !hub.sameRoom(a.peerId, b.peerId));
  check('이름 조회: 있는 사람은 이름, 없는 사람은 null', hub.nicknameOf(a.peerId) === '가' && hub.nicknameOf(b.peerId) === null);
  hub.dispose();
}

// ── 나가기 ──
{
  let n = 0;
  const hub = createCamHub({ makeId: () => `p${(n += 1)}` });
  const a = hub.join('room1', '가');
  hub.join('room1', '나');
  const left = hub.leave(a.peerId);
  check('나가면 남은 사람 id와 방·이름을 알려 준다', same(left, { room: 'room1', nickname: '가', others: ['p2'] }));
  check('없는 참가자를 또 내보내면 null이다(두 번 나가기를 견딘다)', hub.leave(a.peerId) === null && hub.leave('nobody') === null);
  hub.leave('p2');
  check('마지막 사람이 나가면 방이 사라진다', same(hub.counts(), { rooms: 0, peers: 0 }));
  const small = createCamHub({ maxRooms: 2 });
  small.join('room-1', '가');
  small.join('room-2', '나');
  check('방 수 한도가 차면 새 방을 만들 수 없지만 있는 방에는 들어온다', typeof small.join('room-3', '다').error === 'string' && !small.join('room-1', '라').error);
  small.leave(small.join('room-4', '마').peerId || 'x');
  small.dispose();
}

// ── 요청 형식 ──
{
  const ok = (m) => validateCamMessage(m) === null;
  const bad = (m) => typeof validateCamMessage(m) === 'string';
  check('ping·leave는 내용이 없어도 된다', ok({ type: 'ping' }) && ok({ type: 'leave' }));
  check('join: 방 코드·이름이 문자열이면 형식은 맞다(토큰은 있어도 없어도 된다)', ok({ type: 'join', room: 'room1', nickname: '김하늘' }) && ok({ type: 'join', room: 'room1', nickname: '김하늘', token: null }) && ok({ type: 'join', room: 'room1', nickname: '김하늘', token: 'abc' }));
  check('join: 방 코드·이름이 문자열이 아니거나 비었거나 너무 길면 거절한다', [
    { type: 'join' }, { type: 'join', room: 1, nickname: 'a' }, { type: 'join', room: 'x'.repeat(65), nickname: 'a' },
    { type: 'join', room: 'room1' }, { type: 'join', room: 'room1', nickname: '   ' }, { type: 'join', room: 'room1', nickname: 'a'.repeat(65) },
    { type: 'join', room: 'room1', nickname: 'a', token: 5 }, { type: 'join', room: 'room1', nickname: 'a', token: 'x'.repeat(65) },
  ].every(bad));
  check('signal: 대상·종류(offer/answer)·SDP가 맞으면 통과한다', ok({ type: 'signal', to: 'p1', kind: 'offer', sdp: 'v=0\r\n' }) && ok({ type: 'signal', to: 'p1', kind: 'answer', sdp: 'v=0' }));
  check('signal: 대상이 없거나 종류가 다르거나(candidate 등) SDP가 비었거나 한도를 넘으면 거절한다', [
    { type: 'signal', kind: 'offer', sdp: 'v=0' }, { type: 'signal', to: '', kind: 'offer', sdp: 'v=0' }, { type: 'signal', to: 'x'.repeat(65), kind: 'offer', sdp: 'v=0' },
    { type: 'signal', to: 'p1', kind: 'candidate', sdp: 'v=0' }, { type: 'signal', to: 'p1', sdp: 'v=0' },
    { type: 'signal', to: 'p1', kind: 'offer' }, { type: 'signal', to: 'p1', kind: 'offer', sdp: '' }, { type: 'signal', to: 'p1', kind: 'offer', sdp: 5 },
    { type: 'signal', to: 'p1', kind: 'offer', sdp: 'x'.repeat(MAX_SDP + 1) },
  ].every(bad) && ok({ type: 'signal', to: 'p1', kind: 'offer', sdp: 'x'.repeat(MAX_SDP) }));
  check('camState: 켬/끔은 불리언이어야 한다', ok({ type: 'camState', on: true }) && ok({ type: 'camState', on: false }) && bad({ type: 'camState' }) && bad({ type: 'camState', on: 'true' }));
  check('모르는 type·객체가 아닌 값·배열은 거절한다', bad({ type: 'chat', text: 'x' }) && bad({}) && bad(null) && bad('join') && bad(5) && bad([{ type: 'ping' }]) && bad(undefined));
}

console.log(`\n얼굴 보기 방: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
