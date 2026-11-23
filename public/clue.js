/**
 * 클루 화면. 규칙과 판정은 전부 서버(web/clue-room.js)가 한다 - 이 화면은 받은 상태를 그리고 버튼을 서버에 전할 뿐이다
 * (주사위도 카드 나누기도 서버가 한다). 연결 유지·재접속은 public/game-socket.js가 한다(다른 카드 게임과 같다).
 */
(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'clue-game-token';
  var NOTES_KEY = 'clue-notes';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var CELL = 24;
  var state = null;
  var skew = 0;            // 서버 시계 - 내 시계
  var accuseOpen = false;
  var populated = false;
  var marks = {};          // 추리 노트에 직접 적은 표시 { 카드: 0~3 }
  var marksSig = null;
  var hintSeq = null;      // 마지막으로 알린 힌트 뽑기 번호(접속·재접속 때 이미 지난 것은 알리지 않는다)
  var peekedCount = null;  // 같이 본 카드 수(새로 봤을 때만 팝업)
  var accusedSeq = null;   // 마지막으로 알린 고발 번호(접속·재접속 때 이미 지난 고발은 알리지 않는다)
  var alertedSeq = null;   // 결과(누가 보여 줬는지)까지 알린 추측 번호
  var logFilter = 'all';   // 추리 기록 보기: all | mine | others
  var showingDisprove = false; // 카드 보여 주기 패널이 이미 떠 있었는지(처음 뜰 때만 화면을 옮긴다)
  var seenCount = null;    // 지금까지 받은 카드 수(새로 받았을 때만 팝업을 띄운다. 접속·재접속 때는 띄우지 않는다)

  var COLORS = { scarlett: '#d72c0d', mustard: '#ecb22e', white: '#ffffff', green: '#2e8b57', peacock: '#1264a3', plum: '#7b3f9e' };
  var DARK_TEXT = { mustard: true, white: true };
  var PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  var PHASE = { lobby: '대기 중', playing: '진행 중', result: '게임 종료' };
  var MARK_TEXT = ['', '✕', '?', '✓'];
  var MARK_CLASS = ['', 'no', 'maybe', 'yes'];

  function $(id) { return document.getElementById(id); }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function first(text) { return Array.from(text || '?')[0]; }

  $('rules-copy').innerHTML = $('rules').innerHTML;

  var socket = null;
  function send(type, extra) { if (socket) socket.send(type, extra); }

  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    clearTimeout(errorTimer);
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }

  var drawn = {};
  function setHtml(id, html) {
    if (drawn[id] === html) return;
    drawn[id] = html;
    $(id).innerHTML = html;
  }

  /** 누르는 즉시 버튼을 잠그고 다음 상태(또는 오류)가 오면 푼다. 서버까지 왕복하는 동안 두 번 눌리는 것을 막는다. */
  var sending = [];
  var sendingTimer = null;
  function markSending(button) {
    button.classList.add('sending');
    button.disabled = true;
    sending.push(button);
    clearTimeout(sendingTimer);
    sendingTimer = setTimeout(function () { releaseSending(); if (state) render(); }, 1500);
  }
  function releaseSending() {
    sending.forEach(function (button) { button.classList.remove('sending'); button.disabled = false; });
    sending = [];
    clearTimeout(sendingTimer);
  }

  function labelOf(list, key) {
    var found = list.filter(function (item) { return item.key === key; })[0];
    return found ? found.label : key;
  }
  function suspectLabel(key) { return labelOf(state.suspects, key); }
  function weaponLabel(key) { return labelOf(state.weapons, key); }
  function roomLabel(key) { return key === 'envelope' ? '정답 봉투' : labelOf(state.rooms, key); }
  function cardLabel(key) {
    var all = state.suspects.concat(state.weapons, state.rooms);
    return labelOf(all, key);
  }
  function cardKind(key) {
    if (state.suspects.some(function (s) { return s.key === key; })) return 'suspect';
    if (state.weapons.some(function (w) { return w.key === key; })) return 'weapon';
    return 'room';
  }

  // ───────────────────────────── 보드 ─────────────────────────────

  var ROOM_FILL = { kitchen: '#f4d9c6', ballroom: '#e4d4f0', conservatory: '#cfe8d0', dining: '#f1e0b8', billiard: '#c9e2ea', library: '#e8cfc0', lounge: '#f0c9cf', hall: '#d9d9ec', study: '#d6dfc4' };
  var WEAPON_ICON = { candlestick: '🕯️', dagger: '🗡️', leadPipe: '🔩', revolver: '🔫', rope: '➰', wrench: '🔧' };
  var SLOT = 26;

  function tokenSvg(x, y, kind, key) {
    if (kind === 'suspect') {
      var dark = DARK_TEXT[key] ? '#1d1c1d' : '#fff';
      return '<g class="token" filter="url(#sh)"><title>' + escapeHtml(suspectLabel(key)) + '</title><circle cx="' + x + '" cy="' + y + '" r="11.5" fill="' + COLORS[key] + '" stroke="#fff" stroke-width="2"/>'
        + '<text x="' + x + '" y="' + (y + 4.5) + '" text-anchor="middle" font-size="12" font-weight="700" fill="' + dark + '">' + escapeHtml(first(suspectLabel(key))) + '</text></g>';
    }
    return '<g class="token" filter="url(#sh)"><title>' + escapeHtml(weaponLabel(key)) + '</title><rect x="' + (x - 10) + '" y="' + (y - 10) + '" width="20" height="20" rx="5" fill="#2f2a3a" stroke="#fff" stroke-width="1.5"/>'
      + '<text x="' + x + '" y="' + (y + 5) + '" text-anchor="middle" font-size="14">' + WEAPON_ICON[key] + '</text></g>';
  }

  function mapHtml() {
    var map = state.map;
    var you = state.you;
    var W = map.w * CELL;
    var H = map.h * CELL;
    var reach = you && you.reach ? you.reach : { cells: [], rooms: [] };
    var out = '<defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#000" flood-opacity=".55"/></filter></defs>'
      + '<rect width="' + W + '" height="' + H + '" fill="#2b1d12"/>';

    var inRect = function (r, x, y) { return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2; };
    var doors = {};
    map.rooms.forEach(function (room) { room.doors.forEach(function (d) { doors[d.x + ',' + d.y] = true; }); });
    var hintCells = {};
    (map.hintCells || []).forEach(function (h) { hintCells[h.x + ',' + h.y] = true; });
    for (var y = 0; y < map.h; y += 1) {
      for (var x = 0; x < map.w; x += 1) {
        if (inRect(map.center, x, y) || map.rooms.some(function (r) { return inRect(r, x, y); })) continue;
        var isHint = !!hintCells[x + ',' + y];
        var fill = isHint ? '#f7d774' : doors[x + ',' + y] ? '#e6c46a' : ((x + y) % 2 ? '#f3e7c8' : '#ebdcb5');
        out += '<rect x="' + x * CELL + '" y="' + y * CELL + '" width="' + CELL + '" height="' + CELL + '" fill="' + fill + '"/>';
        if (isHint) out += '<g><title>힌트 칸: 여기서 이동을 마치면 힌트 카드를 뽑습니다</title><text x="' + (x * CELL + CELL / 2) + '" y="' + (y * CELL + CELL / 2 + 6) + '" text-anchor="middle" font-size="17" font-weight="700" fill="#8a5a00">★</text></g>';
      }
    }

    // 가운데 정답 봉투
    var c = map.center;
    var cw = (c.x2 - c.x1 + 1) * CELL;
    var ch = (c.y2 - c.y1 + 1) * CELL;
    var ccx = c.x1 * CELL + cw / 2;
    var ccy = c.y1 * CELL + ch / 2;
    out += '<rect x="' + c.x1 * CELL + '" y="' + c.y1 * CELL + '" width="' + cw + '" height="' + ch + '" fill="#2d1b3d" stroke="#d4a73c" stroke-width="3"/>'
      + '<rect x="' + (c.x1 * CELL + 6) + '" y="' + (c.y1 * CELL + 6) + '" width="' + (cw - 12) + '" height="' + (ch - 12) + '" fill="none" stroke="#d4a73c" stroke-opacity=".5"/>'
      + '<g transform="translate(' + (ccx - 24) + ',' + (ccy - 30) + ')"><rect width="48" height="34" rx="4" fill="#f5e6b8" stroke="#d4a73c" stroke-width="1.5"/><path d="M1 2 L24 21 L47 2" fill="none" stroke="#d4a73c" stroke-width="1.5"/></g>'
      + '<text x="' + ccx + '" y="' + (ccy + 30) + '" text-anchor="middle" font-size="14" font-weight="700" fill="#ecb22e">정답 봉투</text>';

    // 방
    var slots = { envelope: { room: { key: 'envelope', label: '정답 봉투', x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 }, count: 0 } };
    map.centerDoors.forEach(function (d) {
      var bar;
      if (d.y === c.y1 - 1) bar = [d.x * CELL + 4, c.y1 * CELL - 3, CELL - 8, 6];
      else if (d.y === c.y2 + 1) bar = [d.x * CELL + 4, (c.y2 + 1) * CELL - 3, CELL - 8, 6];
      else if (d.x === c.x1 - 1) bar = [c.x1 * CELL - 3, d.y * CELL + 4, 6, CELL - 8];
      else bar = [(c.x2 + 1) * CELL - 3, d.y * CELL + 4, 6, CELL - 8];
      out += '<rect x="' + bar[0] + '" y="' + bar[1] + '" width="' + bar[2] + '" height="' + bar[3] + '" rx="2" fill="#e6c46a" stroke="#7a5a1a" stroke-width="1.2"/>';
    });
    map.rooms.forEach(function (room) {
      var x = room.x1 * CELL; var y = room.y1 * CELL;
      var w = (room.x2 - room.x1 + 1) * CELL; var h = (room.y2 - room.y1 + 1) * CELL;
      out += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + (ROOM_FILL[room.key] || '#e8dff0') + '" stroke="#3b2a1a" stroke-width="3"/>'
        + '<rect x="' + (x + 5) + '" y="' + (y + 5) + '" width="' + (w - 10) + '" height="' + (h - 10) + '" fill="none" stroke="#fff" stroke-opacity=".65"/>'
        + '<text x="' + (x + w / 2) + '" y="' + (y + 22) + '" text-anchor="middle" font-size="14" font-weight="700" fill="#3b2a1a">' + escapeHtml(room.label) + '</text>';
      if (room.passage) {
        out += '<text x="' + (x + w / 2) + '" y="' + (y + h - 9) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#6a3f8e">⇄ ' + escapeHtml(roomLabel(room.passage)) + '</text>';
      }
      // 문: 방 벽에 금색 문짝을 그린다
      room.doors.forEach(function (d) {
        var bar;
        if (d.y === room.y2 + 1) bar = [d.x * CELL + 4, y + h - 3, CELL - 8, 6];
        else if (d.y === room.y1 - 1) bar = [d.x * CELL + 4, y - 3, CELL - 8, 6];
        else if (d.x === room.x1 - 1) bar = [x - 3, d.y * CELL + 4, 6, CELL - 8];
        else bar = [x + w - 3, d.y * CELL + 4, 6, CELL - 8];
        out += '<rect x="' + bar[0] + '" y="' + bar[1] + '" width="' + bar[2] + '" height="' + bar[3] + '" rx="2" fill="#e6c46a" stroke="#7a5a1a" stroke-width="1.2"/>';
      });
      slots[room.key] = { room: room, count: 0 };
    });
    function place(slot) {
      var r = slot.room;
      var perRow = Math.max(1, Math.floor(((r.x2 - r.x1 + 1) * CELL - 12) / SLOT));
      var n = slot.count;
      slot.count += 1;
      return { x: r.x1 * CELL + 6 + SLOT / 2 + (n % perRow) * SLOT, y: r.y1 * CELL + (r.key === 'envelope' ? 18 : 40) + Math.floor(n / perRow) * SLOT };
    }

    // 이동 가능 표시
    var overlay = '';
    reach.cells.forEach(function (cell) {
      overlay += '<rect class="reach-cell" data-move="1" data-x="' + cell.x + '" data-y="' + cell.y + '" x="' + (cell.x * CELL + 1) + '" y="' + (cell.y * CELL + 1) + '" width="' + (CELL - 2) + '" height="' + (CELL - 2) + '" rx="4"><title>여기로 이동</title></rect>';
    });
    reach.rooms.forEach(function (key) {
      var room = slots[key].room;
      overlay += '<rect class="reach-room" data-move="1" data-room="' + key + '" x="' + (room.x1 * CELL + 4) + '" y="' + (room.y1 * CELL + 4) + '" width="' + ((room.x2 - room.x1 + 1) * CELL - 8) + '" height="' + ((room.y2 - room.y1 + 1) * CELL - 8) + '" rx="8"><title>' + escapeHtml(room.label) + '(으)로 이동</title></rect>';
    });

    // 말과 흉기
    var seatBySuspect = {};
    state.board.forEach(function (b) { seatBySuspect[b.suspect] = b; });
    var tokens = '';
    state.suspects.forEach(function (s) {
      var at = state.positions[s.key];
      if (!at) return;
      var seat = seatBySuspect[s.key];
      var mine = state.you && state.you.suspect === s.key;
      var turn = seat && state.phase === 'playing' && seat.id === state.waitingId;
      var p = at.room ? place(slots[at.room]) : { x: at.x * CELL + CELL / 2, y: at.y * CELL + CELL / 2 };
      var ring = '';
      if (turn) ring = '<circle class="turn-ring" cx="' + p.x + '" cy="' + p.y + '" r="15" fill="none" stroke="#ecb22e" stroke-width="3"/>';
      else if (mine) ring = '<circle cx="' + p.x + '" cy="' + p.y + '" r="14" fill="none" stroke="#4a154b" stroke-width="2" stroke-dasharray="4 3"/>';
      var gone = seat && seat.left && !seat.eliminated; // 탈락한 사람의 말은 주인 없는 말처럼 보드에 남는다
      tokens += ring + '<g opacity="' + (gone ? '.4' : '1') + '">' + tokenSvg(p.x, p.y, 'suspect', s.key) + '</g>';
    });
    state.weapons.forEach(function (w) {
      var slot = slots[state.weaponRooms[w.key]];
      if (!slot) return;
      var p = place(slot);
      tokens += tokenSvg(p.x, p.y, 'weapon', w.key);
    });
    return out + tokens + overlay;
  }

  // ───────────────────────────── 주사위·패널 ─────────────────────────────

  function dieHtml(value, fresh) {
    var on = PIPS[value] || [];
    var pips = '';
    for (var cell = 1; cell <= 9; cell += 1) pips += '<i' + (on.indexOf(cell) >= 0 ? ' class="on"' : '') + '></i>';
    return '<div class="die' + (value ? '' : ' empty') + (fresh ? ' rolled' : '') + '" role="img" aria-label="' + (value ? '주사위 ' + value : '아직 굴리지 않은 주사위') + '">' + pips + '</div>';
  }

  function disproveHtml() {
    var d = state.you && state.you.disprove;
    if (!d) return '';
    var asker = '';
    state.board.forEach(function (b) { if (b.id === d.byId) asker = b.nickname; });
    return '<b>카드를 보여 주세요</b><p class="panel-note">' + escapeHtml(asker) + '님의 추측: ' + escapeHtml(suspectLabel(d.suspect)) + ', ' + escapeHtml(weaponLabel(d.weapon)) + ', ' + escapeHtml(roomLabel(d.room))
      + '. 가진 카드 중 하나를 눌러 ' + escapeHtml(asker) + '님에게만 보여 줍니다. (한 장뿐이어도 직접 눌러 주세요)</p>'
      + d.options.map(function (card) { return '<button type="button" class="pick-card" data-card="' + card + '">' + escapeHtml(cardLabel(card)) + ' 보여 주기</button>'; }).join('');
  }

  function populate() {
    if (populated) return;
    populated = true;
    $('map').setAttribute('viewBox', '0 0 ' + state.map.w * CELL + ' ' + state.map.h * CELL);
    function fill(id, list) { $(id).innerHTML = list.map(function (item) { return '<option value="' + item.key + '">' + escapeHtml(item.label) + '</option>'; }).join(''); }
    fill('sg-suspect', state.suspects); fill('sg-weapon', state.weapons);
    fill('ac-suspect', state.suspects); fill('ac-weapon', state.weapons); fill('ac-room', state.rooms);
  }

  // ───────────────────────────── 추리 노트 ─────────────────────────────

  function loadMarks() {
    var sig = state.you.hand.join(',');
    if (marksSig === sig) return;
    marksSig = sig;
    marks = {};
    try {
      var saved = JSON.parse(sessionStorage.getItem(NOTES_KEY) || 'null');
      if (saved && saved.sig === sig && saved.marks) marks = saved.marks;
    } catch (e) { marks = {}; }
  }
  function saveMarks() {
    try { sessionStorage.setItem(NOTES_KEY, JSON.stringify({ sig: marksSig, marks: marks })); } catch (e) { /* 저장 실패는 무시 */ }
  }

  function notebookHtml() {
    var you = state.you;
    var mine = {};
    you.hand.forEach(function (card) { mine[card] = true; });
    var seen = {};
    you.seen.forEach(function (s) { (seen[s.card] = seen[s.card] || []).push(s.by); });
    var peekedCards = {};
    you.peeked.forEach(function (p) { peekedCards[p.card] = true; });
    // 탈락한 사람의 공개된 카드는 정답이 아님이 확실하다(누구의 카드였는지도 적는다).
    var openedBy = {};
    state.board.forEach(function (b) { (b.opened || []).forEach(function (card) { openedBy[card] = b.nickname; }); });
    function rows(title, list) {
      return '<table><tr><th colspan="3">' + title + '</th></tr>' + list.map(function (item) {
        var known = seen[item.key] || peekedCards[item.key] || openedBy[item.key];
        var cls = mine[item.key] ? 'mine' : (known ? 'seen' : '');
        var note = mine[item.key] ? '내 카드' : (seen[item.key] ? escapeHtml(seen[item.key].filter(function (name, i, all) { return all.indexOf(name) === i; }).join(', ')) + '님이 보여 줌' : (peekedCards[item.key] ? '같이 본 카드' : (openedBy[item.key] ? escapeHtml(openedBy[item.key]) + '님 카드(공개)' : '')));
        var m = marks[item.key] || 0;
        var markCell = mine[item.key] || known
          ? '<td class="mark no">✕</td>'
          : '<td class="mark ' + MARK_CLASS[m] + '" data-mark="' + item.key + '" role="button" tabindex="0" aria-label="' + escapeHtml(item.label) + ' 표시 바꾸기">' + (MARK_TEXT[m] || '·') + '</td>';
        return '<tr class="' + cls + '"><td class="label">' + escapeHtml(item.label) + '</td>' + markCell + '<td class="note">' + note + '</td></tr>';
      }).join('') + '</table>';
    }
    return '<b>추리 노트</b><div class="nb-grid">' + rows('범인', state.suspects) + rows('흉기', state.weapons) + rows('장소', state.rooms) + '</div>'
      + '<p class="hint">칸을 누르면 ✕(아님) → ?(의심) → ✓(유력) 순으로 바뀝니다. 내 카드와 보여 준 카드는 자동으로 ✕가 되고, 누가 카드를 보여 주면 그 추측의 나머지 카드는 자동으로 ?가 됩니다.</p>';
  }

  /** 방금 받은 카드를 팝업으로 보여 준다. 어떤 추측에 누가 보여 줬는지도 함께. */
  function showSeen(entry) {
    $('seen-title').textContent = '카드를 받았습니다';
    $('seen-from').textContent = entry.by + '님이 보여 준 카드';
    $('seen-card').textContent = cardLabel(entry.card);
    $('seen-card').className = 'seen-face ' + cardKind(entry.card);
    $('seen-ask').textContent = '내 추측: ' + suspectLabel(entry.suspect) + ', ' + weaponLabel(entry.weapon) + ', ' + roomLabel(entry.room);
    $('seen-popup').classList.remove('hidden');
    $('seen-ok').focus();
  }
  function closeSeen() { $('seen-popup').classList.add('hidden'); }
  function checkSeen() {
    var list = state.you.seen;
    if (seenCount !== null && list.length > seenCount) showSeen(list[list.length - 1]);
    if (list.length < (seenCount || 0)) closeSeen();
    seenCount = list.length;
  }

  // ───────────────────────────── 알림(추측·카드 보여 줌) ─────────────────────────────

  function toast(html, cls, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.innerHTML = html + '<button type="button" class="toast-close" aria-label="알림 닫기">✕</button>';
    var box = $('toasts');
    box.appendChild(el);
    while (box.children.length > 2) box.removeChild(box.firstChild);
    function remove() { if (el.parentNode) el.parentNode.removeChild(el); }
    el.onclick = remove;
    setTimeout(remove, ms || 5000);
  }
  /** 받침에 따라 붙이는 말: 이/가, 으로/로 */
  function jong(word) { var c = Array.from(word || '').pop(); var n = c ? c.charCodeAt(0) - 0xAC00 : -1; return n >= 0 && n < 11172 ? n % 28 : -1; }
  function iga(word) { return jong(word) > 0 ? '이' : '가'; }
  function euro(word) { var j = jong(word); return j > 0 && j !== 8 ? '으로' : '로'; }
  function sentence(ls) {
    var who = suspectLabel(ls.suspect); var weapon = weaponLabel(ls.weapon); var room = roomLabel(ls.room);
    return who + iga(who) + ' ' + weapon + euro(weapon) + ' ' + room + '에서 죽였다.';
  }
  function chip(kind, label) { return '<span class="chip ' + kind + '">' + escapeHtml(label) + '</span>'; }

  /**
   * 누군가 카드를 보여 줬으면 그 추측의 세 장(범인·흉기·장소) 중 아직 ✕가 아닌 카드를 노트에서 ?로 바꾼다.
   * 셋 중 적어도 한 장은 보여 준 사람의 손에 있으니 정답이 아닐 수 있고, 어느 것인지는 아직 모르기 때문이다.
   * 내 카드·받은 카드(자동 ✕)와 직접 적어 둔 ✕·?·✓는 건드리지 않는다.
   */
  function autoQuestion(ls) {
    var mine = {};
    state.you.hand.forEach(function (card) { mine[card] = true; });
    state.you.seen.forEach(function (h) { mine[h.card] = true; });
    state.you.peeked.forEach(function (h) { mine[h.card] = true; });
    state.board.forEach(function (b) { (b.opened || []).forEach(function (card) { mine[card] = true; }); });
    var changed = false;
    [ls.suspect, ls.weapon, ls.room].forEach(function (card) {
      if (mine[card] || marks[card]) return;
      marks[card] = 2;
      changed = true;
    });
    if (changed) saveMarks();
  }

  /** 알림에 힌트 카드 사용 버튼이 붙으면(쓸 수 있는 동안) 오래 둔다. 아니면 짧게 보여 주고 치운다. */
  function canUseHintCard() { return !!(state.you.canPeek || state.you.canExtraSuggest); }

  /** 알림 안에서 바로 쓸 수 있는 힌트 카드 버튼(같이 보기 / 추리 한 번 더). */
  function toastUseButtons() {
    var you = state.you;
    var html = '';
    if (you.canPeek) html += '<button type="button" class="toast-btn" data-use="peek">같이 보기 · 이 카드를 같이 본다</button>';
    if (you.canExtraSuggest) html += '<button type="button" class="toast-btn" data-use="extraSuggest">추리 한 번 더 쓰기</button>';
    return html ? '<div class="toast-actions">' + html + '</div>' : '';
  }

  /** 힌트 카드를 뽑았을 때(내 것은 종류까지, 남의 것은 턴 한 번 더만 종류를 알린다). */
  function checkHintDraw() {
    var d = state.lastHintDraw;
    if (!d) { if (hintSeq === null) hintSeq = 0; return; }
    if (hintSeq === null) { hintSeq = d.seq; return; }
    if (d.seq === hintSeq) return;
    hintSeq = d.seq;
    var mineDraw = d.byId === state.you.id;
    var who = nameOfId(d.byId);
    if (mineDraw && state.you.drew) {
      var kind = state.you.drew.kind;
      var info = state.hintKinds.filter(function (k) { return k.key === kind; })[0];
      toast('<b>힌트 카드를 얻었습니다!</b><div class="said">' + escapeHtml(info ? info.label : '') + '</div><div class="said small">' + escapeHtml(info ? info.text : '') + '</div>', 'hint', 8000);
    } else if (d.kind === 'extraTurn') {
      toast('<b>' + escapeHtml(who) + '님이 "턴 한 번 더" 카드를 얻었습니다</b><div class="said small">이번 차례가 끝나면 한 번 더 진행합니다.</div>', 'hint', 6000);
    } else {
      toast('<b>' + escapeHtml(who) + '님이 힌트 카드를 얻었습니다</b>', 'hint', 4000);
    }
  }

  /** 같이 보기로 본 카드를 팝업으로 보여 준다(본 사람에게만). */
  function checkPeeked() {
    var list = state.you.peeked;
    if (peekedCount !== null && list.length > peekedCount) {
      var p = list[list.length - 1];
      $('seen-title').textContent = '같이 본 카드';
      $('seen-from').textContent = '같이 보기 (' + p.by + '님 → ' + nameOfId(p.byId) + '님)';
      $('seen-card').textContent = cardLabel(p.card);
      $('seen-card').className = 'seen-face ' + cardKind(p.card);
      $('seen-ask').textContent = '남의 추리: ' + suspectLabel(p.suspect) + ', ' + weaponLabel(p.weapon) + ', ' + roomLabel(p.room);
      $('seen-popup').classList.remove('hidden');
      $('seen-ok').focus();
    }
    peekedCount = list.length;
  }

  /** 힌트 카드 영역: 가진 카드와 사용 버튼, 같이 본 카드. */
  function hintCardsHtml() {
    var you = state.you;
    var out = '';
    var kinds = {};
    state.hintKinds.forEach(function (k) { kinds[k.key] = k; });
    if (you.extraTurns > 0) out += '<div class="hc-note">"턴 한 번 더" 대기 중 · ' + you.extraTurns + '회 (이번 차례가 끝나면 한 번 더 진행합니다)</div>';
    you.hints.forEach(function (key) {
      var k = kinds[key];
      var usable = key === 'extraSuggest' ? you.canExtraSuggest : key === 'peek' ? you.canPeek : false;
      var why = key === 'extraSuggest' ? '내 차례에 추리가 끝난 뒤 방 안에서 쓸 수 있습니다.' : '남이 추리해 카드를 보여 준 직후에 쓸 수 있습니다.';
      out += '<div class="hc-card" title="' + escapeHtml(k.text + (usable ? '' : ' ' + why)) + '"><div class="hc-face"><b>' + escapeHtml(k.label) + '</b></div>'
        + '<button type="button" class="hc-use" data-use="' + key + '"' + (usable ? '' : ' disabled') + '>' + (usable ? '사용하기' : '지금은 쓸 수 없음') + '</button></div>';
    });
    if (!you.hints.length && !you.extraTurns) out += '<p class="hint-empty">가진 힌트 카드가 없습니다.</p>';
    if (you.peeked.length) {
      out += '<div class="hc-peeked"><b>같이 본 카드</b>' + you.peeked.slice().reverse().map(function (p) {
        return '<div class="hint-item ' + cardKind(p.card) + '"><span class="hint-face">' + escapeHtml(cardLabel(p.card)) + '</span><span class="hint-meta"><b>' + escapeHtml(p.by) + '님 → ' + escapeHtml(nameOfId(p.byId)) + '님</b><small>추리: ' + escapeHtml(suspectLabel(p.suspect)) + ', ' + escapeHtml(weaponLabel(p.weapon)) + ', ' + escapeHtml(roomLabel(p.room)) + '</small></span></div>';
      }).join('') + '</div>';
    }
    return out;
  }

  /** 고발이 있으면(맞았든 틀렸든) 모든 참가자에게 결과 알림을 띄운다. */
  function checkAccusation() {
    var a = state.lastAccusation;
    if (!a) { if (accusedSeq === null) accusedSeq = 0; return; }
    if (accusedSeq === null) { accusedSeq = a.seq; return; } // 접속·재접속 직후: 이미 지난 고발은 알리지 않는다
    if (a.seq === accusedSeq) return;
    accusedSeq = a.seq;
    var who = nameOfId(a.byId);
    var body = '<b>' + escapeHtml(who) + '님의 최종 고발</b><div class="said">' + escapeHtml(sentence(a)) + '</div><div class="chips">'
      + chip('suspect', suspectLabel(a.suspect)) + chip('weapon', weaponLabel(a.weapon)) + chip('room', roomLabel(a.room)) + '</div>';
    if (a.correct) toast(body + '<div class="verdict ok big">정답입니다! ' + escapeHtml(who) + '님이 사건을 해결했습니다.</div>', 'accuse-ok', 9000);
    else {
      var openedChips = (a.opened || []).map(function (card) { return chip(cardKind(card), cardLabel(card)); }).join('');
      toast(body + '<div class="verdict big">오답입니다. ' + escapeHtml(who) + '님은 탈락합니다.</div>'
        + (openedChips ? '<div class="said small">공개되는 카드 ' + (a.opened || []).length + '장</div><div class="chips">' + openedChips + '</div>' : ''), 'accuse-bad', 9000);
    }
  }

  /**
   * 추측이 끝나면(카드를 보여 줬거나, 아무도 못 보여 줘서) 모두에게 알림 하나를 띄운다.
   * 누가 무엇을 추측했는지와 결과가 한 알림에 들어 있다. 카드 이름은 카드를 받은 사람의 팝업으로만 간다.
   */
  function checkSuggestion() {
    var ls = state.lastSuggestion;
    if (!ls) { if (alertedSeq === null) alertedSeq = 0; return; }
    if (alertedSeq === null) {
      // 접속·재접속 직후: 이미 지난 추측은 알리지 않는다. 카드를 고르는 중이면 결과가 나올 때 알린다.
      alertedSeq = state.step === 'disprove' ? ls.seq - 1 : ls.seq;
      return;
    }
    if (state.step === 'disprove' || alertedSeq === ls.seq) return;
    alertedSeq = ls.seq;
    var who = '<b>' + escapeHtml(nameOfId(ls.byId)) + '님의 추리</b><div class="said">' + escapeHtml(sentence(ls)) + '</div><div class="chips">'
      + chip('suspect', suspectLabel(ls.suspect)) + chip('weapon', weaponLabel(ls.weapon)) + chip('room', roomLabel(ls.room)) + '</div>';
    if (ls.shownBy) {
      autoQuestion(ls);
      toast(who + '<div class="verdict ok">카드를 보여줬습니다.</div><div class="said small">' + escapeHtml(nameOfId(ls.shownBy)) + '님 → ' + escapeHtml(nameOfId(ls.byId)) + '님</div>' + toastUseButtons(), 'shown', canUseHintCard() ? 12000 : 7000);
    } else {
      toast(who + '<div class="verdict">아무도 보여 줄 카드가 없었습니다. 추리할 수 없습니다.</div>' + toastUseButtons(), 'none', canUseHintCard() ? 12000 : 7000);
    }
  }

  // ───────────────────────────── 화면 ─────────────────────────────

  var startConfirmOpen = false;
  function renderStartConfirm() {
    var lobby = state.phase !== 'playing';
    if (startConfirmOpen && (!lobby || !state.canStart)) startConfirmOpen = false;
    $('start-confirm').classList.toggle('hidden', !startConfirmOpen);
    if (!startConfirmOpen) return;
    var joining = state.players.filter(function (p) { return p.ready && p.connected !== false; });
    var left = state.players.filter(function (p) { return !(p.ready && p.connected !== false); });
    var names = function (list) { return list.map(function (p) { return p.nickname; }).join(', '); };
    $('start-confirm-title').textContent = '준비한 ' + joining.length + '명으로 시작할까요?';
    $('start-confirm-ready').textContent = '준비: ' + names(joining);
    $('start-confirm-waiting').textContent = left.length ? '준비 안 함: ' + names(left) + ' · 이번 게임에서 빠집니다.' : '모두 준비했습니다.';
  }
  function closeStartConfirm() { startConfirmOpen = false; renderStartConfirm(); }

  /** 시작 전에 말(범인)을 고른다. 이미 다른 사람이 고른 말은 누르지 못한다. */
  function renderPicks() {
    var show = state.phase !== 'playing';
    $('pick-box').classList.toggle('hidden', !show);
    if (!show) return;
    var mine = state.you.pick;
    setHtml('picks', state.suspects.map(function (s) {
      var owner = state.picks[s.key];
      var taken = !!owner && owner.id !== state.you.id;
      var cls = 'pick-chip' + (mine === s.key ? ' mine' : '') + (taken ? ' taken' : '');
      var who = owner ? '<small>' + escapeHtml(owner.id === state.you.id ? '내가 고름' : owner.nickname) + '</small>' : '<small>비어 있음</small>';
      return '<button type="button" class="' + cls + '" data-key="' + s.key + '"' + (taken ? ' disabled' : '') + ' aria-pressed="' + (mine === s.key ? 'true' : 'false') + '">'
        + '<i class="dot-' + s.key + '"></i><span>' + escapeHtml(s.label) + who + '</span></button>';
    }).join(''));
  }

  /** 이번 판의 모든 추측을 최근 것부터. 내 추리와 상대 추리를 따로 볼 수 있다. 카드 이름은 내가 받은 것만 보인다. */
  /** 추리 기록의 카드 칩에 붙일 표시: 내 카드·받은 카드는 ✕, 노트에서 ?·✓로 둔 카드는 그대로. */
  function markOf(key) {
    var known = state.you.hand.indexOf(key) >= 0 || state.you.seen.some(function (h) { return h.card === key; }) || state.you.peeked.some(function (h) { return h.card === key; }) || state.board.some(function (b) { return (b.opened || []).indexOf(key) >= 0; });
    if (known) return '<i class="mk x">✕</i>';
    if (marks[key] === 2) return '<i class="mk q">?</i>';
    if (marks[key] === 3) return '<i class="mk y">✓</i>';
    return '';
  }
  function markedChip(kind, key, label) { return '<span class="chip ' + kind + '">' + markOf(key) + escapeHtml(label) + '</span>'; }

  function suggestionsHtml() {
    var me = state.you.id;
    var list = state.suggestions.slice().reverse().filter(function (x) {
      return logFilter === 'mine' ? x.byId === me : logFilter === 'others' ? x.byId !== me : true;
    });
    if (!list.length) return '<p class="sg-empty">' + (logFilter === 'mine' ? '아직 내가 한 추리가 없습니다.' : logFilter === 'others' ? '아직 상대가 한 추리가 없습니다.' : '아직 추리가 없습니다.') + '</p>';
    return list.map(function (x) {
      var mine = x.byId === me;
      var got = mine ? state.you.seen.filter(function (h) { return h.seq === x.seq; })[0] : null;
      var peeked = state.you.peeked.filter(function (h) { return h.seq === x.seq; })[0];
      var result = !x.resolved ? '<span class="sg-result wait">카드를 고르는 중</span>'
        : x.shownBy ? '<span class="sg-result ok">' + escapeHtml(nameOfId(x.shownBy)) + '님이 보여 줌</span>'
          : '<span class="sg-result none">아무도 못 보여 줌</span>';
      return '<div class="sg-item' + (mine ? ' mine' : '') + '"><div class="sg-head"><b>' + escapeHtml(nameOfId(x.byId)) + (mine ? ' (나)' : '') + '</b>' + result + '</div>'
        + '<div class="sg-said">' + escapeHtml(sentence(x)) + '</div>'
        + '<div class="sg-chips">' + markedChip('suspect', x.suspect, suspectLabel(x.suspect)) + markedChip('weapon', x.weapon, weaponLabel(x.weapon)) + markedChip('room', x.room, roomLabel(x.room)) + '</div>'
        + (got ? '<div class="sg-got">받은 카드: <b>' + escapeHtml(cardLabel(got.card)) + '</b></div>' : '')
        + (peeked ? '<div class="sg-got">같이 본 카드: <b>' + escapeHtml(cardLabel(peeked.card)) + '</b></div>' : '') + '</div>';
    }).join('');
  }

  function nameOfId(id) {
    var name = '';
    state.board.forEach(function (b) { if (b.id === id) name = b.nickname; });
    return name;
  }

  function render() {
    populate();
    document.body.dataset.phase = state.phase;
    var you = state.you;
    document.body.dataset.myturn = you.myTurn || you.disprove ? '1' : '';
    var playing = state.phase === 'playing';
    var lobby = !playing;
    $('phase').textContent = PHASE[state.phase] || state.phase;
    $('my-piece').textContent = you.suspect ? suspectLabel(you.suspect) : '-';
    loadMarks();
    checkSeen();
    checkSuggestion();
    checkAccusation();
    checkHintDraw();
    checkPeeked();

    renderPicks();
    var showGame = state.board.length > 0 && (playing || !!state.result);
    $('rules').classList.toggle('hidden', showGame);
    $('game-view').classList.toggle('hidden', !showGame);
    $('lobby').classList.toggle('hidden', !lobby);
    $('turn-controls').classList.toggle('hidden', !(playing && you.inGame && !you.eliminated && you.myTurn));
    $('ready').textContent = you.ready ? '준비 취소' : '준비';
    $('start').disabled = !state.canStart;

    if (!you.canAccuse) accuseOpen = false;
    var turnName = nameOfId(state.turnId);
    var waitName = nameOfId(state.waitingId);
    var message;
    if (playing) {
      if (!you.inGame) message = '진행 중인 게임을 구경하고 있습니다. 다음 게임부터 참여할 수 있습니다.';
      else if (you.disprove) message = '보여 줄 카드를 골라 주세요.';
      else if (state.step === 'disprove') message = waitName + '님이 보여 줄 카드를 고르는 중입니다.';
      else if (you.eliminated) message = '고발이 틀려 탈락했습니다. 가진 카드는 모두 공개됐고, 이제 판을 지켜보기만 할 수 있습니다.';
      else if (you.myTurn) {
        if (state.step === 'start') message = '내 차례입니다. 주사위를 굴리세요. (' + state.autoRollSec + '초 안에 굴리지 않으면 서버가 대신 굴려 가까운 방으로 가서 추측합니다)' + (you.canPassage ? ' 비밀 통로로 바로 건너갈 수도 있습니다.' : '') + (you.canAccuse ? ' 정답 봉투 방에 있어 바로 고발할 수도 있습니다.' : '') + (you.canSuggest ? ' 불려 온 방이라 굴리지 않고 바로 추측해도 됩니다.' : '');
        else if (state.step === 'move') message = '최대 ' + state.moveLeft + '칸 이동할 수 있습니다. 초록색 칸이나 방을 눌러 이동하거나, 움직이지 않으려면 "제자리에 있기"를 누르세요.' + (you.reach && !you.reach.cells.length && !you.reach.rooms.length ? ' 갈 수 있는 곳이 없습니다. 차례를 끝내세요.' : '');
        else if (state.step === 'suggest') message = '방에 들어왔습니다. 범인과 흉기를 골라 추측하세요.';
        else if (you.canExtraSuggest) message = '추리가 끝났습니다. "추리 한 번 더" 카드를 쓸 수 있습니다. 쓰지 않으면 차례를 끝내세요.';
        else message = you.canAccuse ? '정답 봉투 방에 있습니다. 범인·흉기·장소를 고발하거나 차례를 끝내세요.' : '이번 차례는 곧 자동으로 끝납니다. 바로 넘기려면 "차례 끝내기"를 누르세요. (고발하려면 주사위로 가운데 정답 봉투 방에 들어가야 합니다)';
      } else message = turnName + '님의 차례입니다.' + (state.board.some(function (b) { return b.id === state.turnId && b.connected === false; }) ? ' 연결이 끊겨 있어 잠시 기다립니다.' : '');
      if (state.paused) message += ' 기다리는 사람의 화면이 가려져 있어 제한시간이 멈췄습니다.';
    } else {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 게임을 시작할 수 있습니다.'
        : state.readyCount > state.maxPlayers
          ? '클루는 ' + state.maxPlayers + '명까지 할 수 있습니다. 준비한 사람을 ' + state.maxPlayers + '명 이하로 맞춰 주세요. (현재 ' + state.readyCount + '명)'
          : '준비한 참가자가 ' + state.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. (현재 ' + state.readyCount + '명)';
      if (state.result) message = '지난 판 참가자는 자동으로 준비됩니다. 빠지려면 준비를 취소하고, 구경한 사람은 준비를 눌러 주세요.' + (state.canStart ? '' : ' (준비 ' + state.readyCount + '명)');
    }
    $('message').textContent = message;
    renderTimer();

    setHtml('players', state.players.map(function (p) {
      var seat = state.board.filter(function (b) { return b.id === p.id; })[0];
      var status;
      if (p.connected === false) status = '끊김';
      else if (lobby) status = p.ready ? '준비' : '대기';
      else if (!p.inGame) status = '구경';
      else if (seat && seat.eliminated) status = '탈락';
      else status = p.id === state.waitingId ? '차례' : '대기';
      var piece = seat ? '<small>' + escapeHtml(suspectLabel(seat.suspect)) + (seat.eliminated ? ' · 탈락(카드 공개)' : ' · 카드 ' + seat.cards + '장' + (seat.hints ? ' · 힌트 ' + seat.hints + '장' : '')) + '</small>' : '';
      var initial = Array.from(p.nickname)[0] || '나';
      return '<div class="player' + (playing && p.id === state.waitingId ? ' turn' : '') + '" data-id="' + p.id + '"' + (seat ? ' data-suspect="' + seat.suspect + '"' : '') + ' data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(p.nickname)
        + (p.id === you.id ? ' (나)' : '') + '</b>' + piece + '<span class="status">' + status + '</span></div>';
    }).join(''));

    if (showGame) {
      $('result').classList.toggle('hidden', !state.result);
      var r = state.result;
      setHtml('result', r ? '<b>' + escapeHtml(r.message) + '</b>' + (r.winner ? '<div>우승: ' + escapeHtml(r.winner) + '</div>' : '') : '');
      setHtml('map', mapHtml());

      $('dice-area').classList.toggle('hidden', !playing);
      if (playing) {
        var rollKey = state.turnId + ':' + (state.dice ? state.dice.join('+') : '-');
        var fresh = drawn.rollKey !== undefined && drawn.rollKey !== rollKey && !!state.dice;
        drawn.rollKey = rollKey;
        setHtml('dice', dieHtml(state.dice ? state.dice[0] : 0, fresh) + dieHtml(state.dice ? state.dice[1] : 0, fresh));
        $('dice-note').textContent = state.dice ? '합계 ' + (state.dice[0] + state.dice[1]) + (state.step === 'move' ? ' · 최대 ' + state.moveLeft + '칸 이동' : '') : turnName + '님이 아직 굴리지 않았습니다.';
      }

      var dp = $('disprove');
      dp.classList.toggle('hidden', !you.disprove);
      setHtml('disprove', disproveHtml());
      // 카드를 보여 줄 차례가 막 시작됐으면 그 자리로 화면을 옮기고 첫 버튼에 초점을 둔다(놓치면 45초 뒤 서버가 대신 보여 준다).
      var needShow = !!you.disprove;
      if (needShow && !showingDisprove) {
        var firstPick = dp.querySelector('.pick-card');
        try { dp.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* 오래된 브라우저 */ }
        if (firstPick) { try { firstPick.focus({ preventScroll: true }); } catch (e) { firstPick.focus(); } }
      }
      showingDisprove = needShow;

      var sug = you.canSuggest && !accuseOpen;
      $('suggest-form').classList.toggle('hidden', !sug);
      if (sug) {
        var here = state.positions[you.suspect] && state.positions[you.suspect].room;
        $('suggest-room').textContent = '장소: ' + (here ? roomLabel(here) : '-') + ' (지금 있는 방)';
      }
      $('accuse-form').classList.toggle('hidden', !accuseOpen);

      $('hand-box').classList.toggle('hidden', !you.hand.length);
      setHtml('hand', you.hand.map(function (card) { return '<span class="clue-card ' + cardKind(card) + '">' + escapeHtml(cardLabel(card)) + '</span>'; }).join(''));
      $('hint-box').classList.toggle('hidden', !you.inGame && !state.result);
      $('hint-count').textContent = you.hints.length ? you.hints.length + '장' : '';
      setHtml('hint-cards', hintCardsHtml());
      var openList = state.board.filter(function (b) { return b.eliminated && b.opened && b.opened.length; });
      $('open-box').classList.toggle('hidden', !openList.length);
      setHtml('open-cards', openList.map(function (b) {
        return '<div class="open-row"><b>' + escapeHtml(b.nickname) + '<small> · ' + escapeHtml(suspectLabel(b.suspect)) + '</small></b><div class="clue-hand">'
          + b.opened.map(function (card) { return '<span class="clue-card ' + cardKind(card) + '">' + escapeHtml(cardLabel(card)) + '</span>'; }).join('') + '</div></div>';
      }).join(''));
      $('log-box').classList.toggle('hidden', !state.suggestions.length && !you.inGame && !state.result);
      $('log-count').textContent = state.suggestions.length ? state.suggestions.length + '건' : '';
      setHtml('suggestions', suggestionsHtml());
      $('notebook').classList.toggle('hidden', !you.inGame && !state.result);
      setHtml('notebook', notebookHtml());
    }

    $('roll').disabled = !you.canRoll;
    // 이미 굴린 뒤에는 "이미 굴렸습니다"라는 눌리지 않는 큰 버튼을 두지 않고 숨긴다(안내는 위 메시지가 한다).
    $('roll').classList.toggle('hidden', !you.canRoll);
    $('stay').classList.toggle('hidden', !you.canStay);
    $('passage').classList.toggle('hidden', !you.canPassage);
    $('passage').textContent = you.passageTo ? '비밀 통로 → ' + roomLabel(you.passageTo) : '비밀 통로';
    $('suggest').classList.toggle('hidden', !you.canSuggest);
    $('accuse').classList.toggle('hidden', !you.canAccuse);
    $('accuse').textContent = accuseOpen ? '고발 닫기' : '고발하기';
    $('end').classList.toggle('hidden', !you.canEnd);
    $('roll').textContent = '주사위 굴리기';
    // "○○님이 하는 중"은 지도 위 배너로 보여 준다(내 차례가 아니면 아래 버튼 줄은 숨겨진다).
    var banner = $('turn-banner');
    banner.classList.toggle('hidden', !playing);
    banner.classList.toggle('mine', !!you.myTurn);
    // 폰에서는 주사위 칸이 지도 한참 아래라, 나온 눈은 배너에도 적어 둔다.
    var diceText = playing && state.dice ? ' · 🎲 ' + state.dice[0] + '+' + state.dice[1] + '=' + (state.dice[0] + state.dice[1]) : '';
    banner.textContent = !playing ? '' : (you.myTurn ? '내 차례입니다' : ((waitName || turnName) ? (waitName || turnName) + '님이 하는 중' : '대기 중')) + diceText;

    setHtml('history', state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join(''));
    renderStartConfirm();
    sending.forEach(function (button) { button.disabled = true; });
  }

  function renderTimer() {
    var chip = $('status-chip');
    if (!state || state.phase !== 'playing' || !state.turnEndsAt) {
      chip.textContent = state && state.phase === 'playing' ? '진행 중' : '2~6명';
      chip.classList.remove('low');
      return;
    }
    var now = state.pausedAt !== null && state.pausedAt !== undefined ? state.pausedAt : Date.now() + skew;
    if (state.autoEndsAt) {
      chip.textContent = '자동 종료 ' + Math.max(0, Math.ceil((state.autoEndsAt - Date.now() - skew) / 1000)) + '초';
      chip.classList.remove('low');
      return;
    }
    var seconds = Math.max(0, Math.ceil((state.turnEndsAt - now) / 1000));
    chip.textContent = (state.paused ? '멈춤 · ' : '') + '남은 시간 ' + seconds + '초';
    chip.classList.toggle('low', seconds <= 10 && !state.paused);
  }
  setInterval(function () { if (state) renderTimer(); }, 500);

  // ───────────────────────────── 조작 ─────────────────────────────

  $('ready').onclick = function () { markSending($('ready')); send('ready', { ready: !state.you.ready }); };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });

  $('picks').addEventListener('click', function (event) {
    var chip = event.target.closest ? event.target.closest('.pick-chip') : null;
    if (!chip || !state || chip.disabled) return;
    var key = chip.getAttribute('data-key');
    send('pick', { suspect: state.you.pick === key ? null : key });
  });
  document.querySelectorAll('.log-tab').forEach(function (tab) {
    tab.onclick = function () {
      logFilter = tab.getAttribute('data-f');
      document.querySelectorAll('.log-tab').forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('on', on);
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (state) setHtml('suggestions', suggestionsHtml());
    };
  });
  function useHintFrom(event) {
    var button = event.target.closest ? event.target.closest('[data-use]') : null;
    if (!button || button.disabled || !state) return false;
    send('useHint', { kind: button.getAttribute('data-use') });
    return true;
  }
  $('hint-cards').addEventListener('click', useHintFrom);
  $('toasts').addEventListener('click', function (event) {
    if (useHintFrom(event)) { var toastEl = event.target.closest('.toast'); if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl); }
  });
  $('seen-ok').onclick = closeSeen;
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeSeen(); });
  $('roll').onclick = function () { markSending($('roll')); send('roll'); };
  $('stay').onclick = function () { markSending($('stay')); send('stay'); };
  $('passage').onclick = function () { markSending($('passage')); send('passage'); };
  $('end').onclick = function () { markSending($('end')); accuseOpen = false; send('endTurn'); };
  $('suggest').onclick = function () { var form = $('suggest-form'); form.scrollIntoView && form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  $('accuse').onclick = function () {
    accuseOpen = !accuseOpen;
    render();
    // 좁은 화면에서는 고발 창이 버튼보다 한참 아래(기록 칸 쪽)에 있어서, 열면 그 자리로 화면을 옮긴다.
    if (accuseOpen) { try { $('accuse-form').scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { /* 오래된 브라우저 */ } }
  };
  $('accuse-cancel').onclick = function () { accuseOpen = false; render(); };
  $('suggest-go').onclick = function () {
    markSending($('suggest-go'));
    send('suggest', { suspect: $('sg-suspect').value, weapon: $('sg-weapon').value });
  };
  $('accuse-go').onclick = function () {
    markSending($('accuse-go'));
    accuseOpen = false;
    send('accuse', { suspect: $('ac-suspect').value, weapon: $('ac-weapon').value, room: $('ac-room').value });
  };
  $('disprove').addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-card]') : null;
    if (!button) return;
    markSending(button);
    send('show', { card: button.getAttribute('data-card') });
  });

  // 보드의 초록색 칸·방을 누르면 이동한다.
  $('map').addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('[data-move]') : null;
    if (!target || !state || !state.you.reach) return;
    var room = target.getAttribute('data-room');
    if (room) send('move', { room: room });
    else send('move', { x: Number(target.getAttribute('data-x')), y: Number(target.getAttribute('data-y')) });
  });

  function cycleMark(cell) {
    if (!cell) return;
    var key = cell.getAttribute('data-mark');
    if (!key) return;
    marks[key] = ((marks[key] || 0) + 1) % MARK_TEXT.length;
    saveMarks();
    setHtml('notebook', notebookHtml());
    setHtml('suggestions', suggestionsHtml());
  }
  $('notebook').addEventListener('click', function (event) { cycleMark(event.target.closest ? event.target.closest('td.mark') : null); });
  $('notebook').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var cell = event.target.closest ? event.target.closest('td.mark') : null;
    if (cell) { event.preventDefault(); cycleMark(cell); }
  });

  socket = window.GameSocket.open({
    game: 'clue',
    tokenKey: TOKEN_KEY,
    nickname: nickname,
    onMessage: function (data) {
      if (data.type === 'error') { releaseSending(); showError(data.message); if (state) render(); return; }
      if (data.type === 'clueState') {
        skew = data.serverTime - Date.now();
        releaseSending();
        state = data;
        render();
      }
    }
  });
}());
