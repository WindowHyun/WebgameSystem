'use strict';

/**
 * 얼굴 보기 - 같은 링크(방 코드)로 들어온 사람들이 서로의 카메라를 보는 프로그램의 서버 쪽 방.
 *
 * 서버는 영상을 보지도, 받지도, 저장하지도 않는다. 영상은 브라우저끼리 직접(WebRTC) 오가고, 서버는 그 연결을 맺는 데
 * 필요한 짧은 신호(offer·answer)를 같은 방 안에서만 전달한다. 이 파일은 방과 참가자 목록·정원·요청 형식만 맡고 소켓은
 * 모른다(연결은 web/game-server.js가 맡는다).
 *
 * [방 코드] 링크에 들어 있는 코드가 곧 방이다. 코드를 아는 사람만 들어올 수 있으니 길고 추측하기 어려운 코드를 쓴다.
 * [정원] 참가자마다 나머지 모두와 직접 연결하는 방식(mesh)이라 인원이 늘면 각자의 업로드가 그만큼 늘어난다. 그래서
 *        한 방은 MAX_PEERS(6)명까지다. 더 늘리려면 영상을 중계하는 서버(SFU)가 필요하다.
 * [동의] 입장하면 카메라가 켜져 방 사람들에게 보인다는 것을 입장 화면이 먼저 알린다. 이 방은 그 안내에 대한 동의를
 *        따로 확인하지 않는다(입장이 곧 동의) - 알리는 일과 켜는 일은 화면 쪽이 맡는다.
 */

const crypto = require('crypto');
const { cleanNickname, LIMITS } = require('./protocol');
const { uniqueName } = require('./room-helpers');

const MAX_PEERS = 6;
const MAX_ROOMS = 200;
const ROOM_CODE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
// 브라우저가 만든 SDP(영상 하나)는 보통 3~8KB다. 웹소켓 메시지 한도(16KB)보다 작게 잡아 JSON 감싸기 분량을 남긴다.
const MAX_SDP = 12000;

/** 방 코드를 소문자로 맞추고, 알파벳·숫자·-·_ 3~32자가 아니면 null. */
function normalizeRoom(code) {
  if (typeof code !== 'string') return null;
  const clean = code.trim().toLowerCase();
  return ROOM_CODE.test(clean) ? clean : null;
}

const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= LIMITS.id;

/**
 * 브라우저가 보내는 요청의 형식 검사. 맞으면 null, 아니면 이유. (규칙은 방이 판단한다 - 방 코드가 올바른지 같은 것.)
 *   join      { room, nickname, token? }   입장. token은 받기만 하고 쓰지 않는다(재접속은 새 참가자로 들어온다)
 *   signal    { to, kind: 'offer'|'answer', sdp }   같은 방 안의 한 사람에게 연결 신호
 *   camState  { on }   내 카메라를 켰는지 끈 것인지(상대 화면에 "꺼짐"을 보이려고)
 *   ping, leave
 */
function validateCamMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'message';
  switch (msg.type) {
    case 'ping':
    case 'leave':
      return null;
    case 'join':
      if (typeof msg.room !== 'string' || msg.room.length > 64) return 'room';
      if (typeof msg.nickname !== 'string' || !msg.nickname.trim() || msg.nickname.length > LIMITS.nicknameInput) return 'nickname';
      if (msg.token !== undefined && msg.token !== null && (typeof msg.token !== 'string' || msg.token.length > LIMITS.token)) return 'token';
      return null;
    case 'signal':
      if (!id(msg.to)) return 'to';
      if (msg.kind !== 'offer' && msg.kind !== 'answer') return 'kind';
      if (typeof msg.sdp !== 'string' || !msg.sdp || msg.sdp.length > MAX_SDP) return 'sdp';
      return null;
    case 'camState':
      return typeof msg.on === 'boolean' ? null : 'on';
    default:
      return 'type';
  }
}

/**
 * 방 목록과 참가자. 참가자는 { id, room, nickname }이고, 연결(소켓)은 이 파일이 모른다.
 * options: { maxPeers, maxRooms, makeId } - 시험에서 바꿔 끼운다.
 */
function createCamHub(options) {
  const opts = options || {};
  const maxPeers = Number.isInteger(opts.maxPeers) ? opts.maxPeers : MAX_PEERS;
  const maxRooms = Number.isInteger(opts.maxRooms) ? opts.maxRooms : MAX_ROOMS;
  const makeId = opts.makeId || (() => crypto.randomBytes(8).toString('hex'));
  const rooms = new Map(); // 방 코드 → Map(참가자 id → 참가자)
  const peers = new Map(); // 참가자 id → 참가자

  const othersIn = (room, exceptId) => [...room.values()].filter((p) => p.id !== exceptId).map((p) => ({ id: p.id, nickname: p.nickname }));

  /** 방에 들어온다. 성공하면 { peerId, room, nickname, others }(others는 먼저 와 있던 사람들), 아니면 { error }. */
  function join(roomCode, nickname) {
    const code = normalizeRoom(roomCode);
    if (!code) return { error: '방 코드가 올바르지 않습니다.' };
    const clean = cleanNickname(nickname);
    if (!clean) return { error: '이름을 입력해 주세요.' };
    let room = rooms.get(code);
    if (!room) {
      if (rooms.size >= maxRooms) return { error: '지금은 새 방을 만들 수 없습니다. 잠시 뒤 다시 시도해 주세요.' };
      room = new Map();
    }
    if (room.size >= maxPeers) return { error: `방이 가득 찼습니다. (최대 ${maxPeers}명)` };
    const used = new Set([...room.values()].map((p) => p.nickname));
    const peer = { id: makeId(), room: code, nickname: uniqueName(used, clean, makeId) };
    const others = othersIn(room, peer.id);
    room.set(peer.id, peer);
    rooms.set(code, room);
    peers.set(peer.id, peer);
    return { peerId: peer.id, room: code, nickname: peer.nickname, others };
  }

  /** 방에서 나간다. { room, others: [남은 사람 id…] }를 돌려주고, 없는 참가자면 null. 빈 방은 지운다. */
  function leave(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return null;
    peers.delete(peerId);
    const room = rooms.get(peer.room);
    room.delete(peerId);
    if (!room.size) rooms.delete(peer.room);
    return { room: peer.room, nickname: peer.nickname, others: [...room.keys()] };
  }

  /** 같은 방의 다른 참가자 id들. */
  function othersOf(peerId) {
    const peer = peers.get(peerId);
    const room = peer && rooms.get(peer.room);
    return room ? [...room.keys()].filter((other) => other !== peerId) : [];
  }

  /** 두 참가자가 지금 같은 방에 있는가. 신호는 이 경우에만 전달한다(남의 방으로 새지 않게). */
  function sameRoom(a, b) {
    const first = peers.get(a);
    const second = peers.get(b);
    return !!first && !!second && a !== b && first.room === second.room;
  }

  const nicknameOf = (peerId) => (peers.has(peerId) ? peers.get(peerId).nickname : null);
  const counts = () => ({ rooms: rooms.size, peers: peers.size });
  function dispose() { rooms.clear(); peers.clear(); }

  return { join, leave, othersOf, sameRoom, nicknameOf, counts, dispose };
}

module.exports = { createCamHub, validateCamMessage, normalizeRoom, MAX_PEERS, MAX_ROOMS, MAX_SDP };
