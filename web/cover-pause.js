'use strict';

/**
 * [보스 키] 화면을 가린 동안 제한시간을 멈춘다.
 *
 * 보스 키를 누르면 접속한 모든 사람의 화면이 함께 가려진다(public/cover.js). 그런데
 * 제한시간은 그대로 흘러서, 가려 둔 사이에 차례가 온 사람은 30초 뒤 자동 폴드·자동
 * 스탠드되었고, 라이어 게임에서는 설명 차례를 넘기거나 정답 시간을 놓쳤다. 화면을 가린
 * 것은 잠깐 자리를 피한 것이지 포기한 게 아니다.
 *
 * 규칙
 *   - 지금 돌고 있는 제한시간이 기다리는 사람(누구인지는 방이 정한다: 포커·블랙잭은
 *     차례인 사람, 라이어는 단계마다 다르다) 중 한 명이라도 화면을 가리고 있으면 멈춘다.
 *     기다릴 필요가 없는 사람이 가린 것은 게임을 멈추지 않는다.
 *   - 모두 돌아오면 멈췄던 자리(남은 시간)부터 다시 흐른다. 처음부터 다시 주지 않는다.
 *   - 제한시간 하나(한 차례·한 단계)는 모두 합쳐 MAX_PAUSE_MS까지만 멈춘다. 가린 채
 *     자리를 비워도 게임이 영영 멈추지 않게 하려는 것이다. 사람이 아니라 제한시간에 붙인
 *     한도라서, 가렸다 풀었다를 되풀이해도 늘어나지 않는다. 다음 차례는 새로 받는다.
 *   - 연결이 끊기거나 방을 나가면 가린 상태도 지운다(방이 forget을 부른다).
 *
 * 방마다 제한시간은 한 번에 하나다(포커·블랙잭의 차례, 라이어의 단계). 그래서 타이머도
 * 하나(timer)만 둔다. 타이머는 방이 주입한 setTimer/clearTimer/now로만 다룬다 - 라이어 방
 * 테스트가 가짜 시계를 쓰기 때문이다.
 */
const MAX_PAUSE_MS = 3 * 60 * 1000;

/**
 * @param options.isWaitingOn (playerId) => 지금 제한시간이 이 사람을 기다리고 있는가
 * @param options.onExpire 멈출 수 있는 시간을 다 썼을 때. 방은 여기서 상태를 다시
 *        맞추고(sync) 모두에게 알린다.
 * @param options.unref true면 타이머가 프로세스를 붙잡지 않게 한다(카드 방이 원래 그렇게 쓴다).
 */
function createCoverPause(options) {
  const setTimer = options.setTimer;
  const clearTimer = options.clearTimer;
  const now = options.now || (() => Date.now());
  const isWaitingOn = options.isWaitingOn;
  const onExpire = options.onExpire || (() => {});
  const maxPauseMs = Number.isFinite(options.maxPauseMs) ? options.maxPauseMs : MAX_PAUSE_MS;
  const hold = (handle) => { if (options.unref && handle && handle.unref) handle.unref(); return handle; };

  const covered = new Set(); // 화면을 가리고 있는 사람
  let pausedAt = null;       // 멈춘 시각. 멈춰 있지 않으면 null
  let used = 0;              // 지금 제한시간이 이미 멈춰 있었던 시간(지금 멈춤은 빼고)
  let exhausted = false;     // 지금 제한시간은 멈출 수 있는 만큼 다 멈췄다
  let expiryTimer = null;

  // 제한시간 타이머의 상태
  let handle = null;
  let fn = null;
  let deadline = null;
  let remaining = null;

  function arm(ms) {
    deadline = now() + ms;
    remaining = null;
    handle = hold(setTimer(() => {
      const run = fn;
      handle = null; fn = null; deadline = null;
      if (run) run();
    }, ms));
  }
  function freeze() {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
    remaining = Math.max(0, deadline - now());
    deadline = null;
  }
  function thaw() {
    if (fn && handle === null && remaining !== null) arm(remaining);
  }
  function clearExpiry() {
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
  }
  function scheduleExpiry() {
    clearExpiry();
    expiryTimer = hold(setTimer(() => { expiryTimer = null; exhausted = true; onExpire(); }, Math.max(0, maxPauseMs - used)));
  }

  /**
   * 멈춤 여부를 지금 상태에 맞춘다. 방은 상태를 알리기 직전마다 부른다 - 차례가 넘어가
   * 기다리는 사람이 바뀌는 것도 여기서 한꺼번에 반영된다.
   * @returns 막 멈췄으면 { paused: [멈추게 한 사람들] }, 막 풀렸으면
   *          { resumedAfterMs, expired }, 그대로면 null
   */
  function sync() {
    const holders = exhausted ? [] : [...covered].filter((id) => isWaitingOn(id));
    if (holders.length && pausedAt === null) {
      pausedAt = now();
      freeze();
      scheduleExpiry();
      return { paused: holders };
    }
    if (!holders.length && pausedAt !== null) {
      const resumedAfterMs = now() - pausedAt;
      used += resumedAfterMs;
      pausedAt = null;
      clearExpiry();
      thaw();
      return { resumedAfterMs, expired: exhausted };
    }
    return null;
  }

  /**
   * 멈출 수 있는 제한시간 타이머. 멈춰 있는 동안 start하면(가린 사람에게 차례가 막
   * 넘어온 경우) 시간을 재지 않고 기다렸다가, 풀리는 순간부터 온전한 시간을 잰다.
   */
  const timer = {
    start(callback, ms) {
      timer.clear();
      fn = callback;
      // 새 제한시간(다음 차례·다음 단계)은 멈출 수 있는 시간도 새로 받는다.
      used = 0;
      exhausted = false;
      if (pausedAt !== null) {
        pausedAt = now();
        scheduleExpiry();
        remaining = ms;
      } else arm(ms);
    },
    clear() {
      if (handle !== null) clearTimer(handle);
      handle = null; fn = null; deadline = null; remaining = null;
    },
    /**
     * 끝나는 시각. 멈춰 있으면 "멈춘 시각 + 남은 시간"이다 - 화면은 멈춘 시각을
     * 지금으로 보고 세므로(방 상태의 pausedAt) 남은 시간이 그대로 멈춰 보인다.
     */
    endsAt() {
      if (!fn) return null;
      return pausedAt !== null ? pausedAt + remaining : deadline;
    },
  };

  /** 방이 비어 새 방이 될 때. 가린 사람도 멈춤도 모두 잊는다. */
  function reset() {
    covered.clear();
    clearExpiry();
    timer.clear();
    pausedAt = null; used = 0; exhausted = false;
  }

  return {
    set: (id, value) => { if (value) covered.add(id); else covered.delete(id); },
    forget: (id) => covered.delete(id),
    sync,
    timer,
    reset,
    dispose: reset,
    pausedAt: () => pausedAt,
  };
}

module.exports = { createCoverPause, MAX_PAUSE_MS };
