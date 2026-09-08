// ============================================================
// NIO 充换电指标 · 聚合脚本
// 读取 data/history.json，按 日/周/月/年 聚合，输出 data/dashboard.json
// 供静态看板 (index.html + ECharts) 读取
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HIST = path.join(DATA_DIR, 'history.json');
const OUT = path.join(DATA_DIR, 'dashboard.json');

// 指标定义
const METRICS = [
  { key: 'power_swap_charge_device_num_total', label: '蔚来能源充换电站总数', short: '充换电站总数', color: '#E60012', unit: '' },
  { key: 'swap_station_num_for_com', label: '换电站数量', short: '换电站', color: '#1E88E5', unit: '' },
  { key: 'intercity_swap_station_num', label: '高速公路换电站', short: '高速换电站', color: '#43A047', unit: '' },
  { key: 'power_charge_station_device_num_total', label: '蔚来能源充电站数量', short: '充电站', color: '#FB8C00', unit: '' },
  { key: 'power_charge_device_num_total', label: '充电设备总数', short: '充电设备', color: '#8E24AA', unit: '' },
  { key: 'public_charger_num', label: '公共充电桩数', short: '公共充电桩', color: '#00ACC1', unit: '' },
];

// 用于"本月/本年新增换电站"计算的指标 key
const PERIOD_METRIC = 'swap_station_num_for_com';

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  // 用 UTC 避免时区偏移
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function pad(n) { return String(n).padStart(2, '0'); }
function monthKey(dateStr) { return dateStr.slice(0, 7); } // YYYY-MM
function yearKey(dateStr) { return dateStr.slice(0, 4); }  // YYYY

// 对一组记录，取每个指标的最新值（周期末的累计值）
function extractLatest(records) {
  const last = records[records.length - 1];
  const out = { date: last.date };
  for (const m of METRICS) out[m.key] = Number(last[m.key]) || 0;
  return out;
}

// 对记录按维度 key 分组，每组返回 { key, count, latest, delta, lastPrev }
function bucketize(records, keyFn, orderKeyFn) {
  const groups = new Map();
  for (const r of records) {
    const key = keyFn(r.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const arr = Array.from(groups.entries()).map(([key, recs]) => {
    recs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = extractLatest(recs);
    const first = recs[0];
    const prevVal = {};
    for (const m of METRICS) prevVal[m.key] = Number(first[m.key]) || 0;
    latest.count = recs.length;
    latest.first_date = first.date;
    return { key, ...latest };
  });
  arr.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return arr;
}

class SeriesBuilder {
  constructor() {
    this.series = {}; // metricKey -> { label, color, unit, points: [{k, v, label}] }
    for (const m of METRICS) {
      this.series[m.key] = { label: m.label, color: m.color, unit: m.unit, points: [] };
    }
  }
  add(keyLabel, row, metric) {
    const s = this.series[metric.key];
    s.points.push({ x: keyLabel, y: Number(row[metric.key]) || 0, label: keyLabel });
  }
}

function buildDaily(records) {
  const sb = new SeriesBuilder();
  const detail = [];
  for (const r of records) {
    const m = {};
    for (const metric of METRICS) m[metric.key] = Number(r[metric.key]) || 0;
    detail.push({ date: r.date, ...m });
    for (const metric of METRICS) sb.add(r.date, m, metric);
  }
  return { detail, series: sb.series, count: records.length };
}

function buildWeekly(records) {
  const buckets = bucketize(records, isoWeek, k => k);
  const sb = new SeriesBuilder();
  for (const b of buckets) {
    for (const metric of METRICS) sb.add(b.key, b, metric);
  }
  return { buckets, series: sb.series, count: buckets.length };
}

function buildMonthly(records) {
  const buckets = bucketize(records, monthKey, k => k);
  const sb = new SeriesBuilder();
  for (const b of buckets) {
    for (const metric of METRICS) sb.add(b.key, b, metric);
  }
  return { buckets, series: sb.series, count: buckets.length };
}

function buildYearly(records) {
  const buckets = bucketize(records, yearKey, k => k);
  const sb = new SeriesBuilder();
  for (const b of buckets) {
    for (const metric of METRICS) sb.add(b.key, b, metric);
  }
  return { buckets, series: sb.series, count: buckets.length };
}

// 计算"本月新增"和"本年新增"：
// - 本月新增：当前累计 − 项目历史起点（2026-09-07）的累计（首期可能为 0，逐步增长）
// - 本年新增：当前累计 − 蔚来官方公布的 2025-12-31 换电站总数（3,676 座）
//   数据来源：蔚来官方年报；用作"本年新增换电站"的固定基准值，不依赖本地抓取历史
function computePeriod(records, latest, metricKey) {
  const MONTH_BASE_DATE = '2026-09-07';
  // 蔚来官方公布：2025-12-31 换电站总数 = 3,676 座
  const YEAR_BASE_DATE = '2025-12-31';
  const YEAR_BASE_VALUE = 3676;

  const curVal = Number(latest[metricKey]) || 0;

  // 月度：基于本地历史抓取的基准日记录
  const monthBase = records.find(r => r.date === MONTH_BASE_DATE) || null;
  let monthDelta;
  if (!monthBase) {
    monthDelta = { value: 0, baseline_date: null, baseline_value: null, has_baseline: false, baseline_source: '项目历史起点' };
  } else {
    const baseVal = Number(monthBase[metricKey]) || 0;
    monthDelta = {
      value: Math.max(0, curVal - baseVal),
      baseline_date: monthBase.date,
      baseline_value: baseVal,
      has_baseline: true,
      baseline_source: '项目历史起点',
    };
  }

  // 年度：固定基准值，不依赖本地历史（蔚来官方 2025 年末数据）
  const yearDelta = {
    value: Math.max(0, curVal - YEAR_BASE_VALUE),
    baseline_date: YEAR_BASE_DATE,
    baseline_value: YEAR_BASE_VALUE,
    has_baseline: true,
    baseline_source: '蔚来官方公布数据（2025 年末换电站总数）',
  };

  return {
    month_baseline_date: MONTH_BASE_DATE,
    year_baseline_date: YEAR_BASE_DATE,
    month_delta: monthDelta,
    year_delta: yearDelta,
  };
}

function main() {
  if (!fs.existsSync(HIST)) {
    console.error('[ERROR] history.json not found. Run scraper first.');
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(HIST, 'utf-8'));
  if (!records.length) {
    console.error('[ERROR] history.json is empty.');
    process.exit(1);
  }
  records.sort((a, b) => a.date.localeCompare(b.date));

  const latest = records[records.length - 1];
  const prev = records.length > 1 ? records[records.length - 2] : null;

  const daily = buildDaily(records);
  const weekly = buildWeekly(records);
  const monthly = buildMonthly(records);
  const yearly = buildYearly(records);

  const latestCards = {};
  for (const metric of METRICS) {
    const cur = Number(latest[metric.key]) || 0;
    let delta = null, deltaDays = null;
    if (prev) {
      delta = cur - (Number(prev[metric.key]) || 0);
      // 日期差
      deltaDays = Math.round((new Date(latest.date) - new Date(prev.date)) / 86400000);
    }
    latestCards[metric.key] = {
      label: metric.label,
      short: metric.short,
      value: cur,
      delta,
      delta_days: deltaDays,
      prev_value: prev ? Number(prev[metric.key]) : null,
    };
  }

  const dashboard = {
    generated_at: new Date().toISOString(),
    latest_date: latest.date,
    total_days: records.length,
    metrics: METRICS,
    latest: latestCards,
    daily: daily.series,
    weekly: weekly.series,
    monthly: monthly.series,
    yearly: yearly.series,
    meta: {
      daily_count: daily.count,
      weekly_count: weekly.count,
      monthly_count: monthly.count,
      yearly_count: yearly.count,
      first_date: records[0].date,
    },
    // 本期新增（"本月新增换电站" / "本年新增换电站"）
    // 基线 = 严格 < 周期起点的最后一条记录的累计换电站数
    period: computePeriod(records, latest, PERIOD_METRIC),
  };

  fs.writeFileSync(OUT, JSON.stringify(dashboard, null, 2), 'utf-8');
  console.log(`[OK] dashboard.json generated (${records.length} days).`);
  console.log('  最新:', latest.date, '充换电站总数=', latest.power_swap_charge_device_num_total,
    '换电站=', latest.swap_station_num_for_com, '高速换电站=', latest.intercity_swap_station_num);
}

main();
