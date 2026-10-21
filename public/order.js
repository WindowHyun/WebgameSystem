(function () {
  'use strict';
  var REFRESH_MS = 3000;
  var busy = false;
  var typing = false; // 금액을 입력하는 중이면 화면을 다시 그려 입력을 날리지 않는다

  function $(id) { return document.getElementById(id); }
  function money(n) { return Number(n || 0).toLocaleString() + '원'; }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text; // 닉네임은 항상 textContent로만 넣는다
    return node;
  }

  function api(path, options) {
    var init = options || {};
    init.cache = 'no-store';
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) { var err = new Error(body.error || '요청에 실패했습니다.'); err.status = res.status; throw err; }
        return body;
      });
    });
  }

  function notice(text, bad) {
    var n = $('notice');
    n.textContent = text || '';
    n.className = 'notice' + (bad ? ' bad' : '');
  }

  function stateText(game, p) {
    if (!p.connected) return '끊김';
    if (game.key === 'liar') return p.spectator ? '관전' : p.inRound ? '라운드 참여' : '대기';
    if (game.running) return p.inRound ? '플레이 중' : '구경';
    return p.ready ? '준비' : '대기';
  }

  function render(data) {
    var online = 0;
    var running = 0;
    var box = $('games');
    box.textContent = '';
    data.games.forEach(function (game) {
      if (game.running) running += 1;
      online += game.players.filter(function (p) { return p.connected; }).length;

      var section = el('section', 'game');
      var head = el('header');
      head.appendChild(el('h2', '', game.label));
      head.appendChild(el('span', 'badge' + (game.running ? ' run' : ''), game.running ? '진행중' : '대기중'));
      var connected = game.players.filter(function (p) { return p.connected; }).length;
      head.appendChild(el('span', 'count', '접속 ' + connected + '명'));
      section.appendChild(head);

      if (!game.players.length) section.appendChild(el('div', 'empty', '아무도 없습니다.'));
      game.players.forEach(function (p) {
        var row = el('div', 'row');
        row.appendChild(el('span', 'name' + (p.connected ? '' : ' off'), p.nickname));
        var info = el('span', 'state', stateText(game, p));
        if (game.chips) {
          info.appendChild(document.createTextNode(' · '));
          info.appendChild(el('span', 'chips', money(p.chips)));
        }
        row.appendChild(info);
        if (game.chips) row.appendChild(depositForm(game, p));
        else row.appendChild(el('span'));
        section.appendChild(row);
      });
      box.appendChild(section);
    });
    $('sum-online').textContent = online;
    $('sum-running').textContent = running;
    $('sum-portal').textContent = data.portal;
    $('stamp').textContent = new Date(data.serverTime).toLocaleTimeString() + ' 기준';
  }

  function depositForm(game, p) {
    var wrap = el('span', 'deposit');
    var input = el('input');
    input.type = 'number'; input.min = '1'; input.step = '1'; input.inputMode = 'numeric';
    input.placeholder = '입금액(원)';
    input.setAttribute('aria-label', p.nickname + '에게 입금할 금액');
    input.addEventListener('focus', function () { typing = true; });
    input.addEventListener('blur', function () { typing = false; });
    var button = el('button', '', '입금');
    button.type = 'button';
    button.addEventListener('click', function () {
      var amount = Number(input.value);
      if (!Number.isInteger(amount) || amount < 1) { notice('입금액을 1 이상의 정수로 입력해 주세요.', true); return; }
      if (!window.confirm(game.label + ' · ' + p.nickname + '님에게 ' + money(amount) + '을 입금할까요?\n(기부가 아니라 칩이 새로 늘어납니다)')) return;
      button.disabled = true;
      api('/order/api/deposit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: game.key, playerId: p.id, amount: amount }) })
        .then(function (body) { typing = false; notice(game.label + ' · ' + p.nickname + '님에게 ' + money(amount) + ' 입금했습니다.'); render(body.state); })
        .catch(function (err) { notice(err.message, true); button.disabled = false; });
    });
    wrap.appendChild(input);
    wrap.appendChild(button);
    return wrap;
  }

  function refresh() {
    if (busy || typing) return Promise.resolve();
    busy = true;
    return api('/order/api/state').then(function (data) {
      render(data);
    }).catch(function (err) { notice(err.message, true); }).then(function () { busy = false; });
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
