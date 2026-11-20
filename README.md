# CloudVideo — 小盘云端种子下载与在线影院

专为 **50–60 GB 小容量 VPS** 设计的自托管云端视频站，基于 **Docker Compose（Node.js 22 + React + FFmpeg + qBittorrent）** 一键部署。

## 核心特性

- **顺序下载 · 边下边播**：通过 qBittorrent 默认开启顺序下载 + 首尾分片优先，支持磁力链接 / `.torrent` 上传，大合集支持**先暂停后按需勾选单集**，避免整季撑爆硬盘。
- **网页无损 Remux + 一键本地播放器**：
  - 兼容 MP4/WebM 时零 CPU 原生 HTTP Range 206 直出。
  - 遇到 BT 常见的 MKV / AC3 / DTS 时自动切换 **FFmpeg 无损换封装**（视频流 `-c:v copy` 不吃 CPU，仅音轨转 AAC，同时支持内封/外挂 SRT/ASS 字幕转 WebVTT）。
  - 一键生成 12 小时签名直链，直接拉起 **PotPlayer / IINA / MPV / Infuse / VidHub / VLC**，通吃 H.265 / HDR / 杜比音轨与特效字幕。
- **看完自动卸载 + 磁盘水位 LRU 保护**：
  - 播放进度达到阈值（默认 `90%`）后进入可调缓冲期（默认 `24 小时`，可改为 `0` 看完立刻删除），单集精准卸载释放空间；整包全部看完后自动清理种子。
  - 设置存储硬上限（默认 `45 GB`），超限时自动按优先级 + LRU 淘汰未锁定文件至安全水位；支持给想回看的视频点「锁定防删」。
- **内置节点带宽测速仪**：
  - 纯内存随机不可压缩数据流直出，一键测出「当前节点 ↔ 这台服务器」的延迟、单线程（浏览器看片）和 4 线程（本地播放器缓冲）速度，自动给出 **1080p / 4K 流畅度评级**，并保存历史对比不同代理节点。
- **公网安全**：单密码登录保护（HttpOnly Cookie），qBittorrent WebUI 仅限 Docker 内网访问，不暴露到公网。

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
