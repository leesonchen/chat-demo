# Chat Demo 账号与云端备份服务

本服务为 chat-demo 提供微信登录、账号 API Key 保存和手动聊天记录云端备份。未部署服务端时，原有本地聊天功能仍可独立使用。

## 注册认证客户端

在独立微信认证服务中为 Chat Demo 登记客户端 ID、独立密钥和完整的 HTTPS 回调地址，例如 `https://chat.example.com/api/auth/wechat/callback`。这是认证服务将电脑浏览器送回 Chat Demo 的地址。公众号后台的网页授权域名配置认证服务本身的主机名。

## 配置服务端

在仓库根目录执行：

```sh
cp server/.env.example server/.env
chmod 600 server/.env
```

编辑 `server/.env`：

- `APP_ORIGIN=https://chat.example.com`
- `AUTH_SERVICE_ORIGIN=https://auth.example.com`
- `AUTH_CLIENT_ID` 和 `AUTH_CLIENT_SECRET`：在独立认证服务中登记的客户端凭据。
- `WECHAT_APP_ID`：已有 Chat Demo 账号所使用的微信服务号 AppID。
- `API_KEY_ENCRYPTION_KEY`：使用 `openssl rand -base64 32` 生成 32 字节密钥。
- `DATA_DIR`：SQLite 数据库和 ZIP 备份的持久化目录。

**必须单独、安全备份 `API_KEY_ENCRYPTION_KEY`。** 数据库只保存 API Key 的 AES-256-GCM 密文；丢失加密密钥后无法恢复已保存的 API Key。不要将 `.env`、数据库或备份文件提交到 Git。

## 启动与反向代理

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm server
```

服务端默认监听 `127.0.0.1:8091`。Nginx/Caddy 应为站点配置 HTTPS，并将同域名的 `/api/` 转发到 `127.0.0.1:8091`，其他路径提供静态 `dist/` 文件。

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

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

微信内打开网页版时，可以通过同一个服务号的网页授权直接返回 Chat Demo 并复用已有账号。用户可选择仅登录，或授权同步昵称和头像。已登录的用户可从账号菜单补同步，服务端会核对当前会话和微信身份。独立认证服务需要支持 `mode=wechat_browser`，同步资料还需要为该客户端配置 `allowProfile`。在普通浏览器中打开时，可以按下面的步骤扫码登录。

1. 在 Chat Demo 点「微信扫码登录」，跳到独立认证服务的二维码页面。
2. 手机扫码成功后，电脑回到 Chat Demo，并带回一个一次性登录码。
3. Chat Demo 校验浏览器的登录状态，再用自己的客户端凭据和 PKCE 凭证兑换身份，创建本地会话。

Chat Demo 会先核对认证结果里的 AppID，再用 OpenID 找回原账号。API Key 和云备份仍归属该账号。如需昵称和头像，在独立认证服务的客户端配置中为 Chat Demo 开启资料授权。用户可在扫码页面主动勾选，Chat Demo 保存授权返回的昵称和头像。普通扫码会保留此前已保存的资料。

## 启用 Android 微信登录

1. 在微信开放平台注册 Android 移动应用，开通微信登录。登记包名 `top.leeson.deepseek.chat` 和实际安装包的签名。调试包和发布包的签名可能不同，真机验证时使用登记过的签名。如果已经启用服务号登录，将移动应用和服务号绑定到同一个开放平台账号。[移动应用微信登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/WeChat_Login/Development_Guide.html)
2. 在服务端配置移动应用的 `WECHAT_MOBILE_APP_ID` 和 `WECHAT_MOBILE_APP_SECRET` 后重启。AppSecret 只存于服务端。Android App 读取公开 AppID，服务端用授权码向微信换取身份。
3. 在安装了微信的 Android 真机上点击「微信登录」，同意授权后应回到当前聊天并恢复账号。取消授权后可直接再次点击登录。

服务端可用已验证的 UnionID 找回对应旧账号。旧账号若只有服务号 OpenID，先用「扫码登录已有账号」进入，再从账号菜单点「关联 App 微信登录」。关联会沿用已有账号的 API Key 和云备份。微信授权后找不到匹配账号时，App 会让用户确认是否创建新账号。要让新建的 App 账号也能被网页扫码识别，独立认证服务的 `/exchange` 需要返回同一开放平台下经微信验证的 `unionid`。

## 数据行为

- SQLite 数据库：`DATA_DIR/chat-demo.sqlite`。
- 云端备份：`DATA_DIR/backups/`，每个用户保存一份 ZIP 快照。新导出会替换该用户旧快照。
- 恢复云端备份会整体替换当前设备本地历史，不做合并。
- ZIP 保留完整消息树和本地可用的图片原件；非图片附件原件沿用现有导出行为，仅保留元数据。
- API Key 使用 AES-256-GCM 加密保存，不进入聊天 ZIP 或请求日志。登录后通过认证 HTTPS 会话恢复到浏览器，DeepSeek 聊天请求仍由浏览器直接发送。
- 本阶段不做自动同步、实时多设备协作、冲突合并、QQ 登录或公众号消息推送回调。

## 会员与支付

登录后，在「设置 → 数据管理」点击「开始免费试用」，立即获得一个日历月的云备份会员。试用自动到期，到期后可以再次领取。会员有效期取试用和已有付费会员到期时间中较晚的一个。

设置 `MEMBERSHIP_MODE=required` 后，上传和恢复云备份需要有效会员。到期会保留已有云备份快照，本地聊天、API Key 和本地 ZIP 导入导出维持原有用法。`preview` 和默认的 `off` 允许所有已登录用户上传和恢复云备份。

新购买已暂停。如果还有已经创建的微信订单待结算，可保留现有 `WECHAT_PAY_*` 配置及 `POST /api/payments/wechat/native/notify` 的反向代理。后端继续验签、查单并发放对应会员权益。

## 验证

```sh
pnpm type
pnpm lint
pnpm server:test
pnpm build
```

## 备份与恢复

备份时需要同时考虑 `DATA_DIR/chat-demo.sqlite` 和 `DATA_DIR/backups/`。服务运行期间不要直接复制 SQLite 主文件作为一致性备份；应先停止服务，或使用 SQLite 感知的备份工具。加密密钥需另行安全保存。
