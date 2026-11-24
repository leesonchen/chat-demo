# Chat Demo 账号与云端备份服务

本服务为 chat-demo 提供微信服务号扫码登录、账号 API Key 保存和手动聊天记录云端备份。未部署服务端时，原有本地聊天功能仍可独立使用。

## 生产环境信息

- 网站域名：`https://deepseek.leeson.top`
- API：`https://deepseek.leeson.top/api/`
- 微信 OAuth 回调：`https://deepseek.leeson.top/api/auth/wechat/callback`
- 微信服务号 AppID：`wx1713b39983b65190`
- 微信授权方式：公众号网页授权 `snsapi_base`

此版本直接使用现有已认证微信公众号（服务号），不需要微信开放平台网站应用，也不需要接管公众号消息推送服务器。原先的 `wx1.leeson.top/wx` 消息推送服务不再参与 chat-demo 登录流程。

## 微信公众平台准备

1. 使用现有服务号 AppID：`wx1713b39983b65190`。
2. 在「设置与开发 → 公众号设置 → 功能设置 → 网页授权域名」中配置 `deepseek.leeson.top`。
3. 将微信提供的 `MP_verify_xxx.txt` 放在该域名网站根目录，保证 `https://deepseek.leeson.top/MP_verify_xxx.txt` 可访问，然后完成校验。用户已完成校验时无需重复操作。
4. 从现有服务端配置或安全凭据库中找回当前服务号 AppSecret。不要为了本项目直接重置 AppSecret；若确实遗失，先确认其他现存业务是否依赖它，再统一更新。
5. 不要修改现有公众号消息推送 URL、Token、EncodingAESKey 或 IP 白名单。本登录流程使用网页 OAuth，不使用公众号消息推送回调。

## 配置服务端

在仓库根目录执行：

```sh
cp server/.env.example server/.env
chmod 600 server/.env
```

编辑 `server/.env`：

- `APP_ORIGIN=https://deepseek.leeson.top`
- `WECHAT_APP_ID=wx1713b39983b65190`
- `WECHAT_APP_SECRET`：现有服务号 AppSecret。
- `WECHAT_REDIRECT_URI=https://deepseek.leeson.top/api/auth/wechat/callback`
- `API_KEY_ENCRYPTION_KEY`：使用 `openssl rand -base64 32` 生成 32 字节密钥。
- `DATA_DIR`：SQLite 数据库和 ZIP 备份的持久化目录。

**必须单独、安全备份 `API_KEY_ENCRYPTION_KEY`。** 数据库只保存 API Key 的 AES-256-GCM 密文；丢失加密密钥后无法恢复已保存的 API Key。不要将 `.env`、数据库或备份文件提交到 Git。

## 启动与反向代理

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

服务端默认监听 `127.0.0.1:8091`。Nginx/Caddy 应为 `deepseek.leeson.top` 配置 HTTPS，并将同域名的 `/api/` 转发到 `127.0.0.1:8091`，其他路径提供静态 `dist/` 文件。

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name deepseek.leeson.top;

    root /var/www/chat-demo/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8091;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 200m;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

服务端默认绑定 loopback，不应直接暴露到公网。正式环境设置 `NODE_ENV=production`，以启用 Secure Cookie。微信 OAuth 回调必须使用 HTTPS。

## 微信扫码登录流程

1. 电脑端请求服务端创建一次性登录事务。
2. 前端生成二维码，二维码内容是微信服务号网页授权 URL。
3. 手机微信扫码后，通过 `snsapi_base` 静默授权并回调到 chat-demo。
4. 服务端用 AppID、AppSecret 和一次性 code 换取 OpenID。
5. 电脑端使用独立的轮询密钥领取登录会话。二维码 state、电脑端轮询 ticket 和轮询密钥彼此分离，均有短有效期且只能使用一次。

`snsapi_base` 只提供 OpenID，不返回昵称和头像；首次登录的用户先显示为「微信用户」。如果未来确实需要头像和昵称，再单独评估 `snsapi_userinfo` 的用户授权体验。

## 数据行为

- SQLite 数据库：`DATA_DIR/chat-demo.sqlite`。
- 云端备份：`DATA_DIR/backups/`，每个用户保存一份 ZIP 快照。新导出会替换该用户旧快照。
- 恢复云端备份会整体替换当前设备本地历史，不做合并。
- ZIP 保留完整消息树和本地可用的图片原件；非图片附件原件沿用现有导出行为，仅保留元数据。
- API Key 使用 AES-256-GCM 加密保存，不进入聊天 ZIP 或请求日志。登录后通过认证 HTTPS 会话恢复到浏览器，DeepSeek 聊天请求仍由浏览器直接发送。
- 本阶段不做自动同步、实时多设备协作、冲突合并、QQ 登录或公众号消息推送回调。

## 验证

```sh
pnpm type
pnpm lint
pnpm server:test
pnpm build
```

## 备份与恢复

备份时需要同时考虑 `DATA_DIR/chat-demo.sqlite` 和 `DATA_DIR/backups/`。服务运行期间不要直接复制 SQLite 主文件作为一致性备份；应先停止服务，或使用 SQLite 感知的备份工具。加密密钥需另行安全保存。
