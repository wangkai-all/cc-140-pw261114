// 页面装配：导入、渲染、交互、情景推算。
import { parseCsv } from './csv.js';
import { fmtInTz, fmtUtc, fmtDelay, MIN } from './time.js';
import {
  buildModel, applyScenario, clearScenario, impactedPassengers,
  LegStatus, ConnStatus,
} from './core.js';

const state = {
  raw: { airports: null, plan: null, actuals: null, connectionTables: [] },
  model: null,
  airport: null,
  date: null,
  dir: 'dep',
  selectedLegId: null,
  scenario: null,       // 情景参数
  scenarioResult: null, // 推算结果
};

const $ = sel => document.querySelector(sel);

// ---------- 数据导入 ----------

document.querySelectorAll('.file-btn input[type="file"]').forEach(input => {
  input.addEventListener('change', async e => {
    const kind = input.dataset.kind;
    const files = [...e.target.files];
    if (!files.length) return;
    if (kind === 'connections') {
      for (const f of files) state.raw.connectionTables.push(parseCsv(await f.text()));
    } else {
      state.raw[kind] = parseCsv(await files[0].text());
    }
    input.closest('.file-btn').classList.add('loaded');
    tryRebuild();
  });
});

$('#load-sample').addEventListener('click', async () => {
  const files = ['airports.csv', 'plan.csv', 'actuals.csv', 'connections.csv', 'connections_extra.csv'];
  const texts = await Promise.all(files.map(f => fetch(`samples/${f}`).then(r => {
    if (!r.ok) throw new Error(`无法加载 samples/${f}（请通过 HTTP 服务访问页面）`);
    return r.text();
  })));
  state.raw.airports = parseCsv(texts[0]);
  state.raw.plan = parseCsv(texts[1]);
  state.raw.actuals = parseCsv(texts[2]);
  state.raw.connectionTables = [parseCsv(texts[3]), parseCsv(texts[4])];
  document.querySelectorAll('.file-btn').forEach(b => b.classList.add('loaded'));
  tryRebuild();
});

function tryRebuild() {
  const { airports, plan, actuals, connectionTables } = state.raw;
  if (!airports || !plan) {
    $('#import-status').textContent = '至少需要机场/时区表与航班计划表';
    return;
  }
  state.model = buildModel({
    airports,
    plan,
    actuals: actuals || [],
    connectionTables,
  });
  state.scenario = null;
  state.scenarioResult = null;
  state.selectedLegId = null;
  const m = state.model;
  if (!state.airport || !m.airports.has(state.airport)) {
    state.airport = m.legs[0] ? m.legs[0].dep : null;
  }
  if (!state.date || !m.dates.includes(state.date)) {
    state.date = m.dates[0] || null;
  }
  $('#import-status').textContent =
    `已导入 ${m.legs.length} 个航段、${m.connections.length} 条联程（${m.groupSize.size} 个旅客组）、${m.anomalies.length} 条异常`;
  render();
}

// ---------- 展示辅助 ----------

const legStatusMeta = leg => {
  if (leg.status === LegStatus.CANCELLED) return { cls: 'critical', text: '已取消' };
  if (leg.anomalies.length) return { cls: 'critical', text: '时间矛盾' };
  if (leg.status === LegStatus.MISSING_ARR) return { cls: 'serious', text: '缺实际到达' };
  if (leg.status === LegStatus.MISSING_DEP) return { cls: 'serious', text: '缺实际起飞' };
  if (leg.status === LegStatus.NO_ACTUAL) return { cls: 'muted', text: '无实际记录' };
  if (leg.depDelayMin != null && leg.depDelayMin > 15) return { cls: 'warn', text: '延误' };
  return { cls: 'good', text: '正常' };
};

const connStatusMeta = {
  [ConnStatus.OK]: { cls: 'good', text: '正常' },
  [ConnStatus.AT_RISK]: { cls: 'warn', text: '衔接紧张' },
  [ConnStatus.MISSED]: { cls: 'critical', text: '错失衔接' },
  [ConnStatus.BROKEN_CANCEL]: { cls: 'critical', text: '航班取消' },
  [ConnStatus.UNKNOWN]: { cls: 'muted', text: '无法判断' },
};

const badge = (cls, text) => `<span class="badge ${cls}">${text}</span>`;

function timeCell(utcMs, tz) {
  if (utcMs == null) return '<span class="utc">—</span>';
  const s = fmtInTz(utcMs, tz);
  return `${s.slice(11)}<br><span class="utc">${s.slice(0, 10)} · UTC ${fmtUtc(utcMs).slice(11)}</span>`;
}

function projOf(legId) {
  return state.scenarioResult ? state.scenarioResult.projTimes.get(legId) : null;
}

// ---------- 渲染 ----------

function render() {
  const m = state.model;
  if (!m) return;
  renderControls();
  renderKpis();
  renderLegsTable();
  renderDetail();
  renderConnections();
  renderAnomalies();
  renderScenarioBanner();
}

function renderControls() {
  const m = state.model;
  $('#sel-airport').innerHTML = [...m.airports.values()]
    .map(a => `<option value="${a.code}" ${a.code === state.airport ? 'selected' : ''}>${a.code} ${a.name}</option>`).join('');
  $('#sel-date').innerHTML = m.dates
    .map(d => `<option ${d === state.date ? 'selected' : ''}>${d}</option>`).join('');
  $('#sel-dir').value = state.dir;
}

$('#sel-airport').addEventListener('change', e => { state.airport = e.target.value; state.selectedLegId = null; render(); });
$('#sel-date').addEventListener('change', e => { state.date = e.target.value; state.selectedLegId = null; render(); });
$('#sel-dir').addEventListener('change', e => { state.dir = e.target.value; render(); });

function visibleLegs() {
  const m = state.model;
  const airport = m.airports.get(state.airport);
  return m.legs.filter(leg => {
    if (state.dir === 'dep') return leg.dep === state.airport && leg.date === state.date;
    // 进港：按到达机场当地日期过滤（跨午夜时到达日可能不同于出发日）
    if (leg.arr !== state.airport) return false;
    return fmtInTz(leg.schedArrUtc, airport.tz).slice(0, 10) === state.date;
  }).sort((a, b) => a.schedDepUtc - b.schedDepUtc);
}

function renderKpis() {
  const legs = visibleLegs();
  const delayed = legs.filter(l => l.depDelayMin != null && l.depDelayMin > 15);
  const maxDelay = legs.reduce((mx, l) => Math.max(mx, l.depDelayMin ?? -Infinity), -Infinity);
  const impacted = impactedPassengers(state.model, [ConnStatus.AT_RISK, ConnStatus.MISSED, ConnStatus.BROKEN_CANCEL]);
  const tiles = [
    { label: '航段数', value: legs.length, hint: `${state.airport} ${state.dir === 'dep' ? '出港' : '进港'} · ${state.date}` },
    { label: '延误 >15 分钟', value: delayed.length, hint: '按实际离港' },
    { label: '最大离港延误', value: maxDelay === -Infinity ? '—' : fmtDelay(maxDelay), hint: '分钟' },
    { label: '受影响联程', value: `${impacted.groups} 组`, hint: `${impacted.passengers} 名旅客（已去重）` },
    { label: '待核对异常', value: state.model.anomalies.length, hint: '见下方异常面板' },
  ];
  $('#kpi-strip').innerHTML = tiles.map(t =>
    `<div class="kpi"><div class="label">${t.label}</div><div class="value">${t.value}</div><div class="hint">${t.hint}</div></div>`).join('');
}

function renderLegsTable() {
  const m = state.model;
  $('#legs-title').textContent = `航段 — ${state.airport} ${state.dir === 'dep' ? '出港' : '进港'} ${state.date}`;
  const rows = visibleLegs().map(leg => {
    const depA = m.airports.get(leg.dep);
    const arrA = m.airports.get(leg.arr);
    const st = legStatusMeta(leg);
    const proj = projOf(leg.id);
    const swap = leg.tailActual && leg.tailActual !== leg.tailPlanned;
    const tailHtml = swap
      ? `<span class="swap" title="换机：计划 ${leg.tailPlanned}">${leg.tailActual}⟲</span>`
      : (leg.tailUsed || '—');
    const depShown = proj ? proj.depUtc : leg.actualDepUtc;
    const arrShown = proj ? proj.arrUtc : leg.actualArrUtc;
    const projTag = proj ? ' <span class="tag">推算</span>' : '';
    const split = (leg.propagatedMin == null && leg.newDelayMin == null)
      ? '<span class="utc">未知</span>'
      : `${fmtDelay(leg.newDelayMin)} / ${fmtDelay(leg.propagatedMin)}`;
    return `<tr data-leg="${leg.id}" class="${leg.id === state.selectedLegId ? 'selected' : ''} ${proj ? 'projected' : ''}">
      <td>${leg.flight}</td>
      <td>${leg.dep}→${leg.arr}</td>
      <td>${timeCell(leg.schedDepUtc, depA.tz)}</td>
      <td>${timeCell(depShown, depA.tz)}${projTag}</td>
      <td>${timeCell(leg.schedArrUtc, arrA.tz)}</td>
      <td>${timeCell(arrShown, arrA.tz)}${projTag}</td>
      <td>${tailHtml}</td>
      <td class="num">${leg.depDelayMin == null ? '<span class="utc">未知</span>' : fmtDelay(leg.depDelayMin)}</td>
      <td class="num">${split}</td>
      <td>${badge(st.cls, st.text)}</td>
    </tr>`;
  });
  $('#legs-table tbody').innerHTML = rows.join('') ||
    '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">该机场/日期无航段</td></tr>';
  document.querySelectorAll('#legs-table tbody tr[data-leg]').forEach(tr => {
    tr.addEventListener('click', () => {
      state.selectedLegId = tr.dataset.leg;
      renderLegsTable();
      renderDetail();
    });
  });
}

function renderDetail() {
  const m = state.model;
  const box = $('#detail');
  const leg = state.selectedLegId ? m.legByKey.get(state.selectedLegId) : null;
  if (!leg) {
    box.innerHTML = '<div class="detail-empty">点击左侧航段查看前序飞机、后续航段与联程影响</div>';
    return;
  }
  const depA = m.airports.get(leg.dep);
  const arrA = m.airports.get(leg.arr);
  const st = legStatusMeta(leg);
  const swap = leg.tailActual && leg.tailActual !== leg.tailPlanned;

  const chain = m.chains.get(leg.chainTail) || [];
  const idx = leg.chainIndex ?? -1;
  const chainHtml = [];
  const pushLeg = (l, current) => {
    const s = legStatusMeta(l);
    chainHtml.push(`<div class="chain-leg ${current ? 'current' : ''}" data-leg="${l.id}">
      <span class="fl">${l.flight}</span> ${l.dep}→${l.arr}
      <span class="utc">${fmtInTz(l.schedDepUtc, m.airports.get(l.dep).tz).slice(5)} 离</span>
      ${badge(s.cls, s.text)}
      ${l.id !== leg.id && projOf(l.id) ? '<span class="tag">推算受影响</span>' : ''}
    </div>`);
  };
  const pushTurn = (from, to) => {
    const minTurn = m.airports.get(to.dep).minTurn;
    const t = to.turnFromPrevMin;
    const txt = t == null ? `周转未知（要求 ≥${minTurn}′）` : `周转 ${Math.round(t)}′（要求 ≥${minTurn}′）`;
    chainHtml.push(`<div class="chain-turn ${t != null && t < minTurn ? 'bad' : ''}">↓ ${txt} @${to.dep}</div>`);
  };
  for (let i = Math.max(0, idx - 2); i < Math.min(chain.length, idx + 4); i++) {
    if (i > Math.max(0, idx - 2)) pushTurn(chain[i - 1], chain[i]);
    pushLeg(chain[i], i === idx);
  }

  const conns = m.connections.filter(c => c.fromLegId === leg.id || c.toLegId === leg.id);
  const connHtml = conns.length ? conns.map(c => {
    const meta = connStatusMeta[c.status];
    const role = c.fromLegId === leg.id ? '本段为前段' : '本段为后段';
    return `<li>${badge(meta.cls, meta.text)} ${c.group}（${m.groupSize.get(c.group)}人，${role}）
      可用 ${c.availMin == null ? '—' : Math.round(c.availMin)}′ / 最短 ${c.mctMin}′
      ${c.basis === 'projected' ? '<span class="tag">推算</span>' : ''}</li>`;
  }).join('') : '<li style="color:var(--text-muted)">无关联联程</li>';

  box.innerHTML = `
    <dl class="kv">
      <dt>航班</dt><dd><strong>${leg.flight}</strong> ${leg.date} ${leg.dep}→${leg.arr} ${badge(st.cls, st.text)}</dd>
      <dt>机尾号</dt><dd>${swap
        ? `<span class="swap">${leg.tailActual}（换机，计划 ${leg.tailPlanned}）</span>`
        : (leg.tailUsed || '—')}</dd>
      <dt>计划离港</dt><dd>${fmtInTz(leg.schedDepUtc, depA.tz)} 本地 · ${fmtUtc(leg.schedDepUtc)} UTC</dd>
      <dt>实际离港</dt><dd>${leg.actualDepUtc != null ? `${fmtInTz(leg.actualDepUtc, depA.tz)} 本地 · ${fmtUtc(leg.actualDepUtc)} UTC` : '—'}</dd>
      <dt>计划到港</dt><dd>${fmtInTz(leg.schedArrUtc, arrA.tz)} 本地 · ${fmtUtc(leg.schedArrUtc)} UTC</dd>
      <dt>实际到港</dt><dd>${leg.actualArrUtc != null ? `${fmtInTz(leg.actualArrUtc, arrA.tz)} 本地 · ${fmtUtc(leg.actualArrUtc)} UTC` : '缺实际到达，延误未知'}</dd>
      <dt>离港延误</dt><dd>${leg.depDelayMin == null ? '未知' : `${fmtDelay(leg.depDelayMin)} 分钟`}</dd>
      <dt>新增 / 带入</dt><dd>${leg.newDelayMin == null ? '未知（前段实际到达缺失）'
        : `${fmtDelay(leg.newDelayMin)} / ${fmtDelay(leg.propagatedMin)} 分钟`}</dd>
      <dt>到港延误</dt><dd>${leg.arrDelayMin == null ? '未知' : `${fmtDelay(leg.arrDelayMin)} 分钟`}</dd>
      ${leg.anomalies.length ? `<dt>异常</dt><dd>${leg.anomalies.map(a => `⚠ ${a}`).join('<br>')}</dd>` : ''}
    </dl>
    <h3 style="font-size:13px;margin:12px 0 6px">飞机链（${leg.chainTail || '无机尾'}，按实际航段顺序）</h3>
    <div class="chain">${chainHtml.join('')}</div>
    <h3 style="font-size:13px;margin:12px 0 6px">关联联程</h3>
    <ul class="anomaly-list">${connHtml}</ul>
    <h3 style="font-size:13px;margin:12px 0 6px">情景调整</h3>
    <div class="scenario-form">
      <label>本段起飞
        <input type="number" id="sc-dep-delta" value="30" step="5" style="width:70px"> 分钟
      </label>
      <button id="apply-dep-scenario">向后推算</button>
    </div>
    <div class="scenario-form">
      <label>${leg.dep} 最小周转
        <input type="number" id="sc-turn" value="${depA.minTurn}" min="0" step="5" style="width:70px"> 分钟
      </label>
      <button id="apply-turn-scenario">应用周转要求</button>
    </div>`;

  box.querySelectorAll('.chain-leg').forEach(el => {
    el.addEventListener('click', () => {
      state.selectedLegId = el.dataset.leg;
      renderLegsTable();
      renderDetail();
    });
  });
  box.querySelector('#apply-dep-scenario').addEventListener('click', () => {
    const delta = Number(box.querySelector('#sc-dep-delta').value);
    if (!Number.isFinite(delta)) return;
    state.scenario = { type: 'dep', legId: leg.id, deltaMin: delta };
    runScenario();
  });
  box.querySelector('#apply-turn-scenario').addEventListener('click', () => {
    const minTurn = Number(box.querySelector('#sc-turn').value);
    if (!Number.isFinite(minTurn) || minTurn < 0) return;
    state.scenario = { type: 'turn', airport: leg.dep, minTurn };
    runScenario();
  });
}

function runScenario() {
  state.scenarioResult = applyScenario(state.model, state.scenario);
  render();
}

$('#clear-scenario').addEventListener('click', () => {
  state.scenario = null;
  state.scenarioResult = null;
  clearScenario(state.model);
  render();
});

function renderScenarioBanner() {
  const banner = $('#scenario-banner');
  if (!state.scenario || !state.scenarioResult) {
    banner.classList.remove('active');
    return;
  }
  const s = state.scenario;
  const desc = s.type === 'dep'
    ? `${s.legId.replace('|', ' ')} 起飞 ${s.deltaMin >= 0 ? '+' : ''}${s.deltaMin} 分钟`
    : `${s.airport} 最小周转调整为 ${s.minTurn} 分钟`;
  const n = state.scenarioResult.affectedLegIds.length;
  $('#scenario-desc').textContent = `${desc} —— 向后影响 ${n} 个航段（蓝色标记为推算值，实际记录保持不变）`;
  banner.classList.add('active');
}

function renderConnections() {
  const m = state.model;
  const impacted = impactedPassengers(m, [ConnStatus.AT_RISK, ConnStatus.MISSED, ConnStatus.BROKEN_CANCEL]);
  $('#conn-summary').innerHTML =
    `共 ${m.groupSize.size} 个旅客组；当前 <strong>${impacted.groups}</strong> 组 / <strong>${impacted.passengers}</strong> 名旅客衔接受影响（同一组跨多份关联表只计一次）`;
  const order = { [ConnStatus.MISSED]: 0, [ConnStatus.BROKEN_CANCEL]: 1, [ConnStatus.AT_RISK]: 2, [ConnStatus.UNKNOWN]: 3, [ConnStatus.OK]: 4 };
  const rows = [...m.connections].sort((a, b) => order[a.status] - order[b.status]).map(c => {
    const meta = connStatusMeta[c.status];
    const from = m.legByKey.get(c.fromLegId);
    const to = m.legByKey.get(c.toLegId);
    return `<tr>
      <td>${c.group}</td>
      <td class="num">${m.groupSize.get(c.group)}</td>
      <td>${from.flight} ${from.dep}→${from.arr}</td>
      <td>${to.flight} ${to.dep}→${to.arr}</td>
      <td>${c.airport}</td>
      <td class="num">${c.availMin == null ? '—' : `${Math.round(c.availMin)}′ / ${c.mctMin}′`}</td>
      <td>${badge(meta.cls, meta.text)}</td>
      <td>${c.basis === 'projected' ? '<span class="tag">推算</span>' : c.basis === 'actual' ? '<span class="tag">实际</span>' : '<span class="tag">实际+计划</span>'}</td>
    </tr>`;
  });
  $('#conn-table tbody').innerHTML = rows.join('') ||
    '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">未导入联程关系</td></tr>';
}

function renderAnomalies() {
  const list = state.model.anomalies;
  $('#anomaly-list').innerHTML = list.length
    ? list.map(a => `<li>⚠ <span>${a.message}</span></li>`).join('')
    : '<li style="color:var(--text-muted)">无异常</li>';
}
