(function () {
  'use strict';
  var KEY = 'game-portal-nickname';
  var nameScreen = document.getElementById('name-screen');
  var gamesScreen = document.getElementById('games-screen');
  var input = document.getElementById('nickname');

  function showGames(name) {
    sessionStorage.setItem(KEY, name);
    document.getElementById('player-name').textContent = name;
    document.getElementById('profile-initial').textContent = Array.from(name)[0] || '나';
    nameScreen.classList.add('hidden');
    gamesScreen.classList.remove('hidden');
  }

  document.getElementById('name-form').onsubmit = function (event) {
    event.preventDefault();
    var name = input.value.trim();
    if (name) showGames(name);
  };
  document.getElementById('rename').onclick = function () {
    gamesScreen.classList.add('hidden');
    nameScreen.classList.remove('hidden');
    input.focus();
  };
  document.querySelectorAll('.game-card').forEach(function (card) {
    card.onclick = function () { location.href = card.dataset.url; };
  });

  var saved = sessionStorage.getItem(KEY);
  if (saved) { input.value = saved; showGames(saved); }

  // 연결·재접속·확인(폰이 잠들었다 깨어난 좀비 연결 포함)은 public/game-socket.js가 한다.
  // 포털은 참가하지 않고 게임별 인원·상태만 듣는다. [보스 키] 포털에서 가려도 게임 중인 사람들
  // 화면까지 가려지고(누가 눌러도 무조건 모두), 남이 가리면 포털에 있는 사람도 가려진다 - 둘 다 거기서 한다.
  window.GameSocket.open({
    game: 'portal',
    onMessage: function (data) {
      if (data.type !== 'games') return;
      Object.keys(data.games).forEach(function (id) {
        var game = data.games[id];
        var card = document.querySelector('.game-card.' + id);
        // 배포 전에 열어 둔 화면에는 새로 생긴 게임의 칸이 없다. 없는 칸은 건너뛴다
        // (예전에는 여기서 오류가 나 그 뒤 게임들이 갱신되지 않았다).
        if (!card || !document.getElementById(id + '-status')) return;
        document.getElementById(id + '-status').textContent = game.status;
        document.getElementById(id + '-count').textContent = game.playerCount + '명';
        card.classList.toggle('running', game.status === '진행중');
        card.classList.toggle('waiting', game.status === '진행 대기중');
      });
    }
  });
}());
