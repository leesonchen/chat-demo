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
- Chat Demo 保存会员、订单和有效期。签约、续费、解约、回调验签、查单和对账也属于 Chat Demo 的支付后端。支付渠道与登录账号通过本应用的订单关联。支付宝付款无需和微信公众号建立关联。
- 商户号、AppID、支付签约模板或产品标识、通知地址、私钥和证书应由部署配置提供。应用从服务器环境文件或服务器专用文件读取；仓库提交空值示例，密钥不进入浏览器日志、前端构建或共享认证服务。

### 预览与验收

`MEMBERSHIP_MODE` 默认 `off`，现有云备份正常使用。测试环境可设为 `preview` 显示价格和账号状态，或设为 `required` 验收服务端拦截。当前已有订单及会员有效期逻辑，在线付款和续费仍待接入实际商户产品。生产启用门槛前，先验收签约、首笔付款、续费、取消、失败及重复通知。

支付适配器必须确认通知签名，核对收款商户、商户订单号、渠道交易号、金额和币种，之后才调用 `settleMembershipOrder`。浏览器跳转、扣款请求受理和签约成功各自不能证明款项已到账。相同渠道交易重复上报只入账一次。延期使用中国时区的日历月，连续续费保留原扣款日并在较短月份取月末。

### 微信支付开通

1. 用普通商户的超级管理员登录 [微信支付商户平台](https://pay.weixin.qq.com/)。在「产品中心」查看「委托代扣／自动续费」和「Native 支付」状态。公众号后台有已关联商户号，只确认关联关系。按[官方申请指引入口](https://pay.wechatpay.cn/doc/v2/merchant/4011987907)申请自动续费权限和月扣模板。
2. 向微信确认网页桌面扫码的 **Native 支付中签约** 是否可用于本商户及模板。申请写明「Chat Demo 聊天历史云备份与恢复，¥1/月，自愿开通，可随时取消」。确认金额下限、月扣模式、扣费前通知、首笔支付、解约通知及退款流程。微信文档列出了[支付中签约](https://pay.wechatpay.cn/doc/v2/merchant/4011987320)和[两种周期扣费模式](https://pay.wechatpay.cn/doc/v2/merchant/4011986682)。若计划从手机外部浏览器直接发起纯签约，也要核对[该场景的独立权限](https://pay.wechatpay.cn/doc/v2/merchant/4011987295)。
3. 审核后记录产品及模板状态、适用渠道、扣费模式和控制台提供的接口文档。签约前显著告知周期、价格、下一次扣费和取消途径，按模板正确下发扣费前通知。微信的免密规则也要求同时提供容易区分的主动单次支付入口。以[当前微信支付运营规则](https://pay.wechatpay.cn/doc/v3/merchant/4012645700)和商户协议为准。

### 支付宝开通与应用关联

1. 在[支付宝商家平台](https://b.alipay.com/)使用企业支付宝账号办理企业认证。按[支付宝公司认证资料说明](https://help.alipay.com/support/help_detail.htm?help_id=425157)准备营业执照、法人或授权经办人资料及同名对公账户。在支付宝官方后台提交。
2. 在[支付宝开放平台](https://open.alipay.com/platform/accessProcessPage.htm)用同一企业主体创建自用型应用，按网站实际接入方式选择「网页与移动应用」下的网站场景。根据审核页面填写业务网址、经营类目、客服及所需网站资质。将产品签约和收款绑定到这个支付宝应用。
3. 在应用的「产品能力」或商家平台产品中心核对「商家扣款／周期扣款」。如果经营类目符合，也可以按[支付宝 AI 连续订阅开通指南](https://aipay.alipay.com/docs/subscribe/introduce.html)申请自带订阅管理页的方案。两种产品的接口和参数不同，以实际审核通过的能力为准。用「固定 ¥1/月、网页下单、用户在支付宝自愿签约、可解约」描述业务并确认最低金额。商家扣款审核通过后需要将产品启用在对应应用上，采用 AI 连续订阅时按其指南办理代调用授权并配置月度价格。
4. 记录产品名称、批准状态、允许的网页场景和后台给出的接口及参数。按获批产品配置 RSA2 或证书、签约及扣款通知和解约；签约产品码以平台分配为准。可参考[支付宝 H5 周期扣款指南](https://aipay.alipay.com/article/4034)。

两个渠道上线前都需要在签约前和续费前显著提醒，并提供方便的取消或变更入口。解约成功后停止未来扣款，已付且有效的服务期保留。提醒与取消依据[《网络交易监督管理办法》第十八条](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2025/art_4b47c79b8d994a42bba4835997688faa.html)及平台要求确定。

## 验证

```sh
pnpm type
pnpm lint
pnpm server:test
pnpm build
```

## 备份与恢复

备份时需要同时考虑 `DATA_DIR/chat-demo.sqlite` 和 `DATA_DIR/backups/`。服务运行期间不要直接复制 SQLite 主文件作为一致性备份；应先停止服务，或使用 SQLite 感知的备份工具。加密密钥需另行安全保存。
