(function () {
  'use strict';

  var NAME_KEY = 'game-portal-nickname';
  var TOKEN_KEY = 'poker-game-token';
  var nickname = sessionStorage.getItem(NAME_KEY);
  if (!nickname) { location.href = '/'; return; }

  var state = null;
  var donationTarget = null;

  function $(id) { return document.getElementById(id); }

  var socket = null;
  function send(type, extra) { if (socket) socket.send(type, extra); }
  function money(value) { return Number(value || 0).toLocaleString() + '원'; }

  /**
   * 참가자 줄에 쓰는 짧은 금액. 폰에서는 한 칸이 100px 남짓이라
   * "1,000,000원 · 배팅 100원"이 "1,000,000원 · 배..."로 잘렸다 - 정작 봐야 할
   * 배팅액이 사라졌다. 만 단위로 줄이고, 배팅이 없으면 그 구절 자체를 뺀다.
   */
  function shortMoney(value) {
    var won = Number(value || 0);
    if (won < 10000) return won.toLocaleString();
    var man = won / 10000;
    return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + '만';
  }
  function chipLine(player) {
    var chips = shortMoney(player.chips);
    return player.roundBet > 0 ? chips + ' · +' + shortMoney(player.roundBet) : chips;
  }

  /**
   * 레이즈 하한(= 직전 사람이 올린 폭)을 입력창에 그대로 반영한다.
   *
   * 서버가 거절하긴 하지만, 그것만으로는 얼마부터 되는지 알 수가 없어서 눌러 보고
   * 빨간 토스트를 보는 수밖에 없었다. 하한이 올라가면 기본값도 같이 끌어올린다.
   * 사용자가 하한보다 큰 값을 직접 적어 뒀다면 그건 건드리지 않는다.
   */
  var lastRaiseFloor = null;
  function syncRaiseFloor(floor) {
    var input = $('raise-amount');
    var min = Number(floor) > 0 ? Number(floor) : 100;
    input.min = String(min);
    input.step = '100';
    input.setAttribute('aria-label', '레이즈 금액 (최소 ' + money(min) + ')');
    if (lastRaiseFloor !== min || Number(input.value) < min) input.value = String(min);
    lastRaiseFloor = min;
  }
  function escapeHtml(value) { var el = document.createElement('div'); el.textContent = value; return el.innerHTML; }
  var errorTimer = null;
  function showError(text) {
    $('error').textContent = text;
    $('error').style.display = 'block';
    clearTimeout(errorTimer); // 앞의 토스트가 뒤에 온 것까지 같이 지우지 않게 한다
    errorTimer = setTimeout(function () { $('error').style.display = 'none'; }, 3000);
  }


  function cardLabel(card) {
    if (card.hidden) return '';
    var labels = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return (labels[card.rank] || card.rank) + card.suit;
  }

  /**
   * [요청] 게임 시작을 누르면 바로 시작하지 않고, 누가 준비를 안 했는지 먼저 보여 준다.
   * 예전에는 누르는 즉시 준비한 사람끼리 판이 시작되어, 준비를 깜빡한 사람이 모른 채
   * 빠졌다. 창이 열려 있는 동안 준비 상태가 바뀌면 목록도 따라 바뀌고, 그사이 다른
   * 사람이 먼저 시작했거나 시작할 수 없게 되면 창을 닫는다.
   */
  var startConfirmOpen = false;
  function renderStartConfirm() {
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    if (startConfirmOpen && (!lobby || !state.canStart)) startConfirmOpen = false;
    $('start-confirm').classList.toggle('hidden', !startConfirmOpen);
    if (!startConfirmOpen) return;
    // 서버와 같은 기준: 준비했고 칩이 있어야 이번 판에 들어간다.
    var joining = state.players.filter(function (p) { return p.ready && p.chips > 0; });
    var left = state.players.filter(function (p) { return !(p.ready && p.chips > 0); });
    var names = function (list) { return list.map(function (p) { return p.nickname + (p.ready && p.chips <= 0 ? '(칩 없음)' : ''); }).join(', '); };
    $('start-confirm-title').textContent = '준비한 ' + joining.length + '명으로 시작할까요?';
    $('start-confirm-ready').textContent = '준비: ' + names(joining);
    $('start-confirm-waiting').textContent = left.length
      ? '준비 안 함: ' + names(left) + ' · 이번 판에서 빠집니다.'
      : '모두 준비했습니다.';
  }
  function closeStartConfirm() { startConfirmOpen = false; renderStartConfirm(); }

  function renderProposal() {
    var proposal = state.baseBetProposal;
    $('proposal').classList.toggle('hidden', !proposal || proposal.yourVote);
    if (!proposal) return;
    $('proposal-title').textContent = proposal.proposerName + '님이 ' + money(proposal.amount) + '을 제안했습니다.';
    $('proposal-count').textContent = '찬성 ' + proposal.agreed + '명 · 투표 ' + proposal.voted + '/' + proposal.total + '명';
  }

  function render() {
    document.body.dataset.phase = state.phase;
    var you = state.players.find(function (player) { return player.id === state.you.id; });
    var lobby = state.phase === 'lobby' || state.phase === 'result';
    var myTurn = state.turnPlayerId === state.you.id;
    $('pot').textContent = money(state.pot);
    $('base-label').textContent = '기본 ' + money(state.baseBet);
    $('base-bet').value = state.baseBet;
    $('phase').textContent = { lobby: '대기 중', betting: '배팅 중', showdown: '쇼다운', result: '라운드 종료' }[state.phase] || state.phase;
    $('lobby').classList.toggle('hidden', !lobby);
    $('betting').classList.toggle('hidden', state.phase !== 'betting');
    $('ready').textContent = you.ready ? '준비 취소' : '준비';
    $('start').disabled = !state.canStart;
    $('set-bet').disabled = !!state.baseBetProposal;
    $('betting').querySelectorAll('button').forEach(function (button) { button.disabled = !myTurn; });
    // 상한이 고정된 뒤에도 올인은 열어 둔다. 콜은 칩이 모자라면 서버가 거절하고
    // 레이즈는 아래에서 막히므로, 올인까지 잠그면 칩이 적은 사람에게 남는 선택지가
    // 폴드뿐이 된다 - 자기 칩을 다 걸고 겨뤄 볼 기회조차 없었다. 서버는 진작부터
    // 이 올인을 받아 주고 있었고, 막고 있던 건 이 한 줄이었다.
    $('allin').disabled = !myTurn || you.chips <= 0;
    $('raise').disabled = !myTurn || state.allInCap !== null;
    // 앤티를 내고 나면 더 낼 것이 없는 경우가 많다. 그때 "콜 · 0원"은 체크다.
    var toCall = Math.max(0, state.currentBet - you.roundBet);
    $('call').textContent = toCall ? '콜 · ' + money(toCall) : '체크';
    syncRaiseFloor(state.minRaise);

    // 시작 버튼이 꺼져 있으면 그 이유를 그대로 말해 준다. 예전에는 "방장만 시작"이라는
    // 숨은 규칙 때문에 회색 버튼만 보이고 이유를 알 수 없었다(이제 아무나 시작할 수 있다).
    var message = '참가자들이 준비하면 시작할 수 있습니다.';
    if (lobby) {
      message = state.canStart
        ? '준비한 ' + state.readyCount + '명으로 새 판을 시작할 수 있습니다.'
        : '준비한 참가자가 ' + state.minPlayers + '명 이상이면 누구나 시작할 수 있습니다. (현재 '
          + state.readyCount + '명)';
    }
    if (state.phase === 'betting') {
      var turnPlayer = state.players.find(function (player) { return player.id === state.turnPlayerId; });
      message = turnPlayer ? '현재 ' + turnPlayer.nickname + '님의 배팅 차례입니다.' + (myTurn ? ' 상대 카드와 배팅을 확인하세요.' : '') : '배팅을 진행하고 있습니다.';
      if (!state.you.inRound) message = '진행 중인 판을 관전하고 있습니다. 다음 판부터 참여할 수 있습니다.';
      else if (you.isFolded) message = '폴드했습니다. 남은 판을 관전하고 있습니다.';
    }
    if (state.result) message = state.result.noWinner ? state.result.message : state.result.nickname + '님이 ' + money(state.result.amount) + '을 획득했습니다.';
    // [보스 키] 차례인 사람이 화면을 가려 두는 동안에는 그 사람의 제한시간이 멈춘다(web/cover-pause.js).
    if (state.paused && !state.result) message += ' 차례인 사람의 화면이 가려져 있어 제한시간이 멈췄습니다.';
    $('message').textContent = message;

    $('players').innerHTML = state.players.map(function (player) {
      var waiting = state.phase === 'betting' && !player.inRound;
      // 판이 끝나 대기 중일 때는 지난 판의 폴드·올인이 아니라 다음 판 준비 여부를 보여 준다.
      var status = lobby ? (player.ready ? '준비' : '대기')
        : waiting ? '다음 판 대기' : player.isFolded ? '폴드' : player.isAllIn ? '올인' : player.ready ? '준비' : '대기';
      // 끊긴 채로 판에 남은 사람(올인하고 기다리는 사람). 차례가 오지 않으니 기다릴 필요는 없다.
      // "올인 · 끊김"처럼 두 단어를 쓰면 폰에서 옆의 금액 줄("0 · +100만")이 잘린다.
      // 올인했다는 건 그 금액 줄이 이미 말해 주므로 한 단어로 둔다.
      if (player.connected === false) status = '끊김';
      var initial = Array.from(player.nickname)[0] || '나';
      return '<div class="player ' + (player.id === state.turnPlayerId ? 'turn' : '') + '" role="button" tabindex="0" title="대기 중 선택하면 기부할 수 있습니다" data-id="' + player.id + '" data-initial="' + escapeHtml(initial) + '"><b>' + escapeHtml(player.nickname) + (player.id === state.you.id ? ' (나)' : '') + '</b><small>' + chipLine(player) + '</small><span class="status">' + status + '</span></div>';
    }).join('');

    var canSeeTable = state.phase !== 'betting' || (state.you.inRound && !you.isFolded);
    $('cards').innerHTML = (canSeeTable ? state.players : []).filter(function (player) { return player.card; }).map(function (player) {
      var red = !player.card.hidden && (player.card.suit === '♥' || player.card.suit === '♦');
      return '<div class="seat ' + (player.isFolded ? 'folded' : '') + '"><div class="card ' + (player.card.hidden ? 'hidden-card ' : '') + (red ? 'red' : '') + '">' + cardLabel(player.card) + '</div><b>' + escapeHtml(player.nickname) + '</b></div>';
    }).join('');

    $('history').innerHTML = state.history.slice().reverse().map(function (item) { return '<div>' + escapeHtml(item.text) + '</div>'; }).join('');
    function openDonation(element, event) {
        event.preventDefault(); event.stopPropagation();
        if (state.phase !== 'lobby' && state.phase !== 'result') { showError('기부는 대기 중에만 할 수 있습니다.'); return; }
        if (element.dataset.id === state.you.id) return;
        donationTarget = element.dataset.id;
        var target = state.players.find(function (player) { return player.id === donationTarget; });
        $('donate-name').textContent = target.nickname + '님에게';
        var rect = element.getBoundingClientRect();
        $('donate').style.left = Math.min(event.clientX || rect.right, innerWidth - 190) + 'px';
        $('donate').style.top = Math.min(event.clientY || rect.bottom, innerHeight - 150) + 'px';
        $('donate').classList.remove('hidden');
    }
    document.querySelectorAll('.player').forEach(function (element) {
      element.oncontextmenu = function (event) { openDonation(element, event); };
      element.onclick = function (event) { openDonation(element, event); };
      element.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') openDonation(element, event); };
    });
    renderProposal();
    renderStartConfirm();
  }

  $('ready').onclick = function () { send('ready', { ready: !state.players.find(function (p) { return p.id === state.you.id; }).ready }); };
  $('leave').onclick = function (event) { event.preventDefault(); if (socket) socket.leave(); };
  $('set-bet').onclick = function () { send('baseBet', { amount: Number($('base-bet').value) }); };
  $('proposal-yes').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: true }); };
  $('proposal-no').onclick = function () { send('baseBetVote', { proposalId: state.baseBetProposal.id, agree: false }); };
  $('start').onclick = function () { startConfirmOpen = true; renderStartConfirm(); };
  $('start-cancel').onclick = closeStartConfirm;
  $('start-go').onclick = function () { closeStartConfirm(); send('start'); };
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && startConfirmOpen) closeStartConfirm(); });
  $('call').onclick = function () { send('call'); };
  $('raise').onclick = function () { send('raise', { amount: Number($('raise-amount').value) }); };
  $('allin').onclick = function () { send('allin'); };
  $('fold').onclick = function () { send('fold'); };
  $('donate-send').onclick = function () { send('donate', { targetId: donationTarget, amount: Number($('donate-amount').value) }); $('donate').classList.add('hidden'); };
  document.querySelectorAll('button[data-help]').forEach(function (button) {
    function showHelp() { $('action-help').textContent = button.dataset.help; }
    button.addEventListener('mouseenter', showHelp);
    button.addEventListener('focus', showHelp);
    button.addEventListener('touchstart', showHelp, { passive: true });
  });
  document.addEventListener('click', function (event) { if (!$('donate').contains(event.target)) $('donate').classList.add('hidden'); });
  // 연결·재접속·확인·보스 키 알림은 public/game-socket.js가 한다. 여기서는 포커 메시지만 처리한다.
  socket = window.GameSocket.open({
    game: 'poker',
    tokenKey: TOKEN_KEY,
    nickname: nickname,
    onMessage: function (data) {
      if (data.type === 'error') { showError(data.message); return; }
      if (data.type === 'pokerState') { state = data; render(); }
    }
  });
}());
