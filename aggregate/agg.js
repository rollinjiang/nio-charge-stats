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

// ============================================================
// 每月新建数量（换电站 / 充电站）
// 规则：
//   每月新增 = 该月最后一条记录累计 − 基线累计
//   基线取值：
//     · 首个月份 → 该月第一条记录（项目起点，2026-09-07）
//     · 后续月份 → 上一个月的最后一条记录（即上月末累计）
// 持久化：结果写入 data/monthly_new.json 累积保存。
//   每次重算后与旧快照合并 —— 旧快照中已存在的月份若当前 history
//   无法再算出来（例如历史被清理），仍予保留，保证月度数据不丢。
// ============================================================
const MONTHLY_SNAPSHOT = path.join(DATA_DIR, 'monthly_new.json');

// 需要统计月度新增的两个指标
const MONTHLY_METRICS = [
  { key: 'swap_station_num_for_com',            metric: 'swap',  label: '每月新建换电站数量', color: '#1E88E5' },
  { key: 'power_charge_station_device_num_total', metric: 'charge', label: '每月新建充电站数量', color: '#FB8C00' },
];

// 把记录按月份分组，返回 Map<YYYY-MM, records[]>（records 已按日期升序）
function groupByMonth(records) {
  const map = new Map();
  for (const r of records) {
    const m = monthKey(r.date);
    if (!map.has(m)) map.set(m, []);
    map.get(m).push(r);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

function computeMonthlyNew(records) {
  const byMonth = groupByMonth(records);
  const months = Array.from(byMonth.keys()).sort(); // 升序，如 ['2026-09','2026-10']

  // 先读取旧快照，作为历史保护基线
  let snapshot = { months: {} };
  if (fs.existsSync(MONTHLY_SNAPSHOT)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(MONTHLY_SNAPSHOT, 'utf-8'));
      if (parsed && typeof parsed.months === 'object') snapshot = parsed;
    } catch (_) { /* 损坏则忽略，重新生成 */ }
  }

  // 用当前 history 重算每个可得月份
  const computed = {};
  let prevMonthEnd = null; // 上月末的各指标值，用于作为本月基线

  for (const m of months) {
    const recs = byMonth.get(m);
    const first = recs[0];
    const last = recs[recs.length - 1];

    // 基线：优先用上月末；若没有上个月（即首月），用本月第一条记录
    const baseSource = prevMonthEnd ? prevMonthEnd.record : first;
    const isFirstMonth = !prevMonthEnd;

    const entry = {
      month: m,
      start_date: first.date,
      end_date: last.date,
      days: recs.length,
      is_complete: false, // 稍后统一修正
    };
    for (const mm of MONTHLY_METRICS) {
      const endVal = Number(last[mm.key]) || 0;
      const baseVal = Number(baseSource[mm.key]) || 0;
      entry[mm.metric] = {
        baseline_date: baseSource.date,
        baseline_value: baseVal,
        end_value: endVal,
        new_count: Math.max(0, endVal - baseVal),
        is_first_month: isFirstMonth,
      };
    }
    computed[m] = entry;
    prevMonthEnd = { month: m, record: last };
  }

  // 合并：以 computed 为准，但保留快照里已完结、当前算不出来的月份
  const merged = Object.assign({}, snapshot.months);
  for (const m of Object.keys(computed)) {
    merged[m] = Object.assign({}, merged[m] || {}, computed[m]);
  }

  // 标记完结状态：只要存在比它更晚且有数据的月份，说明该月已结束，数值锁定
  const keys = Object.keys(merged).sort();
  const lastKey = keys[keys.length - 1];
  for (const k of keys) {
    merged[k].is_complete = k !== lastKey;
  }

  // 输出给前端的有序数组
  const toArray = metric => keys.map(k => {
    const e = merged[k];
    const d = e[metric] || {};
    return {
      month: k,
      new_count: Number(d.new_count) || 0,
      end_value: Number(d.end_value) || 0,
      baseline_value: Number(d.baseline_value) || 0,
      baseline_date: d.baseline_date || null,
      is_complete: !!e.is_complete,
      is_first_month: !!d.is_first_month,
      days: Number(e.days) || 0,
    };
  });

  const out = {
    generated_at: new Date().toISOString(),
    months: merged,
  };
  fs.writeFileSync(MONTHLY_SNAPSHOT, JSON.stringify(out, null, 2), 'utf-8');

  // 供 dashboard.json 使用
  const result = {
    labels: keys,
    series: {},
  };
  for (const mm of MONTHLY_METRICS) {
    result.series[mm.metric] = {
      key: mm.key, label: mm.label, color: mm.color, points: toArray(mm.metric),
    };
  }
  return result;
}

// ============================================================
// 每日新增换电站数量（按日历日展示，从指定起点日开始）
// 规则：
//   每日新增 = 当日累计 − 前一日累计
//     · 起点日之后：前一日 = history 中上一条记录（每天仅保留末次抓取）
//     · 起点日当天：前一日 = history 中早于起点日的最近一条记录作为基线
// 说明：history 每天 2 次抓取、同日覆盖，故每日仅一条记录。
//   若起点日与基线日之间存在抓取缺口（某日无记录），则首根柱子会包含
//   缺口天数的累计新增；后续日期相邻记录连续时即为单日新增。
// ============================================================
const DAILY_NEW_START = '2026-09-26';
const DAILY_NEW_METRIC = 'swap_station_num_for_com';

function computeDailyNew(records) {
  const from = records.filter(r => r.date >= DAILY_NEW_START);
  if (!from.length) {
    return {
      start_date: DAILY_NEW_START, metric_key: DAILY_NEW_METRIC,
      label: '本月每日新增换电站数量', unit: '座', points: [],
    };
  }
  const points = [];
  for (let i = 0; i < from.length; i++) {
    const cur = from[i];
    const curVal = Number(cur[DAILY_NEW_METRIC]) || 0;
    let base;
    if (i > 0) {
      base = from[i - 1];                       // 上一条记录（相邻日）
    } else {
      const earlier = records.filter(r => r.date < DAILY_NEW_START);
      base = earlier.length ? earlier[earlier.length - 1] : null; // 起点日基线
    }
    const baseVal = base ? (Number(base[DAILY_NEW_METRIC]) || 0) : curVal;
    points.push({
      date: cur.date,
      new_count: Math.max(0, curVal - baseVal),
      end_value: curVal,
      baseline_date: base ? base.date : null,
      baseline_value: base ? baseVal : null,
    });
  }
  return {
    start_date: DAILY_NEW_START,
    metric_key: DAILY_NEW_METRIC,
    label: '本月每日新增换电站数量',
    unit: '座',
    points,
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
    // 每月新建数量（换电站 / 充电站）—— 柱状图数据源
    monthly_new: computeMonthlyNew(records),
    // 每日新增换电站数量（从 2026-09-26 起）—— 柱状图数据源
    daily_new: computeDailyNew(records),
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
