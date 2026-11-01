# CLAUDE.md

到期台账：以虎 One 官方应用。合同、证照的到期日一本账：导入文件由 AI 抽条目，人确认后入库，到期前提醒。Express 4 + EJS + 平台 SDK，MySQL 用 `mysql2/promise`，没有前端构建步骤。结构照 `../yihu-meeting`（官方应用的参考实现），平台约定以 `../yihu-one/CLAUDE.md` 为准。

## 结构

```
src/
  server.js        入口：先监听再连库，/health 如实反映启动状态
  app.js           只做接线：中间件 → 接口 → MCP → 页面；renderBoard 拼看板数据
  db.js            建表 + CHANGED_COLUMNS（改已有列）+ ADDED_COLUMNS（新增列）
  items.js         条目的全部读写。权限只在这一层，每条 SQL 带当前用户 id
  settings.js      每人一份的设置和分类，每次现读，改完即生效
  extract.js       AI 抽取：提示词 + 逐字段收敛，永不抛错
  import.js        上传文件 → 纯文字，失败分级
  import-worker.js 独立子进程里跑 mammoth / pdfjs
  export.js        CSV、Markdown
  present.js       库里的行 → 页面要的样子、筛选条件、日历格子
  reminder.js      每日提醒；attachments.js 附件落盘；about.js 关于页
  dates.js         日期只在这里算
  routes/          api.js、import.js、pages.js，保持薄
  views/           layout/head、foot 每页都有；partials/board 是列表和日历共用的局部
  public/yh-vi.css 令牌段（同步）+ 组件段（手写），三个应用一模一样，不要改
  public/app.css   本应用的排布和业务块
  public/app.js    公用交互；board.js、import.js、settings.js 各管一页
scripts/sync-vi.mjs   从平台同步令牌
scripts/real-model.mjs 对真实模型跑一次抽取
e2e/gates.mjs         发版门槛和截图
```

## 测试怎么跑

```bash
npm test                               # 真实 MySQL。没给 TEST_DATABASE_URL 就用 Docker 起临时库
npm run e2e                            # 同一种临时库跑 e2e/gates.mjs，产物在 artifacts/v0.2.3/（不进 git）
../yihu-one/yh check . --strict
node scripts/sync-vi.mjs --check       # 令牌和平台是否一致
```

假平台在 `test/support/fake-platform.mjs`，走真实 SDK 的登录流程，应用代码里没有测试后门。e2e 里的模型是固定回复，**验不了模型质量**；改提示词后要用 `scripts/real-model.mjs` 对真实模型跑一次。

## 约定

**界面**
- 颜色、圆角、字体只用 `var(--yh-*)`。`yh-vi.css` 令牌段以外不准出现十六进制色、渐变、投影，`test/vi.test.js` 会拦
- CSS 不用 id 选择器：`#add…` 这种会被十六进制检查误伤
- 剩余天数三色只在 `.days` 一处定义：已过期和 7 天内 `--yh-danger`，30 天内 `--yh-highlight`，其余 `--yh-text-3`。强调色全应用只用这一处
- 可点元素一律 ≥44px，桌面也一样；375 宽不横向滚动
- 空字段整行不显示，不写「未指定」。「未指定」只出现在筛选下拉里

**数据**
- 对外的到期日叫 `expire_at`，它是 `due_date` 的虚拟列，只写 `due_date`
- `due_date` 可以是 NULL：只有导入和本来就缺日期的条目能这样，`needs_date` 标记。NULL 的不进提醒，也不进任何时间窗口，排在列表最前
- 回滚只回代码不回库，新列要可空或有默认值。注意 v0.1.x 的代码读到 `due_date` 为 NULL 的行会报错：回滚前要先补日期或删掉这些行
- **文件和模型里的人名只是文字**（`owner_name`），不映射成 `assignee_id`，不授权。能看到条目的只有创建人和人工选的负责人，上传的文件不能给人开权限
- 分类每人一份，存在 `expiry_setting.categories`。老条目还在用、已不在清单里的分类（v0.1 的合同、证照等）自动并入清单，不迁移数据。「其他」是兜底，不能改名和删除
- 提醒几点发、发不发按收提醒的人的设置，每个整点扫一次；同一条目同一档位一天只提醒一次

**导入**
- 识别只出预览，什么都不落库，文件读完就丢。人确认后 `/import/commit` 才入库，服务端逐条重新校验，坏一条整批不进
- 模型的输出不直接用：分类不在清单回落「其他」，`needs_date` 由 `expire_at` 推出来，不信模型写的
- 失败分级：读不出字 → 422，文件名 + 一句原因；模型失败 → 200，`ok: false`，提示「自动识别失败，可以手动录入」；有缺憾 → `notices`
- 解析放子进程不放线程：线程撞上堆上限时 V8 可能直接 FATAL。子进程环境里没有数据库地址和平台凭证
- `pdfjs-dist` 锁在 5.4.624：6.x 要 Node 22，线上镜像是 Node 20。pdf 必须传 `cMapUrl`，否则中文是乱码
- PDF 抽出的部首字用 `fixRadicals` 归一。康熙部首走 NFKC，部首补充区（⻝⻁⻄）NFKC 不管，靠 `RADICAL_PAIRS` 查表
- 内存：解析时主进程加子进程峰值约 550MB，清单 `memory` 是 640m。调大并发（`WORKER_MAX`）要同时调它

**其他**
- 版本号：运行时只读 `yh-app.json`；`VERSION`、`package.json`、lock 靠测试校验一致，发版时四处一起改
- 上报（`ws.track`）不带原文，也不带文件名
- 附件的安全约束（≤10MB、类型白名单、防穿越、归属校验）在 `attachments.js`，导入的文件不走附件，不落盘
- `src/yh-one.mjs` 是平台 SDK 的拷贝，不要改
