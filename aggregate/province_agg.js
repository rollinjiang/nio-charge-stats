// ============================================================
// NIO 充换电指标 · 分省聚合脚本
// 读取 data/province_history.json（每天各省换电站数快照），
// 按 日/周/月/年 聚合，输出 data/province_dashboard.json
// 供分省看板 province.html 读取
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HIST = path.join(DATA_DIR, 'province_history.json');
const OUT = path.join(DATA_DIR, 'province_dashboard.json');

// 省份代码 -> 名称
const PROVINCE_NAMES = {
  '110000': '北京', '120000': '天津', '130000': '河北', '140000': '山西', '150000': '内蒙古',
  '210000': '辽宁', '220000': '吉林', '230000': '黑龙江', '310000': '上海', '320000': '江苏',
  '330000': '浙江', '340000': '安徽', '350000': '福建', '360000': '江西', '370000': '山东',
  '410000': '河南', '420000': '湖北', '430000': '湖南', '440000': '广东', '450000': '广西',
  '460000': '海南', '500000': '重庆', '510000': '四川', '520000': '贵州', '530000': '云南',
  '540000': '西藏', '610000': '陕西', '620000': '甘肃', '630000': '青海', '640000': '宁夏',
  '650000': '新疆',
};

const ORDER = Object.keys(PROVINCE_NAMES);

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function monthKey(dateStr) { return dateStr.slice(0, 7); }
function yearKey(dateStr) { return dateStr.slice(0, 4); }

function bucketize(records, keyFn, orderKeyFn) {
  const groups = new Map();
  for (const r of records) {
    const k = keyFn(r.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const arr = Array.from(groups.entries()).map(([key, recs]) => {
    recs.sort((a, b) => a.date.localeCompare(b.date));
    const last = recs[recs.length - 1];
    // 取该周期末各省值
    const values = {};
    for (const code of ORDER) values[code] = Number(last.values[code]) || 0;
    // 全国合计 = 各省之和（注意：≠接口"全国"口径，因高速/跨省站点可能不计入单一省份）
    const total = recs.map(r => r.values).reduce((s, v) => s + (Number(v.total) || 0), 0);
    const sum = ORDER.reduce((s, c) => s + values[c], 0);
    return { key, count: recs.length, values, sum, total };
  });
  arr.sort((a, b) => orderKeyFn(a.key) - orderKeyFn(b.key));
  return arr;
}

function orderKeyFnFor(day) {
  return (k) => (day ? k : k.replace(/-/g, '').replace(/W/g, '')) * 1;
}

function main() {
  if (!fs.existsSync(HIST)) { console.error('无分省历史数据，请先运行 scraper/nio_province.js'); process.exit(1); }
  const history = JSON.parse(fs.readFileSync(HIST, 'utf-8'));
  if (history.length === 0) { console.error('分省历史为空'); process.exit(1); }

  const latest = history[history.length - 1];
  const out = {
    latest_date: latest.date,
    generated_at: new Date().toISOString(),
    total_days: history.length,
    provinces: PROVINCE_NAMES,
    order: ORDER,
    latest: { date: latest.date, values: latest.values },
    daily: bucketize(history, d => d, k => k.slice(0, 10).replace(/-/g, '') * 1),
    weekly: bucketize(history, isoWeek, k => orderKeyFnFor(false)(k)),
    monthly: bucketize(history, monthKey, k => k.replace(/-/g, '') * 1),
    yearly: bucketize(history, yearKey, k => k * 1),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`province_dashboard.json generated (${history.length} days)`);
}

main();
