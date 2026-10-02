// 观测面截图夹具：各情形的卡片载荷（纯数据，无副作用）。
//
// 这些卡片必须能通过 @dshtrading/contract 的 validateCard —— 见 validate-fixtures.mjs。
// 字段 key 用观测面认识的读取约定（Domain/CardMapping.swift 的 RecognizedFieldKeys），
// 好让界面能真的显示出数；不认识的 key 会被原样放进 raw 列表。
//
// 注意：服务端目前**没有冻结 field.key**（契约缺口，已报 Lead），所以这里是夹具侧的约定。

function field(key, label, kind, value, extra) {
  const out = { key: key, label: label, kind: kind };
  if (value !== undefined && value !== null) out.value = String(value);
  if (extra && extra.unit) out.unit = extra.unit;
  if (extra && extra.values) out.values = extra.values;
  return out;
}

let seq = 0;

function card(cardType, fallbackText, fields, actions) {
  seq += 1;
  return {
    cardId: 'fx-' + String(seq),
    cardType: cardType,
    revision: 1,
    fallbackText: fallbackText,
    fields: fields,
    actions: actions || []
  };
}

export function resetIds() { seq = 0; }

function deskSummary(phase) {
  return card('desk-summary', '机器人 fx-desk 运行中', [
    field('deskId', 'Desk', 'text', 'fx-desk'),
    field('label', '机器人', 'text', '主力机器人'),
    field('phase', '阶段', 'text', phase)
  ]);
}

function riskState(level, alignment, symbol) {
  return card('risk-state', '风控档位 ' + level, [
    field('level', '风控档位', 'status', level),
    field('alignment', '价格对齐', 'status', alignment),
    field('symbol', '标的', 'symbol', symbol)
  ]);
}

function position() {
  return card('position', 'BTC/USDT 多 0.35', [
    field('symbol', '标的', 'symbol', 'BTC/USDT'),
    field('side', '方向', 'text', 'long'),
    field('quantity', '数量', 'number', '0.35'),
    field('entryPrice', '开仓均价', 'currency', '61250', { unit: 'USDT' }),
    field('pnl', '未实现盈亏', 'currency', '+412.50', { unit: 'USDT' })
  ]);
}

function order() {
  return card('order', 'BTC/USDT 限价买单 0.10', [
    field('symbol', '标的', 'symbol', 'BTC/USDT'),
    field('side', '方向', 'text', 'buy'),
    field('price', '价格', 'currency', '61000', { unit: 'USDT' }),
    field('quantity', '数量', 'number', '0.10'),
    field('filledQuantity', '已成交', 'number', '0.00'),
    field('state', '状态', 'status', 'submitted'),
    field('stateSinceMs', '状态自', 'timestamp', '1790925000000')
  ]);
}

function mandateStatus() {
  return card('mandate-status', '单日额度 1250 / 5000 USDT', [
    field('label', '额度', 'text', '单日名义额'),
    field('limit', '上限', 'currency', '5000', { unit: 'USDT' }),
    field('used', '已用', 'currency', '1250', { unit: 'USDT' }),
    field('currency', '币种', 'text', 'USDT')
  ]);
}

function freshness(age) {
  return card('freshness', '数据新鲜度 ' + age, [
    field('age', '新鲜度', 'status', age)
  ]);
}

function escalation() {
  return card('escalation', '已用额度达到 25%', [
    field('severity', '级别', 'severity', 'warning'),
    field('title', '标题', 'text', '额度使用接近提醒线'),
    field('reason', '原因', 'text', '单日已用 1250/5000 USDT'),
    field('impact', '影响', 'text', '仍可开新仓，但会继续累计')
  ], [
    { kind: 'ack', label: '确认', confirm: false }
  ]);
}

export function cardsFor(scenario) {
  resetIds();
  if (scenario === 'running') {
    return [deskSummary('running'), riskState('normal', 'aligned', 'BTC/USDT'), position(), order(), mandateStatus(), escalation(), freshness('fresh')];
  }
  if (scenario === 'restricted') {
    // 卡的核心区分：**还在运行**，但依赖异常、已禁止新增仓位。
    return [deskSummary('running'), riskState('reduce_only', 'aligned', 'BTC/USDT'), position(), order(), mandateStatus(), freshness('stale')];
  }
  if (scenario === 'stopped') {
    return [deskSummary('stopped'), riskState('halt', 'stale', 'BTC/USDT'), position(), mandateStatus(), freshness('aging')];
  }
  if (scenario === 'unknown-enum') {
    // fail-closed 的可视证据：未知卡片类型 + 未知动作。
    const future = card('future-card', '来自更新协议版本的卡片（本客户端只能显示兜底文本）', [
      field('whatever', '未知字段', 'text', '42')
    ]);
    const unknownAction = card('escalation', '含未知动作的升级', [
      field('severity', '级别', 'severity', 'critical'),
      field('title', '标题', 'text', '需要人在新客户端上处置')
    ], [
      { kind: 'future-action', label: '未来动作', confirm: true }
    ]);
    return [deskSummary('running'), riskState('normal', 'aligned', 'BTC/USDT'), future, unknownAction, freshness('fresh')];
  }
  // unreachable：服务器在连接层直接断开，不返回任何卡片。
  return [];
}
