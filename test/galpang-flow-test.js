'use strict';

/**
 * 갈팡질팡 입력·출력(명령어 해석기 + 세션 + 글자 출력 + 터미널 실행기).
 *
 *   [해석기] 대소문자·공백·쉼표·한글 명령·전각 숫자, 숫자가 아닌 입력, 번호 빠짐, 모르는 명령
 *   [흐름]   명세의 화면 그대로: 시작 화면, remove(여러 개·중복·이미 제거·범위 밖·글자·정답을 지우면 바로 끝), list/list all, guess(오답은 바로 끝·제거한
 *            후보), next, 5라운드 끝, 이긴 뒤/진 뒤에 허용되는 명령, history, help, quit 확인(y/n), restart
 *   [비공개] 게임 중 어떤 출력에도 정답·해설·디버그 줄이 없다. 끝나면 정답과 힌트 해설이 나온다
 *   [재현]   같은 seed면 같은 입력에 같은 출력이다. restart 뒤 게임도 마찬가지다
 *   [실행기] 실제 프로세스를 띄워 입력 줄을 흘려 넣는다(--seed, --debug, --help, 잘못된 옵션)
 *
 * 실행: node test/galpang-flow-test.js
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { parse, normalize } = require('../web/galpang/parser');
const { createSession } = require('../web/galpang/session');
const { GameEngine } = require('../web/galpang/engine');
const { STATUS } = require('../web/galpang/state');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 해석기 ──
{
  const CASES = [
    ['remove 3', { type: 'remove', numbers: [3] }],
    ['REMOVE   3', { type: 'remove', numbers: [3] }],
    ['  Remove 3  ', { type: 'remove', numbers: [3] }],
    ['remove 1 3 5 8', { type: 'remove', numbers: [1, 3, 5, 8] }],
    ['remove 1,3,5,8', { type: 'remove', numbers: [1, 3, 5, 8] }],
    ['remove 1, 3 ,5,  8', { type: 'remove', numbers: [1, 3, 5, 8] }],
    ['remove 3 3 3', { type: 'remove', numbers: [3, 3, 3] }],
    ['제거 3', { type: 'remove', numbers: [3] }],
    ['제거 1,3', { type: 'remove', numbers: [1, 3] }],
    ['remove ３,５', { type: 'remove', numbers: [3, 5] }], // 전각 숫자·쉼표
    ['guess 5', { type: 'guess', number: 5 }],
    ['정답 5', { type: 'guess', number: 5 }],
    ['GUESS 5', { type: 'guess', number: 5 }],
    ['list', { type: 'list', all: false }],
    ['후보', { type: 'list', all: false }],
    ['list all', { type: 'list', all: true }],
    ['LIST ALL', { type: 'list', all: true }],
    ['후보 전체', { type: 'list', all: true }],
    ['next', { type: 'next' }],
    ['다음', { type: 'next' }],
    ['history', { type: 'history' }],
    ['기록', { type: 'history' }],
    ['help', { type: 'help' }],
    ['도움말', { type: 'help' }],
    ['quit', { type: 'quit' }],
    ['종료', { type: 'quit' }],
    ['restart', { type: 'restart' }],
    ['재시작', { type: 'restart' }],
    ['', { type: 'empty' }],
    ['    ', { type: 'empty' }],
    ['\t\n', { type: 'empty' }],
    [',,,', { type: 'empty' }],
    ['abc', { type: 'error', code: 'UNKNOWN_COMMAND' }],
    ['removeall', { type: 'error', code: 'UNKNOWN_COMMAND' }],
    ['remove abc', { type: 'error', code: 'NOT_A_NUMBER', command: 'remove' }],
    ['remove 1 two', { type: 'error', code: 'NOT_A_NUMBER', command: 'remove' }],
    ['remove', { type: 'error', code: 'MISSING_ARGUMENT', command: 'remove' }],
    ['guess', { type: 'error', code: 'MISSING_ARGUMENT', command: 'guess' }],
    ['guess x', { type: 'error', code: 'NOT_A_NUMBER', command: 'guess' }],
    ['guess 1 2', { type: 'error', code: 'TOO_MANY_ARGUMENTS', command: 'guess' }],
    ['list foo', { type: 'error', code: 'UNEXPECTED_ARGUMENT', command: 'list' }],
    ['next 3', { type: 'error', code: 'UNEXPECTED_ARGUMENT', command: 'next' }],
    ['quit now', { type: 'error', code: 'UNEXPECTED_ARGUMENT', command: 'quit' }],
  ];
  const wrong = CASES.filter(([input, expected]) => !same(parse(input), expected));
  check(`해석기: 입력 ${CASES.length}가지가 모두 기대대로 읽힌다`, wrong.length === 0, wrong.map(([i]) => JSON.stringify(i) + ' → ' + JSON.stringify(parse(i))).join(' / '));
  // 숫자 모양이지만 후보 번호가 될 수 없는 것도 해석기는 숫자로 넘기고, 범위는 엔진이 정한다.
  check('해석기: 0·음수·소수·아주 큰 수는 숫자로 읽어 엔진에 넘긴다(범위 판단은 엔진 몫)', same(parse('remove 0 -1 3.5 99999999999999999999').numbers, [0, -1, 3.5, 1e20]));
  check('해석기: 어떤 입력에도 예외를 던지지 않는다', [null, undefined, 5, {}, [], 'a'.repeat(100000), '\u0000\u0001', '😀'.repeat(50), 'remove ' + '9 '.repeat(5000)].every((v) => { try { parse(v); return true; } catch { return false; } }));
  check('정규화: 쉼표·공백·대소문자·전각', normalize('  ReMoVe ３,５ , ６ ') === 'remove 3 5 6');
}

// ── 흐름 ──
const run = (session, input) => session.handleLine(input).lines.join('\n');
// 정답 후보를 지우면 게임이 끝나므로, 아래 흐름이 지우는 번호(1·2·3·5·8)에 정답이 없는 판을 쓴다.
// seed를 올려 가며 찾으므로 데이터가 바뀌어 정답이 달라져도 시험이 깨지지 않는다.
const seedAvoiding = (ids, from) => {
  for (let candidate = from; ; candidate += 1) if (!ids.includes(new GameEngine({ seed: candidate }).state.answer.id)) return candidate;
};
const SEED = seedAvoiding([1, 2, 3, 5, 8], 100);
{
  const s = createSession({ seed: SEED });
  const intro = s.intro().join('\n');
  check('시작 화면: 제목·안내·최대 라운드', intro.includes('갈팡질팡') && intro.includes('16개의 후보 중 숨겨진 정답을 찾아주세요.') && intro.includes('최대 라운드: 5'));
  check('시작 화면: 후보 16개가 "번호. 이름"으로 나온다', Array.from({ length: 16 }, (_, i) => new RegExp(`^${i + 1}\\. \\S`, 'm').test(intro)).every(Boolean));
  check('시작 화면: [ROUND 1]과 A·B 선택지와 "힌트: A|B"가 나온다', /\[ROUND 1\]\n\nA\. .+\nB\. .+\n\n힌트: [AB]/.test(intro));
  check('시작 화면: 명령어 목록이 나온다', ['list', 'remove <번호>', 'guess <번호>', 'next', 'history', 'help', 'quit'].every((c) => intro.includes(`\n${c}`)));
  check('시작 화면에 정답·해설·디버그 줄이 없다', !/정답:|\[DEBUG\]|판단했습니다|\[힌트 해설\]/.test(intro));

  check('remove 3 → "3번 제거"', run(s, 'remove 3') === '3번 제거');
  check('remove 1,3,5,8 → 이미 제거한 3은 알리고 나머지는 제거', run(s, 'remove 1,3,5,8') === '1번 제거\n5번 제거\n8번 제거\n3번 후보는 이미 제거되었습니다.');
  check('이미 제거한 후보를 다시 제거해도 남은 후보는 그대로다', (() => { const before = run(s, 'list'); run(s, 'remove 3'); return run(s, 'list') === before; })());
  check('remove 20 → 안내문', run(s, 'remove 20') === '잘못된 후보 번호입니다.\n1~16 사이의 번호를 입력해주세요.');
  check('remove 0 / remove 17 / remove -3 도 같은 안내문', ['remove 0', 'remove 17', 'remove -3', 'remove 2.5'].every((c) => run(s, c) === '잘못된 후보 번호입니다.\n1~16 사이의 번호를 입력해주세요.'));
  check('remove abc → 숫자 안내', run(s, 'remove abc') === '후보 번호는 숫자로 입력해주세요.');
  check('범위 밖이 섞인 remove는 아무것도 지우지 않는다', (() => { const before = run(s, 'list'); run(s, 'remove 2 99'); return run(s, 'list') === before; })());
  const list = run(s, 'list');
  check('list: [남은 후보]에 제거한 후보(1·3·5·8)가 없다', list.startsWith('[남은 후보]\n\n') && !/^(1|3|5|8)\. /m.test(list) && /^2\. /m.test(list) && /^16\. /m.test(list));
  const all = run(s, 'list all');
  check('list all: 전체 16개, 제거한 것에 [제거됨]', all.startsWith('[전체 후보]') && (all.match(/\[제거됨\]/g) || []).length === 4 && /^3\. .+ \[제거됨\]$/m.test(all) && (all.match(/^\d+\. /gm) || []).length === 16);
  check('"후보" 명령은 list와 같다', run(s, '후보') === run(s, 'list'));
  check('제거한 후보를 guess하면 판정하지 않는다', run(s, 'guess 3') === '3번 후보는 이미 제거한 후보입니다.' && s.engine.status === STATUS.PLAYING);
  check('guess 20 → 범위 안내', run(s, 'guess 20') === '잘못된 후보 번호입니다.\n1~16 사이의 번호를 입력해주세요.');
  check('제거한 후보나 범위 밖 번호를 내도 게임은 계속되고 라운드도 그대로다', s.engine.status === STATUS.PLAYING && run(s, 'history').split('ROUND').length === 2);
  const next = run(s, 'next');
  check('next → 새 라운드와 힌트', /^-{32}\n\n\[ROUND 2\]\n\nA\. .+\nB\. .+\n\n힌트: [AB]$/.test(next), next);
  check('라운드가 바뀌어도 제거한 후보는 그대로다', !/^(1|3|5|8)\. /m.test(run(s, 'list')));
  check('history: 지금까지 공개된 힌트만, 해설 없이', (() => { const h = run(s, 'history'); return h.startsWith('[힌트 기록]') && h.includes('ROUND 1') && h.includes('ROUND 2') && !h.includes('ROUND 3') && /→ [AB]/.test(h) && !h.includes('판단했습니다'); })());
  check('help: 명령어 도움말', run(s, 'help').startsWith('사용 가능한 명령어\n\nlist\n현재 남아 있는 후보 확인') && run(s, 'help').includes('quit\n게임 종료'));
  check('모르는 명령어 안내', run(s, 'abc') === '알 수 없는 명령어입니다.\n\nhelp 를 입력하면 명령어 목록을 확인할 수 있습니다.');
  check('빈 입력은 아무것도 하지 않는다(상태·출력 없음)', (() => { const before = JSON.stringify(s.view()); const r = s.handleLine(''); return r.lines.length === 0 && !r.exit && JSON.stringify(s.view()) === before; })());
  check('진행 중에 restart는 받지 않는다', run(s, 'restart').includes('진행 중인 게임이 있습니다.') && s.engine.status === STATUS.PLAYING);

  // 게임 중에는 어떤 출력에도 정답·해설이 없다.
  const answer = s.engine.state.answer;
  const everything = [intro, list, all, next, run(s, 'history'), run(s, 'help'), run(s, 'abc'), run(s, 'remove 2')].join('\n');
  check('게임 중 출력에 "정답:"·해설·디버그가 없다', !/정답:|판단했습니다|\[힌트 해설\]|\[DEBUG\]/.test(everything));
  const finalWin = s.handleLine(`guess ${answer.id}`);
  const text = finalWin.lines.join('\n');
  check('정답: 축하·정답 이름·몇 라운드 만에', text.includes('정답입니다!') && text.includes(`정답: ${answer.name}`) && text.includes('2라운드 만에 성공했습니다.'), text.slice(0, 200));
  check('정답: [힌트 해설]에 공개된 힌트(1~2라운드)의 선택과 해설이 있다', text.includes('[힌트 해설]') && /ROUND 1\nA\. .+\nB\. .+\n선택: [AB]\n\n.+판단했습니다\./.test(text) && text.includes('ROUND 2') && !text.includes('ROUND 3'));
  check('이긴 뒤 상태는 WON이다', s.engine.status === STATUS.WON);
  check('이긴 뒤에는 restart·history·quit만 받는다(그 밖은 종료 안내)', ['remove 1', 'guess 1', 'next', 'list', 'help', 'abc'].every((c) => run(s, c) === '게임이 종료되었습니다.\n\nrestart 를 입력하면 새 게임을 시작할 수 있습니다.'));
  check('이긴 뒤에도 history는 볼 수 있다', run(s, 'history').startsWith('[힌트 기록]'));
  const restarted = s.handleLine('restart');
  check('restart: 새 게임 시작 화면이 나오고 PLAYING이다', restarted.lines.join('\n').includes('갈팡질팡') && s.engine.status === STATUS.PLAYING && s.engine.round === 1 && !restarted.exit);
  check('restart한 게임은 후보가 모두 살아 있다', run(s, 'list all').indexOf('[제거됨]') === -1);
}

// ── 오답은 한 번이면 끝 ──
{
  const GAME_OVER = '게임이 종료되었습니다.\n\nrestart 를 입력하면 새 게임을 시작할 수 있습니다.';
  const wrongOf = (session) => session.engine.state.candidates.find((c) => c.id !== session.engine.state.answer.id && !c.removed);
  const s = createSession({ seed: 31 });
  const wrong = wrongOf(s);
  const answer = s.engine.state.answer;
  const text = run(s, `guess ${wrong.id}`);
  check('오답이면 "오답입니다." 제목과 함께 그 자리에서 게임이 끝난다', text.startsWith(`${'='.repeat(32)}\n오답입니다.\n${'='.repeat(32)}`) && s.engine.status === STATUS.LOST && s.engine.round === 1, text.slice(0, 90));
  check('오답: 낸 답과 정답이 나온다', text.includes(`제출한 답: ${wrong.id}번 ${wrong.name}`) && text.includes(`정답: ${answer.name}`));
  check('오답: 몇 라운드에서 끝났는지와, 지금까지 공개된 힌트(1개)의 해설만 나온다', text.includes('1라운드에서 끝났습니다.') && text.includes('[힌트 해설]') && text.includes('ROUND 1')
    && !text.includes('ROUND 2') && (text.match(/판단했습니다\./g) || []).length === 1);
  check('오답 뒤에는 restart·history·quit만 받는다(같은 답을 또 내거나 next를 눌러도 종료 안내)', ['guess 1', `guess ${wrong.id}`, 'next', 'remove 1', 'list', 'help'].every((c) => run(s, c) === GAME_OVER));
  check('오답으로 끝난 뒤에도 history는 볼 수 있다', run(s, 'history').startsWith('[힌트 기록]'));
  const again = s.handleLine('restart');
  check('오답으로 끝난 뒤 restart하면 새 게임이다(제거·오답 표시 없음)', again.lines.join('\n').includes('갈팡질팡') && s.engine.status === STATUS.PLAYING && s.engine.round === 1
    && s.engine.state.wrongGuesses.length === 0 && !run(s, 'list all').includes('[제거됨]'));

  // 3라운드에서 틀리면 3라운드에서 끝나고 해설은 힌트 3개다.
  const t = createSession({ seed: 32 });
  run(t, 'next'); run(t, 'next');
  const w3 = wrongOf(t);
  const out3 = run(t, `guess ${w3.id}`);
  check('3라운드에서 틀리면 3라운드에서 끝나고 해설은 힌트 3개다', out3.includes('3라운드에서 끝났습니다.') && (out3.match(/판단했습니다\./g) || []).length === 3 && t.engine.round === 3, out3.slice(0, 120));

  // 정답 후보를 지우면 그 자리에서 끝난다.
  const u = createSession({ seed: 33 });
  const gone = u.engine.state.answer;
  const spare = [1, 2, 3].find((id) => id !== gone.id);
  const beforeLines = run(u, `remove ${spare}`);
  check('정답이 아닌 후보를 지우면 "N번 제거"만 나오고 게임은 이어진다', beforeLines === `${spare}번 제거` && u.engine.status === STATUS.PLAYING);
  const removedText = run(u, `remove ${gone.id}`);
  check('정답 후보를 지우면 "N번 제거"에 이어 "정답 후보를 지웠습니다." 제목으로 게임이 끝난다', removedText.startsWith(`${gone.id}번 제거\n\n${'='.repeat(32)}\n정답 후보를 지웠습니다.\n${'='.repeat(32)}`) && u.engine.status === STATUS.LOST && u.engine.round === 1, removedText.slice(0, 120));
  check('정답 후보를 지운 결과: 정답(번호·이름)과 1라운드에서 끝났다는 것, 공개된 힌트(1개)의 해설이 나온다', removedText.includes(`정답: ${gone.id}번 ${gone.name}`) && removedText.includes('1라운드에서 끝났습니다.')
    && removedText.includes('[힌트 해설]') && (removedText.match(/판단했습니다\./g) || []).length === 1 && !removedText.includes('제출한 답'));
  check('정답을 지워서 끝난 뒤에는 종료 안내만 나온다(정답을 낼 수도 없다)', [`guess ${gone.id}`, 'next', 'remove 1', 'list'].every((c) => run(u, c) === GAME_OVER));
  const lines = run(createSession({ seed: 33 }), `remove ${Array.from({ length: 16 }, (_, i) => i + 1).join(' ')}`);
  check('후보 16개를 한꺼번에 다 지워도 그 자리에서 끝나고 정답이 공개된다(안 끝나고 멈춰 있지 않는다)', lines.includes('16번 제거') && lines.includes('정답 후보를 지웠습니다.') && lines.includes('정답: '), lines.slice(-200));
  const w = createSession({ seed: 33 });
  const word = w.engine.state.answer;
  const spare2 = [1, 2].find((id) => id !== word.id);
  const mixed = run(w, `remove ${spare2},${word.id}`);
  check('여럿을 지우다 정답이 섞여 있으면 같이 지운 것도 "N번 제거"로 나오고 게임은 끝난다', mixed.startsWith(`${spare2}번 제거\n${word.id}번 제거\n`) && w.engine.status === STATUS.LOST);
  check('범위 밖이 섞이면 정답이 들어 있어도 아무것도 지우지 않고 안내만 한다(게임도 그대로)', (() => { const t = createSession({ seed: 33 }); return run(t, `remove ${t.engine.state.answer.id} 99`) === '잘못된 후보 번호입니다.\n1~16 사이의 번호를 입력해주세요.' && t.engine.status === STATUS.PLAYING; })());

  // 5라운드가 다 지나서 지는 문구는 그대로다("5라운드 안에 정답을 맞히지 못했습니다").
  const v = createSession({ seed: 34 });
  for (let i = 0; i < 4; i += 1) run(v, 'next');
  const lostText = run(v, 'next');
  check('5라운드가 지나서 지면 "게임 종료" 제목과 "5라운드 안에 정답을 맞히지 못했습니다."가 나온다(오답 안내와 다르다)', lostText.includes('게임 종료') && lostText.includes('5라운드 안에 정답을 맞히지 못했습니다.') && !lostText.includes('오답입니다.') && !lostText.includes('제출한 답'));
}

// ── 5라운드 끝 ──
{
  const s = createSession({ seed: 21 });
  const outputs = [];
  for (let i = 0; i < 4; i += 1) outputs.push(run(s, 'next'));
  check('ROUND 5까지 가면 [ROUND 5] 힌트가 나온다', /\[ROUND 5\]/.test(outputs[3]) && s.engine.round === 5 && s.engine.status === STATUS.PLAYING);
  const answer = s.engine.state.answer;
  const lost = run(s, 'next');
  check('ROUND 5에서 next → 게임 종료·정답 공개', lost.includes('게임 종료') && lost.includes('5라운드 안에 정답을 맞히지 못했습니다.') && lost.includes(`정답: ${answer.name}`) && s.engine.status === STATUS.LOST, lost.slice(0, 160));
  check('졌을 때 5개 힌트 해설이 모두 나온다', [1, 2, 3, 4, 5].every((n) => lost.includes(`ROUND ${n}\nA. `)) && (lost.match(/판단했습니다\./g) || []).length === 5);
  check('진 뒤에도 종료 안내·history·restart가 같다', run(s, 'guess 1').startsWith('게임이 종료되었습니다.') && run(s, 'history').includes('ROUND 5') && s.handleLine('restart').lines.length > 0);
}

// ── quit ──
{
  const s = createSession({ seed: 22 });
  const ask = s.handleLine('quit');
  check('quit: 종료 확인을 묻고 아직 끝나지 않는다', ask.lines.join('\n') === '게임을 종료하시겠습니까? (y/n)' && !ask.exit && s.engine.status === STATUS.PLAYING && s.pendingQuit);
  const no = s.handleLine('n');
  check('quit → n: 게임을 계속한다', no.lines.join('\n') === '게임을 계속합니다.' && !no.exit && s.engine.status === STATUS.PLAYING && !s.pendingQuit);
  s.handleLine('quit');
  const odd = s.handleLine('글쎄');
  check('quit 확인 중 y/n이 아닌 입력은 다시 묻는다', odd.lines.join('\n').includes('y 또는 n') && s.pendingQuit && !odd.exit);
  const yes = s.handleLine('Y');
  check('quit → y(대문자도): QUIT 상태로 끝나고 종료한다', yes.exit && s.engine.status === STATUS.QUIT && yes.lines.join('\n').startsWith('게임을 종료합니다.'));
  check('포기한 게임은 정답을 공개하지 않는다', s.engine.summary() === null && !yes.lines.join('\n').includes('정답:'));
  check('종료 확인에 한글 답(예/아니오)도 받는다', (() => { const t = createSession({ seed: 23 }); t.handleLine('종료'); const a = t.handleLine('아니오'); t.handleLine('quit'); const b = t.handleLine('예'); return !a.exit && b.exit; })());
  const done = createSession({ seed: 24 });
  done.handleLine(`guess ${done.engine.state.answer.id}`);
  check('끝난 게임에서 quit는 확인 없이 바로 종료한다', done.handleLine('quit').exit);
  check('quit를 확인하는 동안 다른 명령은 명령으로 읽히지 않는다(실수로 next가 나가지 않는다)', (() => { const t = createSession({ seed: 25 }); t.handleLine('quit'); t.handleLine('next'); return t.engine.round === 1 && t.pendingQuit; })());
}

// ── 재현 ──
{
  const script = ['remove 1 2 3', 'list', 'next', 'guess 3', 'history', 'next', 'next', 'next', 'next', 'restart', 'remove 5', 'next', 'help'];
  const play = (seed) => { const s = createSession({ seed }); return [s.intro().join('\n'), ...script.map((line) => s.handleLine(line).lines.join('\n'))].join('\n--\n'); };
  check('같은 seed면 같은 입력에 대한 출력이 통째로 같다(restart 뒤 게임까지)', play(100) === play(100));
  check('seed가 다르면 출력이 다르다', play(100) !== play(101));
  const a = createSession({ seed: 100 });
  const b = createSession({ seed: 100 });
  a.handleLine(`guess ${a.engine.state.answer.id}`); b.handleLine(`guess ${b.engine.state.answer.id}`);
  a.handleLine('restart'); b.handleLine('restart');
  check('restart 뒤 게임도 같은 seed 계열이라 같다', a.engine.state.answer.name === b.engine.state.answer.name && a.engine.seed === '100#1');
}

// ── 디버그 ──
{
  const quiet = createSession({ seed: 100 });
  check('debug가 아니면 시작 화면과 명령 출력에 DEBUG 줄이 없다', !quiet.intro().join('\n').includes('[DEBUG]') && !run(quiet, 'next').includes('[DEBUG]'));
  const loud = createSession({ seed: 100, debug: true });
  const intro = loud.intro().join('\n');
  check('debug면 seed·정답·힌트 계획·상태 전이가 나온다', intro.includes('[DEBUG] seed = 100') && intro.includes(`[DEBUG] answer = ${loud.engine.state.answer.id}. ${loud.engine.state.answer.name}`)
    && (intro.match(/\[DEBUG\] ROUND \d/g) || []).length === 5 && intro.includes('INIT → PLAYING'));
  check('debug면 상태가 바뀔 때 전이가 한 줄 나온다', run(loud, `guess ${loud.engine.state.answer.id}`).includes('[DEBUG] state: PLAYING → WON'));
  const loud2 = createSession({ seed: 100, debug: true });
  loud2.intro(); // 시작 화면에서 처음 상태까지 보여 준 뒤의 바뀜만 한 줄로 나온다
  const wrongLoud = loud2.engine.state.candidates.find((c) => c.id !== loud2.engine.state.answer.id).id;
  check('debug: 오답으로 끝나도 전이가 한 줄 나온다(PLAYING → LOST)', run(loud2, `guess ${wrongLoud}`).includes('[DEBUG] state: PLAYING → LOST'));
  const loud3 = createSession({ seed: 100, debug: true });
  loud3.intro();
  check('debug: 정답을 지워서 끝나도 전이가 한 줄 나온다(PLAYING → LOST)', run(loud3, `remove ${loud3.engine.state.answer.id}`).includes('[DEBUG] state: PLAYING → LOST'));
}

// ── 터미널 실행기 ──
{
  const cli = path.join(__dirname, '..', 'web', 'galpang', 'cli.js');
  const exec = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', timeout: 20000 });
  const probe = createSession({ seed: 100 });
  const answerId = probe.engine.state.answer.id;
  const wrongId = probe.engine.state.candidates.find((c) => c.id !== answerId).id;
  const result = exec(['--seed', '100'], `remove 20\nremove abc\nnext\nguess ${answerId}\nquit\n`);
  check('실행기: 정상 종료(코드 0)', result.status === 0, `${result.status} ${result.stderr}`);
  check('실행기: 시작 화면·잘못된 입력·다음 라운드·정답·해설이 순서대로 나온다', (() => {
    const out = result.stdout;
    const at = ['갈팡질팡', '잘못된 후보 번호입니다.', '후보 번호는 숫자로 입력해주세요.', '[ROUND 2]', '정답입니다!', '[힌트 해설]', '게임을 종료합니다.'].map((t) => out.indexOf(t));
    return at.every((n) => n >= 0) && at.every((n, i) => i === 0 || n > at[i - 1]);
  })(), result.stdout.slice(0, 300));
  const lostRun = exec(['--seed', '100'], `guess ${wrongId}\nnext\nquit\n`);
  check('실행기: 오답을 내면 바로 끝나고 정답이 공개되며, 이어지는 입력은 종료 안내만 받는다', lostRun.status === 0 && lostRun.stdout.includes('오답입니다.') && lostRun.stdout.includes(`정답: ${probe.engine.state.answer.name}`)
    && !lostRun.stdout.includes('[ROUND 2]') && lostRun.stdout.includes('게임이 종료되었습니다.') && lostRun.stdout.includes('게임을 종료합니다.'), lostRun.stdout.slice(-300));
  const removeRun = exec(['--seed', '100'], `remove ${answerId}\nnext\nquit\n`);
  check('실행기: 정답 후보를 지우면 바로 끝나고 정답이 공개되며, 이어지는 입력은 종료 안내만 받는다', removeRun.status === 0 && removeRun.stdout.includes('정답 후보를 지웠습니다.') && removeRun.stdout.includes(`정답: ${answerId}번 ${probe.engine.state.answer.name}`)
    && !removeRun.stdout.includes('[ROUND 2]') && removeRun.stdout.includes('게임이 종료되었습니다.'), removeRun.stdout.slice(-300));
  check('실행기: 일반 실행에는 정답이 게임 중에 나오지 않는다', !/\[DEBUG\]/.test(result.stdout) && result.stdout.indexOf('정답:') > result.stdout.indexOf('정답입니다!') - 5);
  check('실행기: 끝낸 뒤 남은 입력은 처리하지 않는다', !exec(['--seed', '100'], 'quit\ny\nhelp\n').stdout.includes('사용 가능한 명령어'));
  const same2 = exec(['--seed', '100'], 'next\nnext\nhistory\n').stdout === exec(['--seed', '100'], 'next\nnext\nhistory\n').stdout;
  check('실행기: --seed 100은 두 번 실행해도 출력이 같다', same2);
  check('실행기: seed를 주지 않으면 실행마다 다른 게임이다', new Set([exec([], 'quit\ny\n').stdout, exec([], 'quit\ny\n').stdout, exec([], 'quit\ny\n').stdout]).size > 1);
  const debug = exec(['--seed', '100', '--debug'], 'quit\ny\n');
  check('실행기: --debug는 정답과 힌트 계획을 보여 준다', debug.stdout.includes(`[DEBUG] answer = ${answerId}. ${probe.engine.state.answer.name}`) && debug.stdout.includes('[DEBUG] seed = 100'));
  const eof = exec(['--seed', '100'], 'next\n');
  check('실행기: 입력이 끝나면(EOF) 오류 없이 끝난다', eof.status === 0 && eof.stderr === '');
  check('실행기: --help는 사용법을 보여 주고 0으로 끝난다', (() => { const h = exec(['--help'], ''); return h.status === 0 && h.stdout.includes('사용법') && h.stdout.includes('--seed'); })());
  const bad = exec(['--nope'], '');
  check('실행기: 모르는 옵션은 안내하고 2로 끝난다', bad.status === 2 && bad.stdout.includes('알 수 없는 옵션'));
  const missing = exec(['--seed'], '');
  check('실행기: --seed에 값이 없으면 안내하고 2로 끝난다', missing.status === 2 && missing.stdout.includes('--seed'));
  const text = exec(['--seed', 'abc'], 'quit\ny\n');
  check('실행기: 숫자가 아닌 seed(문자열)도 받는다', text.status === 0 && text.stdout.includes('갈팡질팡'));
}

console.log(`\n갈팡질팡 입력·출력: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
