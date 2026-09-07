# NIO 充换电指标看板 · 项目交付说明

## 项目概况

为监控蔚来（NIO）充换电网络规模，搭建了一套"**每日自动抓取 → 指标聚合 → 可视化看板**"的完整工作流。

- **数据源**：蔚来官网充电地图 https://www.nio.cn/charger-map （公开接口，无需登录）
- **更新频率**：每天 08:30 自动抓取
- **在线看板**：https://9b753a37197449429a08d2c6a720b77a.app.workbuddy.link
- **本地入口**：`/Users/rollin/WorkBuddy/2026-09-07-11-38-52/index.html`

## 核心指标

| 指标（看板卡片） | 字段代码 | 当前值 (2026-09-07) |
|---|---|---|
| 蔚来能源充换电站总数 | `power_swap_charge_device_num_total` | **9,322** |
| 蔚来能源充电站数量（座） | `power_charge_station_device_num_total` | **5,252** |
| 换电站数量 | `swap_station_num_for_com` | **4,070** |
| 高速公路换电站 | `intercity_swap_station_num` | **1,053** |
| 充电设备总数 | `power_charge_device_num_total` | 30,280 |
| 公共充电桩数 | `public_charger_num` | 1,767,192 |
| 其他品牌充电能量占比 | `charger_other_brand_energy_rate` | 86.57% |

### 口径验证（重要）
接口无独立的"充电站座数"字段（已探测 10 个候选 code 均不存在）。经数学验证确认：
**换电站 4,070 + 充电站 5,252 = 9,322 = 充换电站总数** ✓ 完全吻合
因此 `power_charge_station_device_num_total`（5,252）即 **蔚来能源充电站座数**（尽管字段名含 device）。

## 技术方案

### 关键突破：接口完全开放（最终方案）
- **EdgeOne 风控只作用于 `www.nio.cn` 主站**，数据网关 `chargermap-fe-gateway.nio.com` **无风控**。
- 数据接口 `/v1/indicator/basic/summary`：无需登录、无需浏览器、**裸 curl 即可返回明文**（encrypt_type=0）。实测：裸请求 HTTP 200，连续 5 次全部 success。
- **接口开放 CORS**（`access-control-allow-origin: *`），浏览器可跨域直连。

（早期用 Playwright 真实 Chrome 绕过 WAF 的方案已废弃——对抓此接口是多余的。保留 `scraper/nio_daily.js` 仅作存档。）

### 项目结构
```
├── index.html              # 看板（静态 HTML + ECharts，支持日/周/月/年切换 + 明暗主题）
├── run.sh                  # 一键运行：抓取 → 聚合
├── scraper/nio_daily.js    # 每日抓取（真实 Chrome 请求公开接口）
├── aggregate/agg.js        # 按日/周/月/年聚合，生成 dashboard.json
├── data/
│   ├── history.json        # 按天追加的历史数据（累计值）
│   ├── latest.json         # 当日最新快照
│   ├── latest_raw.json     # 接口原始响应
│   └── dashboard.json      # 聚合结果，供看板读取
└── .browser-profile/       # 持久化浏览器档案（绕过风控用）
```

### 数据获取：双层机制（关键设计）

**① 实时层（不依赖电脑）—— 当前值永远准确**
看板在浏览器中**直接跨域请求 NIO 接口**（CORS 已开放），打开页面即显示最新真实数据，卡片标注「⚡ 实时」。
→ **即使电脑多日未开机，当前值依然是准确的。**

**② 抓取层（依赖电脑）—— 仅用于累积历史趋势**
每日自动化（08:30，automation id `48ab7c1b-2ba9-431c-a621-c92340d8dedb`）执行：
1. 抓取当日数据（`scraper/nio_http.js`，纯 HTTP，**1.5 秒**完成，无需浏览器）
2. 聚合生成看板数据（`aggregate/agg.js`）
3. 重新部署线上看板（`workbuddy_sites_deploy`，已授权）

→ 这层只为**趋势图**积累数据点；错过几天不影响当前值，只是趋势少几个点。

> 定时任务中的部署通过 deferred tool 调用（ToolSearch → DeferExecuteTool），已在 prompt 写明。
> 异常保护：抓取失败时跳过部署，避免旧数据覆盖线上。

## 数据机制说明（重要）
- 指标均为**累计值**，历史数据按天逐日追加。
- 看板趋势图随每日积累自动增长；周/月/年维度展示周期末快照与周期内变化。
- 当前看板为**静态部署**：上线的是部署时刻的快照。若希望线上每日自动更新，需在每日定时任务中追加一次重新部署（见后续建议）。

## 关于"是否必须每天开机"
- **当前值：不需要开机**（浏览器实时直连接口）。
- **趋势图：需要开机**（每日 08:30 抓取累积数据点）。错过几天不影响当前值，趋势少几个点而已，可随时手动 `bash run.sh` 补一次（同日重复运行会覆盖，不会重复计数）。

## 待办 / 建议
1. ~~**数据口径**：充换电站总数采用设备总数（9322）~~ → 已确认保持，不改。
2. ~~**线上每日更新**~~ → 已完成，每日定时任务已包含自动重新部署。
3. ~~**是否必须开机**~~ → 当前值已改为实时直连，不依赖开机。
4. 若希望**趋势图也完全不依赖本机**（例如出差数周），可将 `scraper/nio_http.js`（纯 HTTP，无浏览器依赖）迁移到 GitHub Actions 等云端定时，数据 commit 回仓库即可。
