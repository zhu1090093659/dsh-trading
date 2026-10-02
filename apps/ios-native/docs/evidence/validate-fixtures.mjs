// 夹具卡片必须通过**冻结契约**的校验（TS 契约是唯一权威）。
//
// 一条实测出来的契约事实（cards.ts 注释与代码不一致，已报 Lead）：
//   未知 closed 枚举值时 validateCard 返回 **valid=false**（problems 非空），
//   而不只是 operable=false —— 但注释写的是"valid 仍可为 true"。
//   因此 unknown-enum 情形里那两张卡**本来就应当 valid=false**，
//   这也是"未知枚举 fail-closed"最直接的证据。
//
// 运行：node --experimental-strip-types validate-fixtures.mjs

import { validateCard } from '../../../../packages/contract/src/cards.ts';
import { cardsFor } from './fixture-cards.mjs';

const expectations = {
  running: { cards: 7, expectClean: true },
  restricted: { cards: 6, expectClean: true },
  stopped: { cards: 5, expectClean: true },
  unreachable: { cards: 0, expectClean: true },
  'unknown-enum': { cards: 5, expectClean: false }
};

function hasUnknownClosedEnum(card) {
  if (!['desk-summary', 'risk-state', 'decision', 'trigger-trace', 'position', 'order', 'mandate-status', 'escalation', 'journal-gap', 'freshness', 'control-panel', 'system-notice'].includes(card.cardType)) {
    return true;
  }
  const knownActions = ['ack', 'dismiss', 'open-detail', 'retry-sync', 'approve', 'reject', 'pause', 'resume', 'kill', 'flatten', 'grant-control', 'revoke-device'];
  return card.actions.some(function (action) { return !knownActions.includes(action.kind); });
}

let problems = 0;
for (const scenario of Object.keys(expectations)) {
  const cards = cardsFor(scenario);
  const expected = expectations[scenario];
  if (cards.length !== expected.cards) {
    console.log('FAIL ' + scenario + ': 卡片数 ' + String(cards.length) + ' != ' + String(expected.cards));
    problems += 1;
  }
  for (const card of cards) {
    const verdict = validateCard(card);
    const dirty = hasUnknownClosedEnum(card);
    if (expected.expectClean && dirty) {
      console.log('FAIL ' + scenario + ' ' + card.cardId + ' 含未知闭枚举，测试夹具本身不该有');
      problems += 1;
      continue;
    }
    if (dirty) {
      // 期望：fail-closed —— 既不是"合法卡"，也不能操作
      if (verdict.valid || verdict.operable) {
        console.log('FAIL ' + scenario + ' ' + card.cardId + ' 含未知枚举却 valid=' + String(verdict.valid) + ' operable=' + String(verdict.operable));
        problems += 1;
      }
      continue;
    }
    if (!verdict.valid || !verdict.operable) {
      console.log('FAIL ' + scenario + ' ' + card.cardId + ' (' + card.cardType + ') 应当合法且可操作: ' + verdict.problems.join('; '));
      problems += 1;
    }
  }
  console.log('ok   ' + scenario + ': ' + String(cards.length) + ' cards');
}

console.log(problems === 0 ? 'ALL FIXTURE CARDS BEHAVE AS THE FROZEN CONTRACT SAYS' : String(problems) + ' PROBLEM(S)');
process.exit(problems === 0 ? 0 : 1);
