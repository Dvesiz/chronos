# Chronos 后端第一版设计

日期：2026-10-29
状态：已确认，进入实现

## 目标

为 Chronos 增加真实邮箱验证码账号、个人多设备同步、用户反馈和版本检查，同时保持现有本地优先体验。用户未登录或网络不可用时，计划、计时、统计和导入导出必须继续可用。

## 技术选型

- Cloudflare Workers：HTTP API、鉴权、同步和邮件调用。
- Cloudflare D1：用户、验证码、会话、同步快照、同步事件、反馈和版本信息。
- Resend HTTP API：发送邮箱验证码。API Key 只通过 Worker Secret 注入。
- 暂不使用 R2：Chronos 状态规模较小，第一版 JSON 快照和事件直接存 D1。
- GitHub Pages：继续提供官网和 `/app/` 在线体验，不迁移现有静态站点。

## 账号与安全

登录方式为邮箱验证码。验证码 10 分钟有效、最多尝试 5 次、使用后立即失效；数据库只保存验证码摘要。登录成功返回短期访问令牌和长期刷新令牌，D1 只保存刷新令牌摘要，支持退出登录和设备撤销。

Resend 发件地址为 `system@mail.donghangyu.dpdns.org`。现有配置文件中的 Resend、MySQL、Redis、S3 和 Turnstile 凭据已经暴露，部署前必须全部轮换；任何密钥都不得进入仓库、前端、APK 或日志。

API 只允许 HTTPS，CORS 只允许 GitHub Pages 官网和在线体验域名。验证码接口需要邮箱/IP 限流；Turnstile 作为后续可选的发信前挑战，不在第一版无效接入。

## 同步模型

采用个人多设备事件同步，不做多人协作和永久审计。客户端继续以 `localStorage` 中的 `chronos.state.v1` 作为运行数据源。每次本地保存产生操作事件，事件进入本地队列，网络恢复后批量上传。

事件包含：

- `eventId`：客户端生成的幂等 ID；
- `deviceId`：设备标识；
- `baseSeq`：客户端上次确认的服务器序号；
- `ops`：`set` / `remove` 操作列表；
- `clientAt`：客户端时间。

Worker 按接收顺序分配递增 `serverSeq`，重复 `eventId` 不重复应用。D1 同时保存当前状态快照和事件日志。冲突采用已确认的 Last-write-wins：服务器接收较晚的事件覆盖同一字段，响应中返回云端较新提示；不同字段的操作可以继续合并。

## API

- `POST /v1/auth/send-code`
- `POST /v1/auth/verify`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `POST /v1/sync/events`
- `GET /v1/sync/head`
- `GET /v1/sync/events?after=<seq>`
- `GET /v1/sync/snapshot`
- `POST /v1/feedback`
- `GET /v1/app/latest`

## 迁移流程

1. 老用户无需登录，原有本地状态不变。
2. 首次登录时，如果云端没有数据，将本地状态作为初始快照上传。
3. 如果云端已有数据，客户端展示本地/云端摘要，由用户选择后再同步。
4. 退出登录只清除令牌，不删除本地学习数据。
5. 删除账号时删除用户、快照、事件和会话。
6. JSON 导入导出始终保留，作为用户可控的最后备份。

## 实施顺序

1. Worker 和 D1 迁移骨架。
2. 验证码、会话和同步接口。
3. App 本地优先同步适配。
4. 反馈和版本检查。
5. 本地测试、部署文档和密钥轮换清单。
