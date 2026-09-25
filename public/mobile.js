/**
 * [모바일] 주 사용자가 폰이라 게임 화면(라이어·포커·블랙잭·더 마인드)이 같이 쓰는 보조 기능.
 * 마우스가 없는 기기(폰·태블릿)에서만 켠다. PC에서 화면을 켜 두면 회사 모니터가 꺼지지 않고
 * 자동 잠금도 늦어져 오히려 눈에 띈다.
 *
 * 1) 화면 꺼짐 방지(Screen Wake Lock)
 *    남의 차례를 기다리는 동안 폰이 자동 잠금(보통 30초~1분)되면 브라우저가 페이지를 멈추고,
 *    1분쯤 뒤 서버는 연결이 끊긴 것으로 본다. 그러면 포커·블랙잭은 폴드되고, 라이어는
 *    라운드에서 빠지고(그 사람이 라이어였다면 판이 끝난다), 더 마인드는 모두 멈췄다.
 *    게임 화면이 보이는 동안 화면을 켜 둔다. 다른 앱·탭으로 가면 브라우저가 알아서 풀고,
 *    돌아오면 다시 건다. 오래(IDLE_MS) 아무도 화면을 만지지 않으면 폰을 내려놓은 것으로 보고
 *    풀어서 평소처럼 꺼지게 둔다(다시 만지면 건다).
 *    안전한 주소(https, localhost)에서만 되는 기능이라 LAN의 http 주소에서는 조용히 넘어간다.
 *
 * 2) 버튼 설명 보기
 *    데스크톱은 버튼에 마우스를 올리면 설명(data-help)이 뜨지만 폰에는 마우스가 없어 설명을
 *    볼 방법이 없었다. 마우스가 없는 기기에서만 상단에 "?" 버튼을 붙이고, 누르면 지금 보이는
 *    버튼들의 설명을 한꺼번에 보여 준다. 버튼을 길게 눌러 설명을 보는 방식은 쓰지 않는다 -
 *    더 마인드에서 "카드 내기"를 누른 채 때를 기다렸다 떼는 사람의 카드가 안 나가게 된다.
 */
(function () {
  'use strict';
  if (window.matchMedia && window.matchMedia('(hover: hover)').matches) return;

  // ── 1) 화면 꺼짐 방지 ──
  var IDLE_MS = 10 * 60 * 1000;
  var lock = null;
  var requesting = false;
  var idle = false;
  var idleTimer = null;

  function acquire() {
    if (!('wakeLock' in navigator) || lock || requesting || idle || document.visibilityState !== 'visible') return;
    requesting = true;
    var request;
    try { request = navigator.wakeLock.request('screen'); } catch (error) { requesting = false; return; }
    Promise.resolve(request).then(function (sentinel) {
      requesting = false;
      lock = sentinel;
      // 페이지가 가려지면 브라우저가 먼저 푼다. 돌아올 때 다시 걸 수 있게 비워 둔다.
      sentinel.addEventListener('release', function () { if (lock === sentinel) lock = null; });
      if (idle) release();
    }, function () { requesting = false; /* 배터리 절약 모드 등으로 거절되면 평소처럼 둔다 */ });
  }

  function release() {
    var sentinel = lock;
    lock = null;
    if (sentinel) sentinel.release().catch(function () { /* 이미 풀렸다 */ });
  }

  function touched() {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { idle = true; release(); }, IDLE_MS);
    acquire();
  }

  // 브라우저에 따라 사용자가 한 번 만진 뒤에야 걸리기도 해서, 만질 때마다 확인한다(걸려 있으면 그냥 넘어간다).
  ['pointerdown', 'keydown'].forEach(function (type) { document.addEventListener(type, touched, true); });
  document.addEventListener('visibilitychange', acquire);
  window.addEventListener('pageshow', acquire);
  touched();

  // ── 2) 버튼 설명 보기 ──
  var topbar = document.querySelector('.topbar');
  if (!topbar || !document.querySelector('button[data-help]')) return;

  var open = document.createElement('button');
  open.type = 'button';
  open.id = 'help-open';
  open.className = 'help-open';
  open.textContent = '?';
  open.setAttribute('aria-label', '버튼 설명 보기');
  open.setAttribute('aria-haspopup', 'dialog');
  topbar.appendChild(open);

  var sheet = document.createElement('div');
  sheet.id = 'help-sheet';
  sheet.className = 'modal hidden';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'help-sheet-title');
  var card = document.createElement('div');
  card.className = 'modal-card help-card';
  var kicker = document.createElement('small');
  kicker.textContent = '버튼 설명';
  var title = document.createElement('h2');
  title.id = 'help-sheet-title';
  title.textContent = '지금 보이는 버튼';
  var list = document.createElement('dl');
  list.className = 'help-list';
  // 폰에서 보스 키를 켜는 방법(public/cover.js)은 눈에 보이는 버튼이 없어서 여기서 알려 준다.
  var note = document.createElement('p');
  note.className = 'help-note';
  note.textContent = '보스 키: 두 손가락으로 화면을 2초 동안 누르고 있으면 모두의 화면이 쇼핑몰 화면으로 가려집니다. 가려진 화면은 한 번 누르면 돌아옵니다.';
  var foot = document.createElement('div');
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'secondary';
  close.textContent = '닫기';
  foot.appendChild(close);
  [kicker, title, list, note, foot].forEach(function (node) { card.appendChild(node); });
  sheet.appendChild(card);
  document.body.appendChild(sheet);

  function shown(element) { return element.getClientRects().length > 0; }
  function labelOf(button) { return (button.textContent || '').replace(/\s+/g, ' ').trim() || button.getAttribute('aria-label') || ''; }

  function fill() {
    list.textContent = '';
    var seen = {};
    Array.prototype.forEach.call(document.querySelectorAll('button[data-help]'), function (button) {
      if (!shown(button)) return;
      var label = labelOf(button);
      var key = label + '\n' + button.dataset.help;
      if (seen[key]) return;
      seen[key] = true;
      var term = document.createElement('dt');
      term.textContent = button.disabled ? label + ' (지금은 누를 수 없음)' : label;
      var detail = document.createElement('dd');
      detail.textContent = button.dataset.help;
      list.appendChild(term);
      list.appendChild(detail);
    });
    if (!list.firstChild) {
      var none = document.createElement('dd');
      none.textContent = '지금 화면에 누를 버튼이 없습니다.';
      list.appendChild(none);
    }
  }

  function show() { fill(); sheet.classList.remove('hidden'); close.focus(); }
  function hide() { sheet.classList.add('hidden'); }
  open.addEventListener('click', show);
  close.addEventListener('click', hide);
  sheet.addEventListener('click', function (event) { if (event.target === sheet) hide(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !sheet.classList.contains('hidden')) hide(); });
}());
