// ============================================================
// NIO 充换电指标 · 每日抓取脚本
// 数据源：https://www.nio.cn/charger-map (公开接口，无需登录)
// 关键接口 /v1/indicator/basic/summary 返回明文数据 encrypt_type=0
// ============================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(PROJECT_ROOT, '.browser-profile', 'nio');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const CHROME_BIN = '/Users/rollin/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const BASE = 'https://chargermap-fe-gateway.nio.com/pe/bff/gateway/powermap/h5/charge-map';
const COMMON = 'app_ver=5.2.0&client=pc&container=brower&lang=zh&region=CN&app_id=100119&channel=official&brand=nio';

// 指标定义：code -> { name, short }
const INDICATORS = [
  'power_swap_charge_device_num_total',   // 充换电站设备总数
  'swap_station_num_for_com',             // 换电站数量
  'intercity_swap_station_num',           // 高速（城际）换电站
  'power_charge_station_device_num_total',// 充电站设备总数
  'power_charge_device_num_total',        // 充电设备总数
  'public_charger_num',                   // 公共充电桩数
  'charger_other_brand_energy_rate',      // 其他品牌充电能量占比
];

const LABEL_MAP = {
  power_swap_charge_device_num_total: '蔚来能源充换电站总数',
  swap_station_num_for_com: '换电站数量',
  intercity_swap_station_num: '高速公路换电站',
  power_charge_station_device_num_total: '蔚来能源充电站数量',
  power_charge_device_num_total: '充电设备总数',
  public_charger_num: '公共充电桩数',
  charger_other_brand_energy_rate: '其他品牌充电能量占比(%)',
};

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 给累计值加千分位/保留小数，展示友好
function displayVal(code, v) {
  if (v == null) return '—';
  if (code === 'charger_other_brand_energy_rate') {
    return Number(v).toFixed(2) + '%';
  }
  return Number(v).toLocaleString('zh-CN');
}

async function fetchSummary(page) {
  const url = `${BASE}/v1/indicator/basic/summary?${COMMON}&indicators=${INDICATORS.join(',')}&dim_code=region_code&dim_value=000000&timestamp=${Date.now()}`;
  const resp = await page.request.get(url, {
    headers: {
      referer: 'https://www.nio.cn/charger-map',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()} for summary`);
  return resp.json();
}

function parse(json) {
  const indicator_map = json?.data?.indicator_map || {};
  const out = {};
  for (const [code, item] of Object.entries(indicator_map)) {
    const inner = item?.indicator_item_map || {};
    for (const [, v] of Object.entries(inner)) {
      out[code] = v?.indicator_value ?? v;
    }
  }
  return out;
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    executablePath: CHROME_BIN,      // 兜底：若 channel 找不到则用测试版 Chrome
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    // 先打开主页建立会话（过 WAF 指纹），再请求接口
    await page.goto('https://www.nio.cn/charger-map', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
  } catch (e) {
    console.warn('[warn] goto:', e.message);
  }

  const json = await fetchSummary(page);
  const parsed = parse(json);
  const date = todayStr();

  if (Object.keys(parsed).length === 0) {
    throw new Error('No data parsed from summary — WAF may have blocked.');
  }

  // 1) 写最新快照
  const latest = {
    date,
    fetched_at: new Date().toISOString(),
    ...parsed,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(latest, null, 2), 'utf-8');
  fs.writeFileSync(path.join(DATA_DIR, 'latest_raw.json'), JSON.stringify(json, null, 2), 'utf-8');

  // 2) 追加到历史数据（按天一条）
  const histPath = path.join(DATA_DIR, 'history.json');
  let history = [];
  if (fs.existsSync(histPath)) {
    try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch (_) {}
  }
  // 同一天重复运行则覆盖
  const idx = history.findIndex(r => r.date === date);
  const record = {
    date,
    fetched_at: latest.fetched_at,
    power_swap_charge_device_num_total: Number(parsed.power_swap_charge_device_num_total),
    swap_station_num_for_com: Number(parsed.swap_station_num_for_com),
    intercity_swap_station_num: Number(parsed.intercity_swap_station_num),
    power_charge_station_device_num_total: Number(parsed.power_charge_station_device_num_total),
    power_charge_device_num_total: Number(parsed.power_charge_device_num_total),
    public_charger_num: Number(parsed.public_charger_num),
    charger_other_brand_energy_rate: Number(parsed.charger_other_brand_energy_rate),
  };
  if (idx >= 0) history[idx] = record;
  else history.push(record);
  history.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf-8');

  // 3) 控制台输出便于日志
  console.log(`[OK] ${date}`);
  for (const code of INDICATORS) {
    console.log(`  ${LABEL_MAP[code] || code}: ${displayVal(code, parsed[code])}`);
  }

  await ctx.close();
}

main().catch(async (e) => {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
