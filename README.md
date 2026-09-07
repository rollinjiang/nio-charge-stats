# NIO 充换电站指标看板

每天 08:30 (CST) 自动从蔚来官网充电地图公开接口抓取四个关键指标，生成日/周/月/年四维度趋势的云端看板。

> 在线看板：见 `index.html`，可通过 WorkBuddy 部署或 GitHub Pages 托管。
> 数据接口：`chargermap-fe-gateway.nio.com/.../indicator/basic/summary`（无需登录，无需绕过 WAF，裸 HTTP 即可）。

## 关键指标

| 指标 | 字段代码 | 含义 |
|---|---|---|
| 蔚来能源充换电站总数 | `power_swap_charge_device_num_total` | 换电站 + 充电站（累计） |
| 蔚来能源充电站数量 | `power_charge_station_device_num_total` | 充电站座数（累计） |
| 换电站数量 | `swap_station_num_for_com` | 换电站座数（累计） |
| 高速公路换电站 | `intercity_swap_station_num` | 城际高速换电站座数（累计） |

## 目录结构

```
.
├── index.html              # 静态看板 (ECharts)
├── scraper/nio_http.js     # 抓取脚本 (纯 HTTP，无需浏览器)
├── aggregate/agg.js        # 聚合脚本 (日/周/月/年)
├── data/                   # 历史数据 (由 Actions 维护)
│   ├── history.json
│   └── dashboard.json
├── .github/workflows/
│   └── daily.yml           # GitHub Actions 定时任务
├── run.sh                  # 本地一键运行 (抓取+聚合)
└── overview.md             # 项目交付说明
```

## 本地运行

```bash
bash run.sh
```

## 云端自动更新 (GitHub Actions)

每天 UTC 00:30 (CST 08:30) 触发 `daily.yml`，自动抓取 + 聚合 + 提交到 main 分支。

可手动触发：GitHub → Actions → Daily NIO stats → Run workflow。

> GitHub Actions cron 通常有 5-30 分钟延迟，是平台机制限制。

## 数据源看板 (可选)

打开 `index.html` 后，看板数据按以下优先级加载：

1. **远程**（如配置）：`<REMOTE_DATA_BASE>/dashboard.json`
2. **本地**：`data/dashboard.json`

如希望 workbuddy 部署的看板读取 GitHub 仓库数据自动更新（无需重新部署），在 `index.html` 顶部修改 `REMOTE_DATA_BASE`：

```js
const REMOTE_DATA_BASE = 'https://raw.githubusercontent.com/<user>/<repo>/main/data';
```

> raw.githubusercontent.com 返回 `access-control-allow-origin: *`，浏览器可跨域直连，无缓存。

## 启用 GitHub Pages（可选）

`Settings → Pages → Source: Deploy from a branch → main / root`

Pages 启用后，访问 `https://<user>.github.io/<repo>/` 即可看到看板。

## License

MIT
