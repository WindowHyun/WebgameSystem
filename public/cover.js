/**
 * [요청] 보스 키 - 마우스 우클릭 한 번으로 화면 전체를 업무 화면처럼 보이는 그림으로 덮는다.
 *
 * 업무 중에 하는 게임이라 누가 다가오면 바로 가릴 수 있어야 한다. 덮는 그림은 매번
 * 무작위로 고르고(PC는 PC 쇼핑몰 화면, 세로로 든 폰은 모바일 쇼핑몰 화면), 브라우저 탭 제목도
 * 그 그림에 맞게 바꾼다("인디언 포커"가 탭에 그대로 보이면 소용없다). 다시 우클릭하거나 Esc를 누르면 원래 화면으로 돌아온다.
 * 폰(우클릭도 Esc도 없다)에서는 가린 그림을 손가락으로 한 번 누르면 돌아온다.
 *
 * 다른 우클릭 기능과의 관계:
 *   - 카드 게임의 참가자 우클릭(기부 창)은 양보한다. 기부 창은 왼쪽 클릭으로도 열린다.
 *   - 라이어 게임의 참가자 목록 우클릭(강퇴 메뉴)은 남겨 둔다. 데스크톱에서는 그게 강퇴
 *     메뉴를 여는 유일한 방법이다. 남길 자리는 마크업에 data-keep-contextmenu="선택자"로
 *     표시한다.
 *   - 폰의 길게 누르기도 contextmenu로 오지만, 폰에는 우클릭이 없으니 원래 동작을 둔다.
 *
 * [요청] 폰에서는 두 손가락(두 엄지)을 함께 대고 2초쯤 누르고 있으면 우클릭과 똑같이 가린다(한 번 더
 * 하면 돌아온다). 짧게 톡 치거나 두 엄지가 잠깐 겹친 것으로는 바뀌지 않는다 - 빠르게 번갈아 누르다
 * 모두의 화면이 가려지는 일이 있었다. 두 손가락 확대·스크롤, 세 손가락, 오래 대고 있던 엄지에
 * 나중에 닿은 손가락과도 구분한다.
 *
 * 모든 페이지(포털·라이어·포커·블랙잭·더 마인드)가 이 파일 하나를 같이 쓴다.
 *
 * [요청] 한 명이 가리면 접속한 모든 사람의 화면도 같이 가린다 - 누가 어디서 누르든
 * 무조건(포털·게임 참가 전·입력칸 위 포함). 예외는 위의 두 가지뿐이다(라이어 참가자 목록의
 * 강퇴 메뉴, 폰 길게 누르기). 내가 우클릭(폰은 두 손가락 2초 누르기)으로 가리면
 * 'boss-cover' 이벤트를 쏘고, 각 페이지가 자기 연결로 서버에 알린다. 서버가 {type:'cover'}를
 * 보내오면 페이지가 window.bossCover.show()를 부른다. 돌아오는 것은 각자 한다.
 *
 * [요청] 가려진 동안은 제한시간도 멈춘다. 가리거나 돌아올 때마다(남이 가린 경우도)
 * 'boss-cover-state' 이벤트를 쏘고, 각 페이지가 서버에 {type:'coverState'}로 알린다.
 */
(function () {
  'use strict';
  // PC로 본 쇼핑몰 화면(가로로 긴 캡처).
  var WIDE_COVERS = [
    { src: 'cover-1.webp', title: '올리브영 온라인몰' },
    { src: 'cover-2.webp', title: '[1등미백앰플]메디큐브 PDRN 핑크 펩타이드 앰플 | 올리브영' },
  ];
  // [요청] 폰에서는 폰으로 본 모바일 쇼핑몰 화면(세로로 긴 캡처)을 띄운다. PC 캡처를 세로 화면에
  // 꽉 채우면 한가운데만 크게 잘려 쇼핑몰로 보이지 않았다.
  var TALL_COVERS = [
    { src: 'cover-phone-1.webp', title: '올리브영 명동 타운 | 올리브영' },
    { src: 'cover-phone-2.webp', title: '올영매장 | 올리브영' },
    { src: 'cover-phone-3.webp', title: '선케어 | 올리브영' },
    { src: 'cover-phone-4.webp', title: '카테고리 | 올리브영' },
    { src: 'cover-phone-5.webp', title: '올리브영 온라인몰' },
  ];
  // 세로로 든 폰(마우스 없이 손가락으로 쓰고 폭이 폰 화면 기준 이하)만 모바일 캡처를 쓴다.
  // 폰을 가로로 돌리면 가로 캡처가 더 잘 맞고, PC는 창을 좁게 띄워도 PC 화면이 자연스럽다.
  // 폭이 넓은 태블릿도 PC 화면을 쓴다(폰 캡처를 늘리면 어색하다).
  var tallQuery = window.matchMedia
    ? window.matchMedia('(orientation: portrait) and (hover: none) and (max-width: 760px)')
    : null;
  var overlay = null;
  var savedTitle = null;
  var savedOverflow = '';
  var lastSrc = null;
  var lastPointer = 'mouse';
  var swallowUntil = 0;
  var TAP_GUARD_MS = 500;
  var HOLD_MS = 2000;  // [요청] 두 손가락을 함께 대고 이만큼 누르고 있어야 바뀐다
  var LAND_MS = 1000;  // 두 번째 손가락은 첫 손가락이 닿고 이 안에 닿아야 한다(오래 대고 있던 엄지와 구분)
  var HOLD_MOVE = 30;  // 누르는 동안 한 손가락이라도 이만큼(px) 넘게 움직이면 확대·스크롤로 본다

  function covers() { return tallQuery && tallQuery.matches ? TALL_COVERS : WIDE_COVERS; }

  // 미리 받아 둔다. 급할 때 누르는 기능인데, 그때 그림을 받느라 한 박자 늦으면 안 된다.
  // 지금 화면에 맞는 쪽만 받고(폰 데이터를 아낀다), 폰을 돌리면 그쪽 그림을 마저 받는다.
  var preloaded = {};
  function preload() {
    covers().forEach(function (cover) {
      if (preloaded[cover.src]) return;
      preloaded[cover.src] = true;
      var img = new Image();
      img.src = cover.src;
    });
  }
  preload();
  if (tallQuery && tallQuery.addEventListener) tallQuery.addEventListener('change', preload);
  else if (tallQuery && tallQuery.addListener) tallQuery.addListener(preload);

  // 매번 무작위로 고르되 방금 것과 같은 그림은 피한다.
  function pick() {
    var list = covers();
    var cover;
    do { cover = list[Math.floor(Math.random() * list.length)]; } while (list.length > 1 && cover.src === lastSrc);
    lastSrc = cover.src;
    return cover;
  }

  // 내 화면이 가려졌는지/돌아왔는지 페이지에 알린다. 페이지가 자기 연결로 서버에 전하고,
  // 서버는 가려진 동안 나를 기다리는 제한시간을 멈춘다(web/cover-pause.js).
  function announce(covered) {
    try { document.dispatchEvent(new CustomEvent('boss-cover-state', { detail: { covered: covered } })); } catch (error) { /* 알리지 못해도 화면은 그대로 */ }
  }

  function show() {
    if (overlay) return; // 이미 가려져 있다(남이 가린 신호가 겹쳐 와도 그대로)
    var cover = pick();
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
    // 폰에서 그림을 길게 누르면 뜨는 "이미지 저장" 메뉴·글자 선택을 막는다.
    s.setProperty('-webkit-touch-callout', 'none'); s.setProperty('-webkit-user-select', 'none'); s.userSelect = 'none';
    overlay.appendChild(img);
    // 가린 뒤에 누른 키·클릭이 뒤의 게임으로 새지 않게, 그림 위에서 전부 멈춘다.
    ['dblclick', 'mousedown', 'mouseup', 'wheel', 'touchstart'].forEach(function (type) {
      overlay.addEventListener(type, function (event) { event.stopPropagation(); if (type !== 'touchstart') event.preventDefault(); }, { passive: false });
    });
    // [모바일] 폰에는 우클릭도 Esc도 없어서, 남이 가린 화면을 풀 방법이 새로고침뿐이었다. 그동안
    // 게임은 그 사람을 기다렸다(포커·블랙잭·라이어는 차례마다 최대 3분, 더 마인드는 통째로 멈춤).
    // 손가락(펜)으로 한 번 누르면 돌아온다. 마우스 클릭으로는 그대로다(데스크톱은 우클릭·Esc).
    // 그림이 뜬 뒤 그림 위에서 시작한 누르기만 센다. 누르고 있던 중에 남이 가리면, 손을 떼는 순간의
    // click이 방금 뜬 그림에 맞아 곧바로 풀려 버렸다(상사 앞에서 이 사람 화면만 게임이 드러났다).
    var pressedHere = false;
    overlay.addEventListener('pointerdown', function (event) { pressedHere = event.pointerType === 'touch' || event.pointerType === 'pen'; });
    // 누르기의 마지막 이벤트(click)에서 걷는다. 먼저 걷으면 뒤따르는 click이 그림 밑의 버튼을 누른다.
    overlay.addEventListener('click', function (event) {
      event.stopPropagation();
      event.preventDefault();
      if (!pressedHere) return;
      hide();
      // 풀리는지 몰라 연달아 누른 손가락이 드러난 버튼(폴드·올인 등)을 누르지 않게 잠깐 흘려보낸다.
      swallowUntil = Date.now() + TAP_GUARD_MS;
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

  window.addEventListener('click', function (event) {
    if (Date.now() >= swallowUntil) return;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  // 캡처 단계에서 먼저 받는다. 참가자 줄처럼 자기 우클릭 기능이 있는 요소보다 앞서야 한다.
  window.addEventListener('contextmenu', function (event) {
    if (lastPointer === 'touch' || lastPointer === 'pen') {
      // 가린 그림을 길게 누른 것이면 "이미지 저장" 같은 메뉴만 막는다. 풀기는 한 번 누르기로 한다.
      if (overlay) event.preventDefault();
      return;
    }
    if (!overlay) {
      var target = event.target && event.target.closest ? event.target : null;
      var zone = target && target.closest('[data-keep-contextmenu]');
      if (zone && target.closest(zone.getAttribute('data-keep-contextmenu'))) return;
    }
    event.preventDefault();
    event.stopPropagation();
    toggle();
  }, true);

  // 내가 직접 누른 보스 키(우클릭·두 손가락 2초 누르기). 가려져 있으면 돌아오고, 아니면 가린다.
  function toggle() {
    if (overlay) { hide(); return; }
    show();
    // 다른 사람들 화면도 가리도록 각 페이지에 알린다(페이지가 자기 연결로 서버에 보낸다).
    try { document.dispatchEvent(new CustomEvent('boss-cover')); } catch (error) { /* 알림 실패해도 내 화면은 가려져 있다 */ }
  }

  // [요청] 폰: 두 손가락 2초 누르기. 터치 이벤트 대신 포인터 이벤트로 손가락을 센다 - 누르던 요소가
  // 그사이 다시 그려져(innerHTML) 문서에서 빠지면 touchend가 window까지 오지 않아 뗀 손가락을 놓쳤다.
  // 포인터는 그럴 때 손가락 아래 요소로 다시 전달된다. 스크롤을 막지 않도록 듣기만 한다.
  var fingers = {};       // 지금 닿아 있는 손가락: pointerId → { x, y, at }
  var fingerCount = 0;
  var holdTimer = null;
  var holdSpent = false;  // 이번에 닿은 손가락들로는 더 바꾸지 않는다(이미 바꿨거나 무효) - 모두 뗄 때까지

  function stopHold(spent) {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (spent) holdSpent = true;
  }
  function resetFingers() {
    stopHold(false);
    fingers = {};
    fingerCount = 0;
    holdSpent = false;
  }

  window.addEventListener('pointerdown', function (event) {
    if (event.pointerType !== 'touch') return;
    // 닿아 있던 손가락이 없을 때 닿은 첫 손가락이다. 앞에서 뗀 것을 놓쳤더라도 여기서 새로 센다.
    if (event.isPrimary) resetFingers();
    if (fingers[event.pointerId]) return;
    fingers[event.pointerId] = { x: event.clientX, y: event.clientY, at: Date.now() };
    fingerCount += 1;
    if (fingerCount !== 2) { stopHold(fingerCount > 2); return; } // 세 손가락 이상은 이번 동작 전체가 무효
    if (holdSpent) return;
    var first = Infinity;
    Object.keys(fingers).forEach(function (id) { first = Math.min(first, fingers[id].at); });
    if (Date.now() - first > LAND_MS) { holdSpent = true; return; } // 오래 대고 있던 엄지 + 새 손가락
    holdTimer = setTimeout(function () {
      holdTimer = null;
      holdSpent = true;
      toggle();
    }, HOLD_MS);
  }, true);
  window.addEventListener('pointermove', function (event) {
    if (!holdTimer || event.pointerType !== 'touch') return;
    var from = fingers[event.pointerId];
    if (from && Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) > HOLD_MOVE) stopHold(true);
  }, true);
  function lift(event) {
    if (event.pointerType !== 'touch' || !fingers[event.pointerId]) return;
    delete fingers[event.pointerId];
    fingerCount -= 1;
    stopHold(true); // 2초가 되기 전에 한 손가락이라도 떼면 이번 동작은 무효
    if (fingerCount <= 0) resetFingers();
  }
  window.addEventListener('pointerup', lift, true);
  window.addEventListener('pointercancel', lift, true); // 브라우저가 확대·스크롤로 가져가면 여기로 온다
  document.addEventListener('visibilitychange', resetFingers);

  // 가려진 동안에는 Esc만 받는다(돌아가기). 다른 키는 뒤의 게임으로 보내지 않는다.
  window.addEventListener('keydown', function (event) {
    if (!overlay) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.key === 'Escape') hide();
  }, true);
  window.bossCover = { show: show, isShown: function () { return !!overlay; } };
}());
