// UI 冒烟测试：jsdom 提供 DOM，驱动 app.js 完整流程。
// 运行：node tests/ui.smoke.mjs（需先 cd /tmp/jsdom-test && npm install jsdom --no-save）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('/tmp/jsdom-test/');
const { JSDOM } = require('jsdom');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/' });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
// 示例数据走本地文件，模拟 fetch
globalThis.fetch = async path => ({
  ok: true,
  text: async () => readFileSync(join(root, path), 'utf8'),
});

await import('../js/app.js');

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// 1. 载入示例数据
$('#load-sample').click();
await new Promise(r => setTimeout(r, 50));

ok($('#import-status').textContent.includes('14 个航段'), '导入 14 个航段', $('#import-status').textContent);
ok($('#import-status').textContent.includes('7 个旅客组'), '7 个旅客组（G2 跨表去重）', $('#import-status').textContent);
ok($('#sel-airport').options.length === 5, '机场下拉 5 个选项');
ok($$('#legs-table tbody tr[data-leg]').length > 0, '航段表有行');

// 2. 换机：CA102 在 SHA 出港视图显示真实机尾 B-2002 与换机标记
$('#sel-airport').value = 'SHA';
$('#sel-airport').dispatchEvent(new dom.window.Event('change'));
await new Promise(r => setTimeout(r, 10));
const ca102row = $('#legs-table tbody tr[data-leg="CA102|2026-11-14"]');
ok(ca102row && ca102row.innerHTML.includes('B-2002'), 'CA102 显示真实机尾 B-2002');
ok(ca102row && ca102row.innerHTML.includes('⟲'), 'CA102 有换机标记');

// 3. 点击航段 → 详情含飞机链（按真实机尾重新关联，不接 B-1001 的 CA101）
ca102row.click();
await new Promise(r => setTimeout(r, 10));
const detail = $('#detail').textContent;
ok(detail.includes('换机'), '详情提示换机（计划 B-1001）');
ok(detail.includes('CA103'), '飞机链含后续段 CA103');
ok($$('#detail .chain-leg').length === 2, 'B-2002 链 2 段', `实际 ${$$('#detail .chain-leg').length}`);

// 4. 取消与错失衔接出现在联程表
const connText = $('#conn-table').textContent;
ok(connText.includes('航班取消'), '联程表含取消导致的断裂');
ok(connText.includes('错失衔接'), '联程表含错失衔接');
ok(connText.includes('衔接紧张'), '联程表含衔接紧张');
ok($('#conn-summary').textContent.includes('59'), '受影响旅客 59 人（去重）', $('#conn-summary').textContent);

// 5. 异常面板：时间矛盾 + 缺实际到达
const anomText = $('#anomaly-list').textContent;
ok(anomText.includes('时间矛盾'), '异常面板含时间矛盾');
ok(anomText.includes('缺实际到达'), '异常面板含缺实际到达（不按准点）');

// 6. 进港视图跨午夜：CA202 到达 PEK 当地日期为 2026-11-15
$('#sel-airport').value = 'PEK';
$('#sel-airport').dispatchEvent(new dom.window.Event('change'));
$('#sel-dir').value = 'arr';
$('#sel-dir').dispatchEvent(new dom.window.Event('change'));
await new Promise(r => setTimeout(r, 10));
$('#sel-date').value = '2026-11-15';
$('#sel-date').dispatchEvent(new dom.window.Event('change'));
await new Promise(r => setTimeout(r, 10));
const arrRows = $$('#legs-table tbody tr[data-leg]').map(tr => tr.dataset.leg);
ok(arrRows.includes('CA202|2026-11-14'), '进港视图 2026-11-15 含跨午夜到达的 CA202', arrRows.join(','));
ok(arrRows.includes('CA901|2026-11-15'), '进港视图 2026-11-15 含 CA901');

// 7. 情景推算：CA501 起飞 +30 分钟
$('#sel-dir').value = 'dep';
$('#sel-dir').dispatchEvent(new dom.window.Event('change'));
$('#sel-date').value = '2026-11-14';
$('#sel-date').dispatchEvent(new dom.window.Event('change'));
$('#sel-airport').value = 'CAN';
$('#sel-airport').dispatchEvent(new dom.window.Event('change'));
await new Promise(r => setTimeout(r, 10));
$('#legs-table tbody tr[data-leg="CA501|2026-11-14"]').click();
await new Promise(r => setTimeout(r, 10));
$('#sc-dep-delta').value = '30';
$('#apply-dep-scenario').click();
await new Promise(r => setTimeout(r, 10));
ok($('#scenario-banner').classList.contains('active'), '情景横幅显示');
ok($('#scenario-desc').textContent.includes('+30'), '情景描述含 +30 分钟');
const connTextAfter = $('#conn-table').textContent;
ok(connTextAfter.includes('推算'), '联程表出现推算标记');
$('#clear-scenario').click();
await new Promise(r => setTimeout(r, 10));
ok(!$('#scenario-banner').classList.contains('active'), '清除情景后横幅隐藏');

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
