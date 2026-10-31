# 到期台账 Expiry

以虎 One 官方应用：合同、证照、资质、保险、设备的到期日一本账，还剩几天一眼看清，到期前主动提醒。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。

## 本地运行

```bash
cp .env.example .env   # 填 DATABASE_URL
npm install
node --env-file=.env src/server.js
```

不配 `YH_*` 时以「本地用户」单人运行，只在 `NODE_ENV` 不是 `production` 时生效；生产环境没配平台凭证会拒绝服务，不退回匿名。

## 测试

```bash
npm test     # 真实 MySQL：没给 TEST_DATABASE_URL 就用 Docker 起临时库，跑完删掉
npm run e2e  # Playwright：独立实例（3180）+ 临时库，经 /apps/expiry 前缀访问，截图在 artifacts/e2e/
../yihu-one/yh check . --strict
```

## 约定

- 权限只在 `src/items.js`：看得到的是自己创建的和自己负责的，其余 404；负责人只读，改动 403
- 下载附件例外：不存在和无权限都回 403，不能靠状态码探测 id
- 版本号只写在 `yh-app.json` 和 `package.json`，页面、`/health`、MCP 都读清单
- 日期只在 `src/dates.js` 里算，「今天」按 `EXPIRY_TZ`（默认 Asia/Shanghai），不用数据库的 `CURDATE()`
- 分档只有 `tierOf` 一处：已过期 / ≤7 红 / ≤30 黄 / 其余灰，列表颜色和提醒去重共用。统计里「30 天内」包含「7 天内」
- 改表：`src/db.js` 的 `ADDED_COLUMNS` 登记新列，要可空或有默认值（回滚不回库）
- `src/yh-one.mjs` 是平台 SDK 的拷贝，不要改

## 附件

- 存在 `EXPIRY_DATA_DIR`（默认 `/data`）的 `attachments/<id>-<hash>.<ext>`，盘上文件名全部由服务端生成；类型看文件头，不信扩展名
- 上传是 `PUT /api/items/:id/attachment`，请求体就是文件，文件名放 `X-File-Name`（URL 编码），不引入 multipart 依赖
- 镜像不写 `USER node`：`/data` 是平台的绑定挂载，服务器上属主是 root。`server.js` 以 root 启动，接管 `attachments/` 后立即降到 node

## 提醒

- 进程内定时器每小时醒一次，当地 09:00 后当天第一次醒来扫一遍；错过 09:00（进程没活着）当天补一次
- 只有平台明确返回 `sent` 才写 `last_notified_at`。`skipped` 的人没收到，不记档
- `/settings` 用空 `userIds` 探测发消息权限：平台先查可信（403）再查参数（400），不会发出任何消息
