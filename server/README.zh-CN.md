# Chat Demo 账号与云端备份服务

本服务为 chat-demo 提供微信服务号扫码登录、账号 API Key 保存和手动聊天记录云端备份。未部署服务端时，原有本地聊天功能仍可独立使用。

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

1. 在 Chat Demo 点「微信扫码登录」，跳到独立认证服务的二维码页面。
2. 手机扫码成功后，电脑回到 Chat Demo，并带回一个一次性登录码。
3. Chat Demo 校验浏览器的登录状态，再用自己的客户端凭据和 PKCE 凭证兑换身份，创建本地会话。

Chat Demo 会先核对认证结果里的 AppID，再用 OpenID 找回原账号。API Key 和云备份仍归属该账号。如需昵称和头像，在独立认证服务的客户端配置中为 Chat Demo 开启资料授权。用户可在扫码页面主动勾选，Chat Demo 保存授权返回的昵称和头像。普通扫码会保留此前已保存的资料。

## 数据行为

- SQLite 数据库：`DATA_DIR/chat-demo.sqlite`。
- 云端备份：`DATA_DIR/backups/`，每个用户保存一份 ZIP 快照。新导出会替换该用户旧快照。
- 恢复云端备份会整体替换当前设备本地历史，不做合并。
- ZIP 保留完整消息树和本地可用的图片原件；非图片附件原件沿用现有导出行为，仅保留元数据。
- API Key 使用 AES-256-GCM 加密保存，不进入聊天 ZIP 或请求日志。登录后通过认证 HTTPS 会话恢复到浏览器，DeepSeek 聊天请求仍由浏览器直接发送。
- 本阶段不做自动同步、实时多设备协作、冲突合并、QQ 登录或公众号消息推送回调。

## 会员与支付

云备份会员方案为 **人民币 ¥1 / 月**。采用会员门槛时，Chat Demo 后端会在上传云备份和下载恢复时校验有效期。会员到期后保留既有快照，本地聊天、API Key 和本地 ZIP 导入导出维持原有用法。

- `auth` 服务验证微信身份，按用户授权返回 OpenID 和可选资料。
- Chat Demo 保存会员、订单和有效期。支付由 Chat Demo 下单、验签、查单和发放权益，通过订单关联登录账号。
- 商户号、AppID、支付签约模板或产品标识、通知地址、私钥和证书应由部署配置提供。应用从服务器环境文件或服务器专用文件读取；仓库提交空值示例，密钥不进入浏览器日志、前端构建或共享认证服务。

### 微信 Native 单次支付

用户在「设置 → 数据管理」打开微信支付二维码。服务端按 100 分下单，付款后会员开通或延长一个日历月。二维码有效期为十分钟，未过期的待付款订单可重复打开。微信通知延迟时可点击「查询支付结果」。

1. 在微信支付商户平台开通「Native 支付」，并确认公众号 AppID 和商户号已经关联。
2. 在「账户中心 → API 安全」准备商户 API 证书、APIv3 密钥，以及微信支付公钥或当前使用的平台证书。按 `.env.example` 的 `WECHAT_PAY_*` 配置，区分商户证书序列号和微信支付公钥 ID（使用平台证书时填其序列号）。将私钥和 APIv3 密钥文件保存在仓库之外，仅授予后端服务用户读取权限。微信支付公钥模式需与商户当前验签设置一致。详见 [微信支付开发必要参数](https://pay.wechatpay.cn/doc/v3/merchant/4013070756)。
3. 设置 `WECHAT_PAY_ENABLED=1` 与 `MEMBERSHIP_MODE=preview`，用一个测试账号完成 ¥1 实付验证。反向代理应将 `POST /api/payments/wechat/native/notify` 转发到应用保留原始请求体及微信签名头部。通知地址由 `APP_ORIGIN` 自动生成。
4. 实付确认后可切换 `MEMBERSHIP_MODE=required`，让云备份的上传和恢复检查会员有效期。默认 `MEMBERSHIP_MODE=off` 时隐藏支付入口。

后端对微信回调和查单应答验签，核对应用、商户、订单、金额及币种，确认支付成功后结算。付款通知和查单结果按同一订单幂等处理。自动续费待微信委托代扣审核通过后接入，支付宝单次支付待应用审核及产品关联后接入。

## 验证

```sh
pnpm type
pnpm lint
pnpm server:test
pnpm build
```

## 备份与恢复

备份时需要同时考虑 `DATA_DIR/chat-demo.sqlite` 和 `DATA_DIR/backups/`。服务运行期间不要直接复制 SQLite 主文件作为一致性备份；应先停止服务，或使用 SQLite 感知的备份工具。加密密钥需另行安全保存。
