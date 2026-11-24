# Chat Demo 账号与云端备份服务

本服务为静态 chat-demo 增加可选的微信扫码登录、账号 API Key 保存和手动聊天记录云端备份。没有部署服务端时，原有本地聊天功能仍然可以独立使用。

## 运行要求

- Node.js 22.12 或更新版本。
- pnpm。
- 微信开放平台的网站应用，已启用网站应用微信扫码登录。
- 正式环境使用 HTTPS，前端与 API 使用同一域名。

## 微信开放平台准备

1. 在微信开放平台创建或选择「网站应用」。
2. 启用网站应用微信登录，确认获得 AppID 和 AppSecret。
3. 配置授权回调域名。回调 URL 默认是 `https://你的域名/api/auth/wechat/callback`。
4. 确保前端域名、`APP_ORIGIN` 和回调 URL 使用同一站点；服务端会用短期 HttpOnly Cookie 绑定 OAuth state。

## 配置服务端

在仓库根目录执行：

```sh
cp server/.env.example server/.env
```

编辑 `server/.env`：

- `APP_ORIGIN`：前端站点源，例如 `https://chat.example.com`，不要附加路径。
- `WECHAT_APP_ID` / `WECHAT_APP_SECRET`：网站应用凭据。
- `WECHAT_REDIRECT_URI`：必须与微信开放平台配置的回调地址完全一致。
- `API_KEY_ENCRYPTION_KEY`：使用 `openssl rand -base64 32` 生成 32 字节密钥。
- `DATA_DIR`：SQLite 数据库和 ZIP 备份的持久化目录。

**必须单独、安全备份 `API_KEY_ENCRYPTION_KEY`。** 数据库只保存 API Key 的 AES-256-GCM 密文；丢失加密密钥后无法恢复已保存的 API Key。不要将 `.env`、数据库或备份文件提交到 Git。

## 启动与反向代理

```sh
pnpm server
pnpm dev
```

- 前端开发服务器默认监听 `http://localhost:8090`。
- 后端默认监听 `127.0.0.1:8091`。
- Rspack 开发服务器已将 `/api/` 代理到后端。
- 生产环境应由 Nginx、Caddy 等将同域名的 `/api/` 转发到 `127.0.0.1:8091`，其余路径提供静态 `dist/` 文件。

服务端默认绑定 loopback，不应直接暴露到公网。生产环境设置 `NODE_ENV=production`，以启用 Secure Cookie。

## 功能与数据行为

- 微信 OpenID 是当前登录身份；首次扫码自动创建用户。身份表按 provider 设计，为后续 QQ 身份绑定预留扩展点。
- 登录后服务端会向已认证浏览器返回该账号自己的 API Key，恢复到现有本地设置。DeepSeek 聊天请求仍由浏览器直接发送，不经过本服务端。
- API Key 使用 AES-256-GCM 加密保存，聊天 ZIP 不包含 API Key。
- 每个账号只保存一份聊天 ZIP 快照。「导出到服务器」替换该账号之前的云端快照；「从服务器导入」会先校验归档，再通过本地暂存导入流程整体替换当前设备历史，不做合并。
- ZIP 沿用现有导出格式：保留完整消息树和本地可用的图片原件；非图片附件原件仍按现有格式只保留元数据。
- 备份文件和数据库目录使用受限文件权限，但 ZIP 聊天内容本身没有额外应用层加密；请按敏感数据保护服务器和备份目录。
- 本阶段不做自动同步、实时多设备协作、冲突合并、QQ 登录或账号删除。

## 验证

```sh
pnpm type
pnpm lint
pnpm server:test
pnpm build
```

## 备份与恢复

备份时需要同时考虑 `DATA_DIR/chat-demo.sqlite` 和 `DATA_DIR/backups/`。服务运行期间不要直接复制 SQLite 主文件作为一致性备份；应先停止服务，或使用 SQLite 感知的备份工具。加密密钥需另行安全保存。
