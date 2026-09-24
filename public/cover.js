/**
 * [요청] 보스 키 - 마우스 우클릭 한 번으로 화면 전체를 업무 화면처럼 보이는 그림으로 덮는다.
 *
 * 업무 중에 하는 게임이라 누가 다가오면 바로 가릴 수 있어야 한다. 덮는 그림은 매번
 * 무작위로 고르고, 브라우저 탭 제목도 그 그림에 맞게 바꾼다("인디언 포커"가 탭에 그대로
 * 보이면 소용없다). 다시 우클릭하거나 Esc를 누르면 원래 화면으로 돌아온다.
 *
 * 다른 우클릭 기능과의 관계:
 *   - 카드 게임의 참가자 우클릭(기부 창)은 양보한다. 기부 창은 왼쪽 클릭으로도 열린다.
 *   - 라이어 게임의 참가자 목록 우클릭(강퇴 메뉴)은 남겨 둔다. 데스크톱에서는 그게 강퇴
 *     메뉴를 여는 유일한 방법이다. 남길 자리는 마크업에 data-keep-contextmenu="선택자"로
 *     표시한다.
 *   - 폰의 길게 누르기도 contextmenu로 오지만, 폰에는 우클릭이 없으니 원래 동작을 둔다.
 *
 * 모든 페이지(포털·라이어·포커·블랙잭)가 이 파일 하나를 같이 쓴다.
 *
 * [요청] 한 명이 가리면 접속한 모든 사람의 화면도 같이 가린다 - 누가 어디서 누르든
 * 무조건(포털·게임 참가 전·입력칸 위 포함). 예외는 위의 두 가지뿐이다(라이어 참가자 목록의
 * 강퇴 메뉴, 폰 길게 누르기). 내가 우클릭으로 가리면
 * 'boss-cover' 이벤트를 쏘고, 각 페이지가 자기 연결로 서버에 알린다. 서버가 {type:'cover'}를
 * 보내오면 페이지가 window.bossCover.show()를 부른다. 돌아오는 것은 각자 한다.
 *
 * [요청] 가려진 동안은 제한시간도 멈춘다. 가리거나 돌아올 때마다(남이 가린 경우도)
 * 'boss-cover-state' 이벤트를 쏘고, 각 페이지가 서버에 {type:'coverState'}로 알린다.
 */
(function () {
  'use strict';
  var COVERS = [
    { src: 'cover-1.webp', title: '올리브영 온라인몰' },
    { src: 'cover-2.webp', title: '[1등미백앰플]메디큐브 PDRN 핑크 펩타이드 앰플 | 올리브영' },
  ];
  var overlay = null;
  var savedTitle = null;
  var savedOverflow = '';
  var lastIndex = -1;
  var lastPointer = 'mouse';

  // 미리 받아 둔다. 급할 때 누르는 기능인데, 그때 그림을 받느라 한 박자 늦으면 안 된다.
  COVERS.forEach(function (cover) { var img = new Image(); img.src = cover.src; });

  function pick() {
    if (COVERS.length === 1) return 0;
    var index;
    do { index = Math.floor(Math.random() * COVERS.length); } while (index === lastIndex);
    return index;
  }

  // 내 화면이 가려졌는지/돌아왔는지 페이지에 알린다. 페이지가 자기 연결로 서버에 전하고,
  // 서버는 가려진 동안 나를 기다리는 제한시간을 멈춘다(web/cover-pause.js).
  function announce(covered) {
    try { document.dispatchEvent(new CustomEvent('boss-cover-state', { detail: { covered: covered } })); } catch (error) { /* 알리지 못해도 화면은 그대로 */ }
  }

  function show() {
    if (overlay) return; // 이미 가려져 있다(남이 가린 신호가 겹쳐 와도 그대로)
    var index = pick();
    lastIndex = index;
    var cover = COVERS[index];
    overlay = document.createElement('div');
    overlay.id = 'boss-cover';
    overlay.setAttribute('aria-hidden', 'true');
    // 인라인 style 속성은 CSP(style-src 'self')가 막으므로 CSSOM으로만 지정한다.
    var s = overlay.style;
    s.position = 'fixed'; s.top = '0'; s.left = '0'; s.right = '0'; s.bottom = '0';
    s.zIndex = '2147483647'; s.background = '#fff'; s.cursor = 'default';
    var img = document.createElement('img');
    img.src = cover.src;
    img.alt = '';
    img.draggable = false;
    var i = img.style;
    i.display = 'block'; i.width = '100%'; i.height = '100%';
    i.objectFit = 'cover'; i.objectPosition = 'center top';
    overlay.appendChild(img);
    // 가린 뒤에 누른 키·클릭이 뒤의 게임으로 새지 않게, 그림 위에서 전부 멈춘다.
    ['click', 'dblclick', 'mousedown', 'mouseup', 'wheel', 'touchstart'].forEach(function (type) {
      overlay.addEventListener(type, function (event) { event.stopPropagation(); if (type !== 'touchstart') event.preventDefault(); }, { passive: false });
    });
    document.body.appendChild(overlay);
    savedTitle = document.title;
    document.title = cover.title;
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    // 입력창에 커서가 있으면 치던 글자가 게임으로 들어가지 않게 뺀다.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    announce(true);
  }

  function hide() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.title = savedTitle;
    document.documentElement.style.overflow = savedOverflow;
    announce(false);
  }

  document.addEventListener('pointerdown', function (event) { lastPointer = event.pointerType || 'mouse'; }, true);

  // 캡처 단계에서 먼저 받는다. 참가자 줄처럼 자기 우클릭 기능이 있는 요소보다 앞서야 한다.
  window.addEventListener('contextmenu', function (event) {
    if (lastPointer === 'touch' || lastPointer === 'pen') return;
    if (!overlay) {
      var target = event.target && event.target.closest ? event.target : null;
      var zone = target && target.closest('[data-keep-contextmenu]');
      if (zone && target.closest(zone.getAttribute('data-keep-contextmenu'))) return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (overlay) { hide(); return; }
    show();
    // 다른 사람들 화면도 가리도록 각 페이지에 알린다(페이지가 자기 연결로 서버에 보낸다).
    try { document.dispatchEvent(new CustomEvent('boss-cover')); } catch (error) { /* 알림 실패해도 내 화면은 가려져 있다 */ }
  }, true);

  // 가려진 동안에는 Esc만 받는다(돌아가기). 다른 키는 뒤의 게임으로 보내지 않는다.
  window.addEventListener('keydown', function (event) {
    if (!overlay) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.key === 'Escape') hide();
  }, true);
  window.bossCover = { show: show, isShown: function () { return !!overlay; } };
}());
