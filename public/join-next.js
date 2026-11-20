/**
 * "다음 판 참가하기" 버튼 - 카드 게임 일곱 개가 같이 쓴다.
 *
 * 판이 한창일 때 들어온 사람(또는 이번 판에 못 뛰는 사람)은 구경하다가 판이 끝난 뒤에야 "준비"를 누를 수 있었다.
 * 이 버튼은 진행 중에도 미리 "다음 판 참가"를 눌러 두게 한다. 서버는 이것을 준비(ready)로 받아 두었다가
 * 판이 끝나면 그대로 이어 준다(web/*-room.js의 setReady·autoReadyNext). 새 요청이 아니라 기존 ready 요청을 쓴다.
 *
 * 각 게임 화면(poker.js 등)은 건드리지 않는다. public/game-socket.js가 상태 메시지마다 'game-state' 이벤트를 보내 주고,
 * 여기서는 거기에 담긴 you(내 정보)·phase만 본다.
 */
(function () {
  'use strict';

  var state = null;
  var bar = null;
  var note = null;
  var button = null;
  var pending = null;

  function build() {
    if (bar) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'join-next.css?v=1';
    document.head.appendChild(link);

    bar = document.createElement('section');
    bar.id = 'join-next-bar';
    bar.className = 'controls join-next';
    bar.style.display = 'none';
    note = document.createElement('p');
    note.className = 'join-next-note';
    var actions = document.createElement('div');
    actions.className = 'main-actions';
    button = document.createElement('button');
    button.type = 'button';
    button.id = 'join-next';
    button.className = 'secondary';
    actions.appendChild(button);
    bar.appendChild(note);
    bar.appendChild(actions);

    var help = document.getElementById('action-help');
    var parent = help ? help.parentNode : (document.querySelector('main') || document.body);
    parent.insertBefore(bar, help || null);

    button.onclick = function () {
      var socket = window.GameSocket && window.GameSocket.current;
      if (!state || !socket) return;
      button.disabled = true; // 서버 응답(다음 상태)이 오면 render()가 다시 켠다
      clearTimeout(pending);
      pending = setTimeout(function () { if (state) render(); }, 1500);
      socket.send('ready', { ready: !state.you.ready });
    };
  }

  /** 지금 판이 진행 중이고, 나는 이번 판을 뛰고 있지 않은가. */
  function waiting(s) {
    var you = s.you;
    if (!you || !s.phase) return false;
    if (s.phase === 'lobby' || s.phase === 'result' || s.abandoned) return false;
    if (typeof you.inRound === 'boolean') return !you.inRound; // 포커·블랙잭·홀덤
    if (typeof you.inGame === 'boolean') return !you.inGame;   // 더 마인드·갈팡질팡·야추다이스·클루
    return false;
  }

  function render() {
    if (!bar || !state) return;
    clearTimeout(pending);
    var show = waiting(state);
    bar.style.display = show ? '' : 'none';
    if (!show) return;
    var you = state.you;
    var broke = typeof you.chips === 'number' && you.chips <= 0;
    button.disabled = broke;
    button.textContent = broke ? '칩이 없어 다음 판에 참가할 수 없습니다' : (you.ready ? '다음 판 참가 취소' : '다음 판 참가하기');
    note.textContent = you.ready
      ? '다음 판에 참가하도록 등록했습니다. 이번 판이 끝나면 자동으로 준비된 상태가 됩니다.'
      : '이번 판은 구경 중입니다. 눌러 두면 이번 판이 끝난 뒤 다음 판에 함께 참가합니다.';
  }

  document.addEventListener('game-state', function (event) {
    var data = event.detail;
    if (!data || !data.you || !data.phase) return;
    state = data;
    build();
    render();
  });
}());
