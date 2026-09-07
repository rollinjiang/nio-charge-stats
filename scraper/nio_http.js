// ============================================================
// NIO 充换电指标 · 每日抓取（轻量 HTTP 版，无需浏览器）
//
// 重要发现：数据接口 chargermap-fe-gateway.nio.com 完全开放
//   - 无需登录、无需浏览器、无需绕过 WAF
//   - 裸 curl 即可返回明文数据（encrypt_type=0）
//   - 风控(EdgeOne)只作用于 www.nio.cn 主站，不影响此 API 网关
// 因此本脚本不依赖 Playwright/Chrome，可在任何环境运行（含云端定时）
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const BASE = 'https://chargermap-fe-gateway.nio.com/pe/bff/gateway/powermap/h5/charge-map';
const COMMON = 'app_ver=5.2.0&client=pc&container=brower&lang=zh&region=CN&app_id=100119&channel=official&brand=nio';

const INDICATORS = [
  'power_swap_charge_device_num_total',   // 蔚来能源充换电站总数
  'power_charge_station_device_num_total',// 蔚来能源充电站数量（座）
  'swap_station_num_for_com',             // 换电站数量
  'intercity_swap_station_num',           // 高速公路换电站
  'power_charge_device_num_total',        // 充电设备总数
  'public_charger_num',                   // 公共充电桩数
  'charger_other_brand_energy_rate',      // 其他品牌充电能量占比
];

const LABEL_MAP = {
  power_swap_charge_device_num_total: '蔚来能源充换电站总数',
  power_charge_station_device_num_total: '蔚来能源充电站数量',
  swap_station_num_for_com: '换电站数量',
  intercity_swap_station_num: '高速公路换电站',
  power_charge_device_num_total: '充电设备总数',
  public_charger_num: '公共充电桩数',
  charger_other_brand_energy_rate: '其他品牌充电能量占比(%)',
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function displayVal(code, v) {
  if (v == null) return '—';
  if (code === 'charger_other_brand_energy_rate') return Number(v).toFixed(2) + '%';
  return Number(v).toLocaleString('zh-CN');
}

async function fetchSummary() {
  const url = `${BASE}/v1/indicator/basic/summary?${COMMON}&indicators=${INDICATORS.join(',')}&dim_code=region_code&dim_value=000000&timestamp=${Date.now()}`;
  // Node 18+ 内置 fetch，无需任何依赖
  const resp = await fetch(url, {
    headers: {
      referer: 'https://www.nio.cn/charger-map',
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function parse(json) {
  const indicator_map = json?.data?.indicator_map || {};
  const out = {};
  for (const [code, item] of Object.entries(indicator_map)) {
    const inner = item?.indicator_item_map || {};
    for (const [, v] of Object.entries(inner)) out[code] = v?.indicator_value ?? v;
  }
  return out;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const json = await fetchSummary();
  const parsed = parse(json);
  if (Object.keys(parsed).length === 0) throw new Error('接口未返回指标数据');

  const date = todayStr();

  // 1) 最新快照
  const latest = { date, fetched_at: new Date().toISOString(), ...parsed };
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(latest, null, 2), 'utf-8');
  fs.writeFileSync(path.join(DATA_DIR, 'latest_raw.json'), JSON.stringify(json, null, 2), 'utf-8');

  // 2) 追加历史（按天一条，同日覆盖）
  const histPath = path.join(DATA_DIR, 'history.json');
  let history = [];
  if (fs.existsSync(histPath)) {
    try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch (_) {}
  }
  const record = {
    date,
    fetched_at: latest.fetched_at,
    power_swap_charge_device_num_total: Number(parsed.power_swap_charge_device_num_total),
    power_charge_station_device_num_total: Number(parsed.power_charge_station_device_num_total),
    swap_station_num_for_com: Number(parsed.swap_station_num_for_com),
    intercity_swap_station_num: Number(parsed.intercity_swap_station_num),
    power_charge_device_num_total: Number(parsed.power_charge_device_num_total),
    public_charger_num: Number(parsed.public_charger_num),
    charger_other_brand_energy_rate: Number(parsed.charger_other_brand_energy_rate),
  };
  const idx = history.findIndex(r => r.date === date);
  if (idx >= 0) history[idx] = record; else history.push(record);
  history.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf-8');

  console.log(`[OK] ${date}`);
  for (const code of INDICATORS) {
    console.log(`  ${LABEL_MAP[code] || code}: ${displayVal(code, parsed[code])}`);
  }
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
