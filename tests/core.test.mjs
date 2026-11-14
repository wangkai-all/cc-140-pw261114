// 核心逻辑测试：node tests/core.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsv } from '../js/csv.js';
import { localToUtc, fmtUtc, MIN } from '../js/time.js';
import { buildModel, applyScenario, clearScenario, impactedPassengers, LegStatus, ConnStatus } from '../js/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => parseCsv(readFileSync(join(root, p), 'utf8'));

let passed = 0, failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq(a, b, name) { ok(a === b, name, `(期望 ${b}，实际 ${a})`); }

console.log('— 时区换算 —');
// 北京 UTC+8：08:00 CST = 00:00 UTC
eq(fmtUtc(localToUtc('2026-11-14', '08:00', 'Asia/Shanghai')), '2026-11-14 00:00', 'PEK 08:00 → UTC 00:00');
// 莫斯科 UTC+3：19:55 MSK = 16:55 UTC
eq(fmtUtc(localToUtc('2026-11-14', '19:55', 'Europe/Moscow')), '2026-11-14 16:55', 'SVO 19:55 → UTC 16:55');
// 檀香山 UTC-10：12:05 HST = 22:05 UTC
eq(fmtUtc(localToUtc('2026-11-14', '12:05', 'Pacific/Honolulu')), '2026-11-14 22:05', 'HNL 12:05 → UTC 22:05');

const model = buildModel({
  airports: read('samples/airports.csv'),
  plan: read('samples/plan.csv'),
  actuals: read('samples/actuals.csv'),
  connectionTables: [read('samples/connections.csv'), read('samples/connections_extra.csv')],
});
const leg = id => model.legByKey.get(id);

console.log('— 跨午夜 / 跨时区 —');
// CA202 SVO 21:30 → PEK 09:55：到达为次日，UTC 差应为 7h25m
const ca202 = leg('CA202|2026-11-14');
eq((ca202.schedArrUtc - ca202.schedDepUtc) / MIN, 445, 'CA202 计划航段跨午夜 445 分钟');
eq(fmtUtc(ca202.schedArrUtc), '2026-11-15 01:55', 'CA202 计划到达落在次日（UTC）');
// CA301 PEK 23:55 → HNL 12:05（同日，跨日期变更线）：6h10m
const ca301 = leg('CA301|2026-11-14');
eq((ca301.actualArrUtc - ca301.actualDepUtc) / MIN, 370, 'CA301 跨时区实际航段 370 分钟');

console.log('— 换机后按真实机尾号重新关联 —');
ok(model.chains.has('B-1001') && model.chains.get('B-1001').length === 1, 'B-1001 链只剩 CA101');
eq(model.chains.get('B-2002').map(l => l.flight).join(','), 'CA102,CA103', 'B-2002 链接管 CA102→CA103');
eq(leg('CA102|2026-11-14').prevLegId, null, 'CA102 是 B-2002 当日首段（不接 CA101）');

console.log('— 延误拆分：本段新增 vs 前段带入 —');
const ca501 = leg('CA501|2026-11-14');
eq(Math.round(ca501.depDelayMin), 95, 'CA501 离港延误 95 分钟');
eq(Math.round(ca501.newDelayMin), 95, 'CA501 为首段，全部为本段新增');
const ca502 = leg('CA502|2026-11-14');
eq(Math.round(ca502.depDelayMin), 65, 'CA502 离港延误 65 分钟');
eq(Math.round(ca502.propagatedMin), 65, 'CA502 延误全部由前段带入');
eq(Math.round(ca502.newDelayMin), 0, 'CA502 本段新增为 0');
eq(Math.round(ca502.turnFromPrevMin), 20, 'CA502 实际周转 20 分钟');
const ca202b = leg('CA202|2026-11-14');
eq(Math.round(ca202b.propagatedMin), 10, 'CA202 前段带入 10 分钟（扣除 SVO 最小周转 60）');
eq(Math.round(ca202b.newDelayMin), 10, 'CA202 本段新增 10 分钟');

console.log('— 缺实际到达 ≠ 准点；时间矛盾单列 —');
const ca901 = leg('CA901|2026-11-15');
eq(ca901.status, LegStatus.MISSING_ARR, 'CA901 缺实际到达');
eq(ca901.arrDelayMin, null, 'CA901 到达延误未知（不是 0）');
const ca900 = leg('CA900|2026-11-14');
ok(ca900.anomalies.some(m => m.includes('时间矛盾')), 'CA900 实际到达早于起飞被标记时间矛盾');
ok(model.anomalies.some(a => a.type === 'MISSING_ARR' && a.legId === ca901.id), '异常列表含 CA901 缺到达');

console.log('— 取消 —');
eq(leg('CA1599|2026-11-14').status, LegStatus.CANCELLED, 'CA1599 已取消');
ok(!model.chains.has('B-6006'), '取消航段不进入飞机链');

console.log('— 联程风险与旅客去重 —');
const conn = (g, f) => model.connections.find(c => c.group === g && c.fromLegId.startsWith(f));
eq(conn('G1', 'CA101').status, ConnStatus.BROKEN_CANCEL, 'G1 后段取消 → 衔接断裂');
eq(conn('G2', 'CA501').status, ConnStatus.AT_RISK, 'G2 衔接 20 分钟 < MCT 60 → 风险');
eq(Math.round(conn('G2', 'CA501').availMin), 20, 'G2 可用衔接 20 分钟');
eq(conn('G5', 'CA501').status, ConnStatus.MISSED, 'G5 后段已起飞 → 错失衔接');
eq(conn('G4', 'CA201').status, ConnStatus.AT_RISK, 'G4 SVO 衔接 70 分钟 < MCT 90 → 风险');
eq(conn('G3', 'CA102').status, ConnStatus.OK, 'G3 衔接正常');
eq(model.connections.filter(c => c.group === 'G2').length, 2, 'G2 出现在两份关联表');
const impacted = impactedPassengers(model, [ConnStatus.AT_RISK, ConnStatus.MISSED, ConnStatus.BROKEN_CANCEL]);
eq(impacted.groups, 4, '受影响旅客组 4 个（G2 不重复计）');
eq(impacted.passengers, 24 + 15 + 12 + 8, '受影响旅客 59 人（G2 只计一次）');

console.log('— 情景推算：调整起飞时间，向后传播 —');
clearScenario(model);
const sc = applyScenario(model, { type: 'dep', legId: 'CA501|2026-11-14', deltaMin: 30 });
const ca503proj = sc.projTimes.get('CA503|2026-11-14');
ok(ca503proj, 'CA503（无实际记录）被推算');
eq(fmtUtc(ca503proj.depUtc), '2026-11-14 09:00', 'CA503 推算起飞 17:00 CST（前段实际到达 16:15 + 周转 45）');
ok(!sc.projTimes.has('CA502|2026-11-14'), 'CA502 有实际记录，保持实际值不覆盖');
ok(sc.affectedLegIds.includes('CA501|2026-11-14'), '受影响含被调整段 CA501');
ok(sc.affectedLegIds.includes('CA503|2026-11-14'), '受影响含下游 CA503');
const g7 = model.connections.find(c => c.group === 'G7');
eq(g7.status, ConnStatus.AT_RISK, '情景下 G7 衔接恶化（30 分钟 < MCT 60）');
eq(g7.basis, 'projected', 'G7 评估基于推算值');
const g2After = conn('G2', 'CA501');
eq(g2After.status, ConnStatus.MISSED, 'G2 情景下恶化：前段推算到达晚于后段实际起飞');

console.log('— 情景推算：修改最小周转 —');
clearScenario(model);
const sc2 = applyScenario(model, { type: 'turn', airport: 'SHA', minTurn: 120 });
const ca503proj2 = sc2.projTimes.get('CA503|2026-11-14');
ok(ca503proj2, '提高 SHA 周转后 CA503 被推算');
eq(fmtUtc(ca503proj2.depUtc), '2026-11-14 10:15', 'CA503 推算起飞 18:15 CST（16:15 + 120 分钟）');
clearScenario(model);
eq(conn('G7', 'CA503').status, ConnStatus.OK, '清除情景后 G7 恢复正常');

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
