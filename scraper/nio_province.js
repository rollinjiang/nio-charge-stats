// ============================================================
// NIO 充换电指标 · 分省换电站数量抓取（纯 HTTP，无需浏览器）
//
// 关键发现：summary 接口用标准行政区划代码(GB/T 2260)作为 dim_value
//   dim_code=region_code, dim_value=440000 即可拿到该省换电站数
//   例：广东 440000 → 换电站 488（与官网点击地图后"数据"面板一致）
// 本脚本每天抓取全国 31 个省级行政区（不含港澳台）的换电站数量
// ============================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const BASE = 'https://chargermap-fe-gateway.nio.com/pe/bff/gateway/powermap/h5/charge-map';
const COMMON = 'app_ver=5.2.0&client=pc&container=brower&lang=zh&region=CN&app_id=100119&channel=official&brand=nio';

// 全国 31 个省级行政区（GB/T 2260 行政区划代码）
const PROVINCES = [
  { code: '110000', name: '北京' },
  { code: '120000', name: '天津' },
  { code: '130000', name: '河北' },
  { code: '140000', name: '山西' },
  { code: '150000', name: '内蒙古' },
  { code: '210000', name: '辽宁' },
  { code: '220000', name: '吉林' },
  { code: '230000', name: '黑龙江' },
  { code: '310000', name: '上海' },
  { code: '320000', name: '江苏' },
  { code: '330000', name: '浙江' },
  { code: '340000', name: '安徽' },
  { code: '350000', name: '福建' },
  { code: '360000', name: '江西' },
  { code: '370000', name: '山东' },
  { code: '410000', name: '河南' },
  { code: '420000', name: '湖北' },
  { code: '430000', name: '湖南' },
  { code: '440000', name: '广东' },
  { code: '450000', name: '广西' },
  { code: '460000', name: '海南' },
  { code: '500000', name: '重庆' },
  { code: '510000', name: '四川' },
  { code: '520000', name: '贵州' },
  { code: '530000', name: '云南' },
  { code: '540000', name: '西藏' },
  { code: '610000', name: '陕西' },
  { code: '620000', name: '甘肃' },
  { code: '630000', name: '青海' },
  { code: '640000', name: '宁夏' },
  { code: '650000', name: '新疆' },
];

const HDR = {
  referer: 'https://www.nio.cn/charger-map',
  accept: 'application/json, text/plain, */*',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 并发批量请求（限制并发，避免被限流）
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchProvinceSwap(code) {
  const url = `${BASE}/v1/indicator/basic/summary?${COMMON}&indicators=swap_station_num_for_com&dim_code=region_code&dim_value=${code}&timestamp=${Date.now()}`;
  const resp = await fetch(url, { headers: HDR });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} @ ${code}`);
  const json = await resp.json();
  const im = json?.data?.indicator_map || {};
  for (const item of Object.values(im)) {
    const inner = item?.indicator_item_map || {};
    for (const v of Object.values(inner)) {
      const val = v?.indicator_value ?? v;
      if (val != null) return Number(val) || 0;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 并行抓 31 省（每批 6 并发）
  const results = await mapLimit(PROVINCES, 6, async (p) => {
    const v = await fetchProvinceSwap(p.code);
    return { code: p.code, name: p.name, value: v };
  });

  const date = todayStr();
  const values = {};
  let okCount = 0;
  for (const r of results) {
    if (r.value != null) { values[r.code] = r.value; okCount++; }
  }
  if (okCount === 0) throw new Error('所有省份均未返回数据');

  // 读取历史，按天追加/覆盖
  const histPath = path.join(DATA_DIR, 'province_history.json');
  let history = [];
  if (fs.existsSync(histPath)) {
    try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch (_) {}
  }
  const record = { date, fetched_at: new Date().toISOString(), values };
  const idx = history.findIndex(r => r.date === date);
  if (idx >= 0) history[idx] = record; else history.push(record);
  history.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf-8');

  console.log(`[OK] ${date} 分省换电站 ${okCount}/${PROVINCES.length} 省`);
  // 按数值降序打印 Top5 便于人工核对
  const sorted = results.filter(r => r.value != null).sort((a, b) => b.value - a.value);
  for (const r of sorted.slice(0, 5)) {
    console.log(`  ${r.name}(${r.code}): ${r.value}`);
  }
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
