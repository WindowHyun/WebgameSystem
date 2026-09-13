(function () {
  'use strict';
  var KEY = 'game-portal-nickname';
  var nameScreen = document.getElementById('name-screen');
  var gamesScreen = document.getElementById('games-screen');
  var input = document.getElementById('nickname');
  var ws = null;
  var reconnectDelay = 500;

  function showGames(name) {
    sessionStorage.setItem(KEY, name);
    document.getElementById('player-name').textContent = name;
    document.getElementById('profile-initial').textContent = Array.from(name)[0] || '나';
    nameScreen.classList.add('hidden');
    gamesScreen.classList.remove('hidden');
  }

  function connect() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/api/ws?game=portal');
    ws.onopen = function () { reconnectDelay = 500; };
    ws.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (error) { return; }
      if (data.type !== 'games') return;
      Object.keys(data.games).forEach(function (id) {
        var game = data.games[id];
        var card = document.querySelector('.game-card.' + id);
        document.getElementById(id + '-status').textContent = game.status;
        document.getElementById(id + '-count').textContent = game.playerCount + '명';
        card.classList.toggle('running', game.status === '진행중');
        card.classList.toggle('waiting', game.status === '진행 대기중');
      });
    };
    ws.onerror = function () { /* onclose에서 재연결한다. */ };
    ws.onclose = function () {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
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
  setInterval(function () {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20000);
  connect();
}());
