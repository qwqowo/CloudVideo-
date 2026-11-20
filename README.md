# CloudVideo — 小盘云端种子下载与在线影院

专为 **50–60 GB 小容量 VPS** 设计的自托管云端视频站，基于 **Docker Compose（Node.js 22 + React + FFmpeg + qBittorrent）** 一键部署。

## 核心特性

- **极简科幻影院 UI + 真实多帧封面 + 可选 TMDB 刮削**：黑曜石工业遥测风海报网格，FFmpeg 自动避黑屏抽取 16:9 封面（悬停卡片自动轮播 3 帧预览），支持填入可选 TMDB API Key/Token 自动刮削中文片名、高清剧照、评分与简介，支持批量管理与 PWA 手机端全屏安装。
- **小盘追剧托管（Binge Auto-Pilot）+ 边下边播**：默认开启顺序下载 + 首尾分片优先；大合集开启「小盘追剧托管」后自动仅下载前 N 集（默认 2 集），看到 70% 自动预载下一集，看完按策略卸载，50–60 GB 硬盘丝滑追完 100 GB+ 整季剧集。
- **默认原生直出 + 影院播放器 + 桌面/移动外链**：
  - 默认零 CPU 原生 HTTP Range 206 直出，遇到浏览器不支持的 MKV / AC3 / DTS 可一键切至 **FFmpeg 无损 Remux**。
  - 支持**直接上传本地 `.srt/.ass/.vtt` 外挂字幕**与实时字幕时间轴偏移（`±0.5s`）、边下边播实时码率 vs 下载速度监控、全套键盘快捷键（`Space`/`←→`/`↑↓`/`[]`/`F`/`M`/`N`）与片尾一键「卸载本集并连播下一集」。
  - 一键拉起 **PotPlayer / IINA / MPV / Infuse / VLC / nPlayer** 或复制 12 小时签名直链（VidHub）。
- **看完自动卸载 + 水位 LRU 保护 + 清理审计日志**：
  - 达到进度阈值（默认 `90%`）后进入可调缓冲期（默认 `24h`，可调 `0h` 立即删除），超水位上限（默认 `45 GB`）自动按 LRU 淘汰未锁定文件至 85%；每次自动与手动清理均记入「清理审计日志」透明可查。
- **BT 加速与离线通知**：支持在网页一键注入公共高速 Tracker、可视化配置 HTTP/SOCKS5 代理、以及下载完成自动发送 **Telegram Bot / Webhook** 推送。
- **内置节点带宽测速仪 & 公网安全**：纯内存不可压缩随机流测速（Ping + 单线程 + 4 线程实时示波曲线与 1080p/4K 评级）；单密码登录（带 5 次输错防爆破锁定 15 分钟），qBittorrent WebUI 仅限 Docker 内网访问。

---

## 快速部署（VPS / Docker Compose）

### 1. 服务器优化（强烈推荐：开启 BBR）

视频播放对单线程吞吐极其敏感，建议先在 Linux VPS 开启 Google BBR：

```bash
echo "net.core.default_qdisc=fq" | sudo tee -a /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### 2. 配置环境变量并启动

```bash
cp .env.example .env
# 编辑 .env，务必修改 APP_PASSWORD、JWT_SECRET 和 STORAGE_LIMIT_GB（50-60GB 硬盘建议设为 40~45）
nano .env

docker compose up -d --build
```

启动完成后打开浏览器访问：`http://<你的服务器IP>:3000`。

> **提示**：首次启动时，`scripts/qbittorrent-init.sh` 会自动在 `./data/qbittorrent/config` 中配置内网白名单和禁用预分配，无需手动去查 qBittorrent 临时密码。

---

## 搭配 Nginx / Caddy 反向代理（重要）

如果你套了 HTTPS 域名反代，**务必关闭流式接口缓冲**，否则边下边播和测速曲线会不准或卡顿：

### Nginx 示例

```nginx
server {
    listen 443 ssl http2;
    server_name video.example.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 关键：关闭大视频与测速流的反代缓存/缓冲
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

---

## 节点测速与清晰度对照参考

| 单线程稳定速度 | 等效下载速度 | 推荐清晰度 |
| :--- | :--- | :--- |
| `< 10 Mbps` | `< 1.25 MB/s` | 1080p 易卡顿，建议切换中转节点或检查 BBR |
| `10 – 28 Mbps` | `1.25 – 3.5 MB/s` | 流畅 1080p 流媒体（Web-DL / BDRip） |
| `28 – 75 Mbps` | `3.5 – 9.4 MB/s` | 流畅 4K 流媒体 & 1080p 高码率 Remux |
| `≥ 75 Mbps` | `≥ 9.4 MB/s` | 畅享 4K 原盘 / Remux |

---

## 本地开发与测试

需要 Node.js 22+ 与 `ffmpeg`：

```bash
# 后端编译与自动化测试
cd server
npm install
npm run build
npm test

# 前端编译
cd ../web
npm install
npm run build
```

---

## 注意事项

- **欧美 VPS 版权风险（DMCA）**：若你的服务器位于德国、美国等对公开 BT 审查严格的机房，请勿裸跑热门公开种子，建议选用抗投诉机房、仅使用私密 PT，或在宿主机/容器层为 BT 流量配置合规出口代理。
- **上传限速**：默认限制 BT 上传为 `512 KB/s` 且下完自动停种（可在「清理与设置」页实时调整；若使用 PT 请关闭“下完自动停种”）。
