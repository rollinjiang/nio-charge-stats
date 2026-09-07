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

// 重点城市
const CITY_NAMES = {
  '440300': '深圳',
};

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

// 计算"周期内各省新增"：当前周期末累计值 - 上一周期末累计值
// 如果没有上一周期，则视为"全量为新增"
function computeDeltasByProv(dailyRecords) {
  // dailyRecords 已经按日期升序
  const out = [];
  let prevValues = null;
  for (const r of dailyRecords) {
    const cur = r.values || {};
    const deltas = {};
    for (const code of ORDER) {
      const curV = Number(cur[code]) || 0;
      const prevV = prevValues ? (Number(prevValues[code]) || 0) : 0;
      deltas[code] = prevValues ? Math.max(0, curV - prevV) : curV;
    }
    out.push({ date: r.date, deltas, values: cur, cities: r.cities || {} });
    prevValues = cur;
  }
  return out;
}

function orderKeyFnFor(day) {
  return (k) => (day ? k : k.replace(/-/g, '').replace(/W/g, '')) * 1;
}

function main() {
  if (!fs.existsSync(HIST)) { console.error('无分省历史数据，请先运行 scraper/nio_province.js'); process.exit(1); }
  const history = JSON.parse(fs.readFileSync(HIST, 'utf-8'));
  if (history.length === 0) { console.error('分省历史为空'); process.exit(1); }

  const latest = history[history.length - 1];

  // 计算各省逐日新增（用于"本月新增最多"等聚合）
  const dailyDeltas = computeDeltasByProv(history);
  const latestDeltas = dailyDeltas[dailyDeltas.length - 1].deltas || {};

  // "本月新增"：本月 1 日及之后所有记录的各省新增之和
  // 用户语义：本期(月/年)起点至今日各省累计增量
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  // 全国本月/本年新增换电站 = 本期起点之后每日新增之和
  // 由于 history 是按天抓取的"累计快照"，新增 = 当前累计 - 期初前一条记录的累计
  // 简化：取"当前累计" 与 "期初前最后一条记录累计" 的差
  const yearStartStr = `${today.getFullYear()}-01-01`;
  const monthStartStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  // 严格 < 周期起点的最后一条记录作为基线
  function findBaselineBefore(dateStr) {
    let base = null;
    for (const r of history) {
      if (r.date < dateStr) base = r;
      else break;
    }
    return base;
  }
  const yearBase = findBaselineBefore(yearStartStr);
  const monthBase = findBaselineBefore(monthStartStr);

  // 各省在两个基线下的本期新增
  function deltasFromBaseline(base) {
    const out = {};
    for (const code of ORDER) {
      const cur = Number(latest.values[code]) || 0;
      const prev = base ? (Number(base.values[code]) || 0) : 0;
      out[code] = Math.max(0, cur - prev);
    }
    return out;
  }
  const yearDeltaByProv = deltasFromBaseline(yearBase);
  const monthDeltaByProv = deltasFromBaseline(monthBase);

  // "本月新增最多的省份"
  let monthTopCode = null, monthTopVal = -1;
  for (const [code, v] of Object.entries(monthDeltaByProv)) {
    if (v > monthTopVal) { monthTopVal = v; monthTopCode = code; }
  }

  // 重点城市最新值（如 深圳市）
  const latestCities = latest.cities || {};
  const cityLatest = {};
  for (const code of Object.keys(CITY_NAMES)) {
    cityLatest[code] = Number(latestCities[code]) || 0;
  }

  const out = {
    latest_date: latest.date,
    generated_at: new Date().toISOString(),
    total_days: history.length,
    provinces: PROVINCE_NAMES,
    order: ORDER,
    cities: CITY_NAMES,
    latest: {
      date: latest.date,
      values: latest.values,
      cities: latestCities,
    },
    daily: bucketize(history, d => d, k => k.slice(0, 10).replace(/-/g, '') * 1),
    weekly: bucketize(history, isoWeek, k => orderKeyFnFor(false)(k)),
    monthly: bucketize(history, monthKey, k => k.replace(/-/g, '') * 1),
    yearly: bucketize(history, yearKey, k => k * 1),
    // 本期新增相关
    period: {
      year_start: yearStartStr,
      month_start: monthStartStr,
      month_top_province: monthTopCode ? { code: monthTopCode, name: PROVINCE_NAMES[monthTopCode] || monthTopCode, delta: monthTopVal } : null,
      month_delta_by_prov: monthDeltaByProv,
      year_delta_by_prov: yearDeltaByProv,
      has_year_baseline: !!yearBase,
      has_month_baseline: !!monthBase,
      year_base_date: yearBase ? yearBase.date : null,
      month_base_date: monthBase ? monthBase.date : null,
      city_latest: cityLatest,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`province_dashboard.json generated (${history.length} days)`);
}

main();
