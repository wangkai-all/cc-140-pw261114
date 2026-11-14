// 核心模型：航段解析、飞机链、延误拆分、联程风险、情景推算。
// 纯函数，不依赖 DOM；浏览器与 Node 通用。

import { localToUtc, MIN, DAY } from './time.js';

const MAX_BLOCK_H = 20; // 航段时长超过该值视为时间矛盾

export const LegStatus = {
  OK: 'OK',
  CANCELLED: 'CANCELLED',
  NO_ACTUAL: 'NO_ACTUAL',       // 无任何实际记录
  MISSING_ARR: 'MISSING_ARR',   // 有实际起飞、缺实际到达 —— 不能当准点
  MISSING_DEP: 'MISSING_DEP',   // 有实际到达、缺实际起飞
};

export const ConnStatus = {
  OK: 'OK',
  AT_RISK: 'AT_RISK',           // 衔接时间低于 MCT
  MISSED: 'MISSED',             // 衔接时间为负（前段未到后段已走）
  BROKEN_CANCEL: 'BROKEN_CANCEL', // 相关航班取消
  UNKNOWN: 'UNKNOWN',           // 缺少可判断的时刻
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 到达时刻落在出发日期之后：到达时间若早于出发时间则逐日顺延。 */
function resolveArrUtc(dateStr, arrTime, arrTz, depAnchorUtc) {
  let arr = localToUtc(dateStr, arrTime, arrTz);
  while (arr < depAnchorUtc) arr += DAY;
  return arr;
}

/**
 * 构建运行模型。
 * @param {object} input
 *   airports: [{code,name,timezone,min_turnaround_min,min_connection_min}]
 *   plan:     [{flight,date,dep,arr,sched_dep,sched_arr,tail,status}]
 *   actuals:  [{flight,date,actual_dep,actual_arr,tail}]
 *   connectionTables: [[{group,from_flight,to_flight,date,to_date,passengers}], ...]
 *     —— 支持导入多份联程表；同一旅客组跨表出现只计一次人数。
 */
export function buildModel(input) {
  const airports = new Map();
  for (const a of input.airports) {
    airports.set(a.code, {
      code: a.code,
      name: a.name || a.code,
      tz: a.timezone,
      minTurn: num(a.min_turnaround_min) ?? 45,
      mct: num(a.min_connection_min) ?? 60,
    });
  }

  const anomalies = [];
  const legs = [];
  const legByKey = new Map(); // flight|date -> leg（同航班同日多段时按下标区分）

  // ---- 1. 计划 + 实际 合并为航段 ----
  const actualByKey = new Map();
  for (const r of input.actuals) {
    const k = `${r.flight}|${r.date}`;
    if (actualByKey.has(k)) {
      anomalies.push({ type: 'DUPLICATE_ACTUAL', message: `实际记录重复：${r.flight} ${r.date}，已采用首条` });
      continue;
    }
    actualByKey.set(k, r);
  }

  for (const p of input.plan) {
    const depA = airports.get(p.dep);
    const arrA = airports.get(p.arr);
    if (!depA || !arrA) {
      anomalies.push({ type: 'UNKNOWN_AIRPORT', message: `未知机场：${p.flight} ${p.dep}→${p.arr}，该段已跳过` });
      continue;
    }
    const key = `${p.flight}|${p.date}`;
    const act = actualByKey.get(key) || null;
    const id = key;
    if (legByKey.has(id)) {
      anomalies.push({ type: 'DUPLICATE_PLAN', message: `计划重复：${key}，已采用首条` });
      continue;
    }

    const leg = {
      id,
      flight: p.flight,
      date: p.date,
      dep: p.dep,
      arr: p.arr,
      tailPlanned: p.tail || '',
      tailActual: act && act.tail ? act.tail : null,
      status: LegStatus.OK,
      anomalies: [],
      schedDepUtc: null, schedArrUtc: null,
      actualDepUtc: null, actualArrUtc: null,
    };

    // 计划时刻
    leg.schedDepUtc = localToUtc(p.date, p.sched_dep, depA.tz);
    leg.schedArrUtc = resolveArrUtc(p.date, p.sched_arr, arrA.tz, leg.schedDepUtc);
    const schedBlockH = (leg.schedArrUtc - leg.schedDepUtc) / (60 * MIN);
    if (schedBlockH <= 0 || schedBlockH > MAX_BLOCK_H) {
      leg.anomalies.push(`计划时间矛盾：${p.sched_dep}→${p.sched_arr} 航段时长异常`);
    }

    if ((p.status || '').toUpperCase() === 'CANCELLED') {
      leg.status = LegStatus.CANCELLED;
    } else if (act) {
      if (act.actual_dep) leg.actualDepUtc = localToUtc(p.date, act.actual_dep, depA.tz);
      if (act.actual_arr) {
        // 跨午夜：以实际起飞（无则计划起飞）为锚点逐日顺延，不能只比钟点
        const anchor = leg.actualDepUtc ?? leg.schedDepUtc;
        leg.actualArrUtc = resolveArrUtc(p.date, act.actual_arr, arrA.tz, anchor);
      }
      if (leg.actualDepUtc != null && leg.actualArrUtc != null) {
        const blockH = (leg.actualArrUtc - leg.actualDepUtc) / (60 * MIN);
        if (blockH <= 0 || blockH > MAX_BLOCK_H) {
          leg.anomalies.push(
            `时间矛盾：实际到达早于或远超实际起飞（航段时长 ${blockH.toFixed(1)}h），请核对日期`
          );
        }
      }
      if (!act.actual_dep && !act.actual_arr) leg.status = LegStatus.NO_ACTUAL;
      else if (!act.actual_arr) leg.status = LegStatus.MISSING_ARR;
      else if (!act.actual_dep) leg.status = LegStatus.MISSING_DEP;
    } else {
      leg.status = LegStatus.NO_ACTUAL;
    }

    leg.tailUsed = leg.tailActual || leg.tailPlanned;
    legs.push(leg);
    legByKey.set(id, leg);
  }

  // 实际记录找不到对应计划
  for (const [k] of actualByKey) {
    if (!legByKey.has(k)) {
      anomalies.push({ type: 'ORPHAN_ACTUAL', message: `实际记录无对应计划：${k}` });
    }
  }

  // ---- 2. 飞机链：按真实机尾号（换机后自动重新关联） ----
  const chains = new Map(); // tail -> [leg]
  for (const leg of legs) {
    if (leg.status === LegStatus.CANCELLED) continue;
    if (!leg.tailUsed) continue;
    if (!chains.has(leg.tailUsed)) chains.set(leg.tailUsed, []);
    chains.get(leg.tailUsed).push(leg);
  }
  for (const [, chain] of chains) {
    chain.sort((a, b) => (a.actualDepUtc ?? a.schedDepUtc) - (b.actualDepUtc ?? b.schedDepUtc));
  }

  // ---- 3. 延误拆分：本段新增 vs 前段带入 ----
  for (const [tail, chain] of chains) {
    for (let i = 0; i < chain.length; i++) {
      const leg = chain[i];
      leg.chainTail = tail;
      leg.chainIndex = i;
      leg.prevLegId = i > 0 ? chain[i - 1].id : null;

      leg.depDelayMin = leg.actualDepUtc != null ? (leg.actualDepUtc - leg.schedDepUtc) / MIN : null;
      leg.arrDelayMin = leg.actualArrUtc != null ? (leg.actualArrUtc - leg.schedArrUtc) / MIN : null;

      leg.turnFromPrevMin = null;
      leg.propagatedMin = null;
      leg.newDelayMin = null;

      if (i > 0) {
        const prev = chain[i - 1];
        const minTurn = airports.get(leg.dep).minTurn;
        if (prev.actualArrUtc != null && leg.actualDepUtc != null) {
          leg.turnFromPrevMin = (leg.actualDepUtc - prev.actualArrUtc) / MIN;
          if (leg.turnFromPrevMin < 0) {
            leg.anomalies.push(
              `时间矛盾：本段实际起飞早于前段 ${prev.flight} 实际到达（负周转 ${Math.round(leg.turnFromPrevMin)} 分钟）`
            );
          }
        }
        if (leg.depDelayMin != null && leg.depDelayMin > 0) {
          if (prev.actualArrUtc != null) {
            // 前段晚到在扣除最小周转后仍挤压本段计划起飞的部分 = 带入延误
            const forced = (prev.actualArrUtc + minTurn * MIN - leg.schedDepUtc) / MIN;
            leg.propagatedMin = Math.min(leg.depDelayMin, Math.max(0, forced));
            leg.newDelayMin = leg.depDelayMin - leg.propagatedMin;
          }
          // 前段实际到达缺失时无法拆分，保持 null，界面显示"未知"而非当作本段新增
        } else if (leg.depDelayMin != null) {
          leg.propagatedMin = 0;
          leg.newDelayMin = 0;
        }
      } else if (leg.depDelayMin != null && leg.depDelayMin > 0) {
        leg.propagatedMin = 0; // 当日首段，延误均为本段新增
        leg.newDelayMin = leg.depDelayMin;
      }
    }
  }

  // 航段级异常汇总到全局列表
  for (const leg of legs) {
    for (const msg of leg.anomalies) {
      anomalies.push({ type: 'LEG', legId: leg.id, message: `${leg.flight} ${leg.date}：${msg}` });
    }
    if (leg.status === LegStatus.MISSING_ARR) {
      anomalies.push({
        type: 'MISSING_ARR', legId: leg.id,
        message: `${leg.flight} ${leg.date}：缺实际到达时刻，延误未知（不得按准点处理）`,
      });
    }
  }

  // ---- 4. 联程：旅客组去重 + MCT 判断 ----
  const groupSize = new Map(); // group -> passengers（首见为准）
  const connections = [];
  const connTables = input.connectionTables || [];
  connTables.forEach((table, tableIdx) => {
    for (const c of table) {
      const size = num(c.passengers) ?? 0;
      if (groupSize.has(c.group)) {
        if (groupSize.get(c.group) !== size) {
          anomalies.push({
            type: 'GROUP_SIZE_CONFLICT',
            message: `旅客组 ${c.group} 人数不一致（${groupSize.get(c.group)} / ${size}），按首见人数计且全组只计一次`,
          });
        }
      } else {
        groupSize.set(c.group, size);
      }

      const fromLeg = legByKey.get(`${c.from_flight}|${c.date}`);
      let toLeg = null;
      if (c.to_date) {
        toLeg = legByKey.get(`${c.to_flight}|${c.to_date}`);
      } else if (fromLeg) {
        // 未给后段日期：取前段计划到达之后最近的一班同航班号
        let best = null;
        for (const cand of legs) {
          if (cand.flight !== c.to_flight) continue;
          if (cand.schedDepUtc >= fromLeg.schedArrUtc - 6 * 60 * MIN) {
            if (!best || cand.schedDepUtc < best.schedDepUtc) best = cand;
          }
        }
        toLeg = best;
      }
      if (!fromLeg || !toLeg) {
        anomalies.push({
          type: 'CONN_UNRESOLVED',
          message: `联程无法匹配航段：${c.group} ${c.from_flight}→${c.to_flight}（${c.date}）`,
        });
        continue;
      }
      if (fromLeg.arr !== toLeg.dep) {
        anomalies.push({
          type: 'CONN_AIRPORT_MISMATCH',
          message: `联程机场不一致：${c.group} ${c.from_flight} 到达 ${fromLeg.arr}，${c.to_flight} 自 ${toLeg.dep} 起飞`,
        });
      }
      connections.push({
        id: `${c.group}|${fromLeg.id}|${toLeg.id}|${tableIdx}`,
        group: c.group,
        fromLegId: fromLeg.id,
        toLegId: toLeg.id,
        airport: fromLeg.arr,
        tableIdx,
      });
    }
  });

  const model = {
    airports, legs, legByKey, chains, connections, groupSize, anomalies,
    dates: [...new Set(legs.map(l => l.date))].sort(),
  };
  evaluateConnections(model, null);
  return model;
}

/** 用已知时刻（实际优先，否则计划；scenario 存在时用推算值）评估全部联程。 */
export function evaluateConnections(model, scenario) {
  const timeOf = (leg, kind) => {
    if (scenario) {
      const proj = scenario.projTimes.get(leg.id);
      if (proj) return kind === 'dep' ? proj.depUtc : proj.arrUtc;
    }
    if (kind === 'dep') return leg.actualDepUtc ?? leg.schedDepUtc;
    return leg.actualArrUtc ?? leg.schedArrUtc;
  };

  for (const conn of model.connections) {
    const fromLeg = model.legByKey.get(conn.fromLegId);
    const toLeg = model.legByKey.get(conn.toLegId);
    const mct = model.airports.get(conn.airport).mct;
    conn.mctMin = mct;

    if (fromLeg.status === LegStatus.CANCELLED || toLeg.status === LegStatus.CANCELLED) {
      conn.status = ConnStatus.BROKEN_CANCEL;
      conn.availMin = null;
      conn.basis = 'actual';
      continue;
    }
    const arrUtc = timeOf(fromLeg, 'arr');
    const depUtc = timeOf(toLeg, 'dep');
    if (arrUtc == null || depUtc == null) {
      conn.status = ConnStatus.UNKNOWN;
      conn.availMin = null;
      conn.basis = 'actual';
      continue;
    }
    conn.availMin = (depUtc - arrUtc) / MIN;
    conn.basis = scenario && (scenario.projTimes.has(fromLeg.id) || scenario.projTimes.has(toLeg.id))
      ? 'projected' : (fromLeg.actualArrUtc != null && toLeg.actualDepUtc != null ? 'actual' : 'mixed');
    if (conn.availMin < 0) conn.status = ConnStatus.MISSED;
    else if (conn.availMin < mct) conn.status = ConnStatus.AT_RISK;
    else conn.status = ConnStatus.OK;
  }
}

/**
 * 情景推算：向后计算受影响范围。
 * scenario 二选一：
 *   { type: 'dep',  legId, deltaMin }            —— 把某段起飞推迟 deltaMin 分钟
 *   { type: 'turn', airport, minTurn }           —— 修改某机场最小周转要求
 * 返回 { projTimes: Map(legId -> {depUtc, arrUtc, projected}), affectedLegIds, connIds }
 * 有实际记录的航段保持实际值（被直接调整的航段除外），推算值单独标注。
 */
export function applyScenario(model, scenario) {
  const projTimes = new Map();
  const minTurnOf = code =>
    scenario.type === 'turn' && scenario.airport === code
      ? scenario.minTurn
      : model.airports.get(code).minTurn;

  for (const [tail, chain] of model.chains) {
    let prevProjArr = null;
    for (const leg of chain) {
      const blockMs = (leg.actualDepUtc != null && leg.actualArrUtc != null)
        ? leg.actualArrUtc - leg.actualDepUtc
        : leg.schedArrUtc - leg.schedDepUtc;

      const isAdjusted = scenario.type === 'dep' && scenario.legId === leg.id;
      let depUtc;
      let projected = false;
      if (isAdjusted) {
        depUtc = (leg.actualDepUtc ?? leg.schedDepUtc) + scenario.deltaMin * MIN;
        projected = true;
      } else if (leg.actualDepUtc != null) {
        depUtc = leg.actualDepUtc; // 实际记录优先，不覆盖
      } else {
        const earliest = prevProjArr != null ? prevProjArr + minTurnOf(leg.dep) * MIN : -Infinity;
        const proj = Math.max(leg.schedDepUtc, earliest);
        depUtc = proj;
        projected = proj !== leg.schedDepUtc;
      }

      let arrUtc;
      if (!projected && leg.actualArrUtc != null) {
        arrUtc = leg.actualArrUtc;
      } else {
        arrUtc = depUtc + blockMs;
        projected = true;
      }

      if (projected) projTimes.set(leg.id, { depUtc, arrUtc, projected: true });
      prevProjArr = arrUtc;
    }
  }

  const affectedLegIds = [];
  for (const [legId, proj] of projTimes) {
    const leg = model.legByKey.get(legId);
    const baseDep = leg.actualDepUtc ?? leg.schedDepUtc;
    const baseArr = leg.actualArrUtc ?? leg.schedArrUtc;
    if (Math.abs(proj.depUtc - baseDep) >= MIN || Math.abs(proj.arrUtc - baseArr) >= MIN) {
      affectedLegIds.push(legId);
    }
  }

  const before = new Map(model.connections.map(c => [c.id, c.status]));
  const scenarioCtx = { projTimes };
  evaluateConnections(model, scenarioCtx);
  const connIds = model.connections
    .filter(c => c.status !== before.get(c.id) || c.basis === 'projected')
    .map(c => c.id);

  return { projTimes, affectedLegIds, connIds };
}

/** 清除情景影响：恢复按实际/计划评估联程。 */
export function clearScenario(model) {
  evaluateConnections(model, null);
}

/** 某旅客组在当前联程评估下涉及的人数（同一组跨多表只计一次）。 */
export function impactedPassengers(model, connStatuses) {
  const groups = new Set();
  for (const c of model.connections) {
    if (connStatuses.includes(c.status)) groups.add(c.group);
  }
  let total = 0;
  for (const g of groups) total += model.groupSize.get(g) || 0;
  return { groups: groups.size, passengers: total };
}
