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

  var CELL = 20;
  var state = null;
  var skew = 0;            // 서버 시계 - 내 시계
  var accuseOpen = false;
  var populated = false;
  var marks = {};          // 추리 노트에 직접 적은 표시 { 카드: 0~3 }
  var marksSig = null;

  var COLORS = { scarlett: '#d72c0d', mustard: '#ecb22e', white: '#ffffff', green: '#2e8b57', peacock: '#1264a3', plum: '#7b3f9e' };
  var DARK_TEXT = { mustard: true, white: true };
  var PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  var PHASE = { lobby: '대기 중', playing: '진행 중', result: '게임 종료' };
  var MARK_TEXT = ['', '✕', '?', '✓'];
  var MARK_CLASS = ['', 'no', 'maybe', 'yes'];

  function $(id) { return document.getElementById(id); }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
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
  function roomLabel(key) { return labelOf(state.rooms, key); }
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

  function tokenSvg(x, y, kind, key, extra) {
    if (kind === 'suspect') {
      var dark = DARK_TEXT[key] ? '#1d1c1d' : '#fff';
      return '<g class="token"' + extra + '><title>' + escapeHtml(suspectLabel(key)) + '</title><circle cx="' + x + '" cy="' + y + '" r="8" fill="' + COLORS[key] + '" stroke="#1d1c1d" stroke-width="1.2"/>'
        + '<text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="11" font-weight="700" fill="' + dark + '">' + escapeHtml(first(suspectLabel(key))) + '</text></g>';
    }
    return '<g class="token"><title>' + escapeHtml(weaponLabel(key)) + '</title><rect x="' + (x - 7) + '" y="' + (y - 7) + '" width="14" height="14" rx="3" fill="#5a5a5c" stroke="#1d1c1d" stroke-width="1"/>'
      + '<text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">' + escapeHtml(first(weaponLabel(key))) + '</text></g>';
  }

  function mapHtml() {
    var map = state.map;
    var you = state.you;
    var reach = you && you.reach ? you.reach : { cells: [], rooms: [] };
    var out = '<rect width="' + map.w * CELL + '" height="' + map.h * CELL + '" fill="#f3ead6"/>';

    // 복도: 방·가운데를 뺀 모든 칸
    var inRect = function (r, x, y) { return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2; };
    var doors = {};
    map.rooms.forEach(function (room) { room.doors.forEach(function (d) { doors[d.x + ',' + d.y] = true; }); });
    for (var y = 0; y < map.h; y += 1) {
      for (var x = 0; x < map.w; x += 1) {
        if (inRect(map.center, x, y) || map.rooms.some(function (r) { return inRect(r, x, y); })) continue;
        out += '<rect x="' + x * CELL + '" y="' + y * CELL + '" width="' + CELL + '" height="' + CELL + '" fill="' + (doors[x + ',' + y] ? '#ffe08a' : '#f9f3e3') + '" stroke="#d9ccaa" stroke-width=".5"/>';
      }
    }
    // 가운데 봉투
    var c = map.center;
    out += '<rect x="' + c.x1 * CELL + '" y="' + c.y1 * CELL + '" width="' + (c.x2 - c.x1 + 1) * CELL + '" height="' + (c.y2 - c.y1 + 1) * CELL + '" fill="#4a154b"/>'
      + '<text x="' + (c.x1 + (c.x2 - c.x1 + 1) / 2) * CELL + '" y="' + (c.y1 + (c.y2 - c.y1 + 1) / 2) * CELL + '" text-anchor="middle" font-size="13" font-weight="700" fill="#ecb22e">정답 봉투</text>';

    // 방
    var slots = {};
    map.rooms.forEach(function (room) {
      var w = (room.x2 - room.x1 + 1) * CELL;
      var h = (room.y2 - room.y1 + 1) * CELL;
      out += '<rect x="' + room.x1 * CELL + '" y="' + room.y1 * CELL + '" width="' + w + '" height="' + h + '" fill="#e8dff0" stroke="#4a154b" stroke-width="2"/>'
        + '<text x="' + (room.x1 * CELL + 6) + '" y="' + (room.y1 * CELL + 15) + '" font-size="12" font-weight="700" fill="#4a154b">' + escapeHtml(room.label) + '</text>';
      if (room.passage) {
        out += '<text x="' + (room.x1 * CELL + 6) + '" y="' + (room.y2 * CELL + CELL - 5) + '" font-size="10" fill="#7b3f9e">비밀 통로 → ' + escapeHtml(roomLabel(room.passage)) + '</text>';
      }
      slots[room.key] = { room: room, count: 0 };
    });

    // 이동 가능 표시(말보다 아래에 깔고, 눌리는 칸은 말 위에 투명 덮개로 올린다)
    var overlay = '';
    reach.cells.forEach(function (cell) {
      overlay += '<rect class="reach-cell" data-move="1" data-x="' + cell.x + '" data-y="' + cell.y + '" x="' + cell.x * CELL + '" y="' + cell.y * CELL + '" width="' + CELL + '" height="' + CELL + '"><title>여기로 이동</title></rect>';
    });
    reach.rooms.forEach(function (key) {
      var room = slots[key].room;
      overlay += '<rect class="reach-room" data-move="1" data-room="' + key + '" x="' + (room.x1 * CELL + 2) + '" y="' + (room.y1 * CELL + 2) + '" width="' + ((room.x2 - room.x1 + 1) * CELL - 4) + '" height="' + ((room.y2 - room.y1 + 1) * CELL - 4) + '"><title>' + escapeHtml(room.label) + '(으)로 이동</title></rect>';
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
      var turn = seat && state.phase === 'playing' && seat.id === state.turnId;
      var ring = '';
      var cx; var cy;
      if (at.room) {
        var slot = slots[at.room];
        var perRow = Math.max(1, Math.floor(((slot.room.x2 - slot.room.x1 + 1) * CELL - 4) / 20));
        cx = slot.room.x1 * CELL + 12 + (slot.count % perRow) * 20;
        cy = slot.room.y1 * CELL + 30 + Math.floor(slot.count / perRow) * 20;
        slot.count += 1;
      } else { cx = at.x * CELL + CELL / 2; cy = at.y * CELL + CELL / 2; }
      if (turn) ring = '<circle cx="' + cx + '" cy="' + cy + '" r="12" fill="none" stroke="#ecb22e" stroke-width="3"/>';
      else if (mine) ring = '<circle cx="' + cx + '" cy="' + cy + '" r="11" fill="none" stroke="#4a154b" stroke-width="2" stroke-dasharray="3 2"/>';
      var gone = seat && (seat.eliminated || seat.left);
      tokens += ring + '<g opacity="' + (gone ? '.45' : '1') + '">' + tokenSvg(cx, cy, 'suspect', s.key, '') + '</g>';
    });
    state.weapons.forEach(function (w) {
      var key = state.weaponRooms[w.key];
      var slot = slots[key];
      if (!slot) return;
      var perRow = Math.max(1, Math.floor(((slot.room.x2 - slot.room.x1 + 1) * CELL - 4) / 20));
      var cx = slot.room.x1 * CELL + 12 + (slot.count % perRow) * 20;
      var cy = slot.room.y1 * CELL + 30 + Math.floor(slot.count / perRow) * 20;
      slot.count += 1;
      tokens += tokenSvg(cx, cy, 'weapon', w.key, '');
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
      + '. 가진 카드 중 하나를 골라 ' + escapeHtml(asker) + '님에게만 보여 줍니다.</p>'
      + d.options.map(function (card) { return '<button type="button" class="pick-card" data-card="' + card + '">' + escapeHtml(cardLabel(card)) + ' 보여 주기</button>'; }).join('');
  }

  function populate() {
    if (populated) return;
    populated = true;
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
    function rows(title, list) {
      return '<tr><th colspan="3">' + title + '</th></tr>' + list.map(function (item) {
        var cls = mine[item.key] ? 'mine' : (seen[item.key] ? 'seen' : '');
        var note = mine[item.key] ? '내 카드' : (seen[item.key] ? escapeHtml(seen[item.key].join(', ')) + '님이 보여 줌' : '');
        var m = marks[item.key] || 0;
        var markCell = mine[item.key] || seen[item.key]
          ? '<td class="mark no">✕</td>'
          : '<td class="mark ' + MARK_CLASS[m] + '" data-mark="' + item.key + '" role="button" tabindex="0" aria-label="' + escapeHtml(item.label) + ' 표시 바꾸기">' + (MARK_TEXT[m] || '·') + '</td>';
        return '<tr class="' + cls + '"><td class="label">' + escapeHtml(item.label) + '</td>' + markCell + '<td class="note">' + note + '</td></tr>';
      }).join('');
    }
    return '<b>추리 노트</b><table>' + rows('범인', state.suspects) + rows('흉기', state.weapons) + rows('장소', state.rooms) + '</table>'
      + '<p class="hint">칸을 누르면 ✕(아님) → ?(의심) → ✓(유력) 순으로 바뀝니다. 내 카드와 보여 준 카드는 자동으로 ✕가 됩니다.</p>';
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

  function nameOfId(id) {
    var name = '';
    state.board.forEach(function (b) { if (b.id === id) name = b.nickname; });
    return name;
  }

  function render() {
    populate();
    document.body.dataset.phase = state.phase;
    var you = state.you;
    var playing = state.phase === 'playing';
    var lobby = !playing;
    $('phase').textContent = PHASE[state.phase] || state.phase;
    $('my-piece').textContent = you.suspect ? suspectLabel(you.suspect) : '-';
    loadMarks();

    var showGame = state.board.length > 0 && (playing || !!state.result);
    $('rules').classList.toggle('hidden', showGame);
    $('game-view').classList.toggle('hidden', !showGame);
    $('lobby').classList.toggle('hidden', !lobby);
    $('turn-controls').classList.toggle('hidden', !(playing && you.inGame && !you.eliminated));
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
      else if (you.eliminated) message = '고발이 틀려 탈락했습니다. 다른 사람의 추측에는 계속 카드를 보여 줍니다.';
      else if (you.myTurn) {
        if (state.step === 'start') message = '내 차례입니다. 주사위를 굴리세요.' + (you.canPassage ? ' 비밀 통로로 바로 건너갈 수도 있습니다.' : '') + (you.canSuggest ? ' 불려 온 방이라 굴리지 않고 바로 추측해도 됩니다.' : '');
        else if (state.step === 'move') message = '최대 ' + state.moveLeft + '칸 이동할 수 있습니다. 초록색 칸이나 방을 눌러 이동하세요.' + (you.reach && !you.reach.cells.length && !you.reach.rooms.length ? ' 갈 수 있는 곳이 없습니다. 차례를 끝내세요.' : '');
        else if (state.step === 'suggest') message = '방에 들어왔습니다. 범인과 흉기를 골라 추측하세요.';
        else message = '차례를 마치려면 "차례 끝내기"를 누르세요. 확신이 서면 고발할 수 있습니다.';
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
      var piece = seat ? '<small>' + escapeHtml(suspectLabel(seat.suspect)) + ' · 카드 ' + seat.cards + '장</small>' : '';
      var initial = Array.from(p.nickname)[0] || '나';
      return '<div class="player' + (playing && p.id === state.waitingId ? ' turn' : '') + '" data-id="' + p.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(p.nickname)
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

      var sug = you.canSuggest && !accuseOpen;
      $('suggest-form').classList.toggle('hidden', !sug);
      if (sug) {
        var here = state.positions[you.suspect] && state.positions[you.suspect].room;
        $('suggest-room').textContent = '장소: ' + (here ? roomLabel(here) : '-') + ' (지금 있는 방)';
      }
      $('accuse-form').classList.toggle('hidden', !accuseOpen);

      $('hand-box').classList.toggle('hidden', !you.hand.length);
      setHtml('hand', you.hand.map(function (card) { return '<span class="clue-card ' + cardKind(card) + '">' + escapeHtml(cardLabel(card)) + '</span>'; }).join(''));
      $('notebook').classList.toggle('hidden', !you.inGame && !state.result);
      setHtml('notebook', notebookHtml());
    }

    $('roll').disabled = !you.canRoll;
    $('roll').classList.toggle('hidden', !you.canRoll && !you.myTurn);
    $('passage').classList.toggle('hidden', !you.canPassage);
    $('passage').textContent = you.passageTo ? '비밀 통로 → ' + roomLabel(you.passageTo) : '비밀 통로';
    $('suggest').classList.toggle('hidden', !you.canSuggest);
    $('accuse').classList.toggle('hidden', !you.canAccuse);
    $('accuse').textContent = accuseOpen ? '고발 닫기' : '고발하기';
    $('end').classList.toggle('hidden', !you.canEnd);
    $('roll').textContent = you.myTurn ? (state.step === 'start' ? '주사위 굴리기' : '이미 굴렸습니다') : (turnName ? turnName + '님이 하는 중' : '대기 중');
    if (!you.myTurn) { $('roll').classList.remove('hidden'); $('roll').disabled = true; }

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

  $('roll').onclick = function () { markSending($('roll')); send('roll'); };
  $('passage').onclick = function () { markSending($('passage')); send('passage'); };
  $('end').onclick = function () { markSending($('end')); accuseOpen = false; send('endTurn'); };
  $('suggest').onclick = function () { var form = $('suggest-form'); form.scrollIntoView && form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  $('accuse').onclick = function () { accuseOpen = !accuseOpen; render(); };
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
  }
  $('notebook').addEventListener('click', function (event) { cycleMark(event.target.closest ? event.target.closest('td.mark') : null); });
  $('notebook').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var cell = event.target.closest ? event.target.closest('td.mark') : null;
    if (cell) { event.preventDefault(); cycleMark(cell); }
  });

  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.dataset.help; }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
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
