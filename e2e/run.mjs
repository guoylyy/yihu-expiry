// 真机式实测：独立实例 + 临时库 + 临时附件目录，经 /apps/expiry 前缀访问（和平台拓扑一致）。截图和报告写到 artifacts/
//   npm run e2e
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { chromium, webkit } from 'playwright-core'
import { startFakePlatform } from '../test/support/fake-platform.mjs'
import { addDays, todayIn } from '../src/dates.js'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3180
const PLATFORM_PORT = APP_PORT + 1
const DB_PORT = 3361
const NAME = 'expiry-e2e-mysql'
const OUT = 'artifacts/e2e'
const SIZES = [['375', 375, 667], ['768', 768, 1024], ['1440', 1440, 900]]
const LONG_NAME = '华东区第三季度所有经销商返利对账与年度框架协议续签补充条款（含二零二六年修订版）法务审批稿'
const today = todayIn()

// 验收第 5 条：已过期 2、今天到期 1、5 天后 1、20 天后 1、60 天后 1
const SAMPLE = [
  { name: '60 天后 · 设备年检', days: 60, category: '设备', remind_days: 30 },
  { name: '今天到期 · 消防资质', days: 0, category: '资质', assignee_id: 12 },
  { name: '20 天后 · 车辆保险', days: 20, category: '保险', amount: '12,800.50' },
  { name: '已过期 · 食品经营许可证', days: -12, category: '证照', assignee_id: 13 },
  { name: LONG_NAME, days: -3, category: '合同', assignee_id: 12 },
  { name: '5 天后 · 办公室租赁合同', days: 5, category: '合同' }
]

mkdirSync(OUT, { recursive: true })
const dataDir = mkdtempSync(path.join(tmpdir(), 'expiry-e2e-'))
const fixture = path.join(dataDir, 'fixtures')
mkdirSync(fixture)
const pdfPath = path.join(fixture, '租赁合同（盖章版）.pdf')
const pngPath = path.join(fixture, '营业执照.png')
const hugePath = path.join(fixture, 'huge.pdf')
const exePath = path.join(fixture, 'evil.exe')
writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
writeFileSync(hugePath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))
writeFileSync(exePath, 'MZ')

const report = { ok: true, checks: [], under44: [], sample: null }
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass, detail })
  if (!pass) report.ok = false
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
docker('run', '-d', '--rm', '--name', NAME, '-e', 'MYSQL_ROOT_PASSWORD=e2e', '-e', 'MYSQL_DATABASE=expiry_e2e', '-p', `127.0.0.1:${DB_PORT}:3306`, 'mysql:8.0', '--skip-log-bin')
const dbUrl = `mysql://root:e2e@127.0.0.1:${DB_PORT}/expiry_e2e`
for (let i = 0; i < 120; i++) {
  try { await (await mysql.createConnection(dbUrl)).end(); break } catch { await new Promise((r) => setTimeout(r, 1000)) }
}

const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT } })
const appUrl = `${platform.url}/apps/expiry`
const server = spawn(process.execPath, ['src/server.js'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'staging', PORT: String(APP_PORT), DATABASE_URL: dbUrl, EXPIRY_DATA_DIR: dataDir, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/expiry' }
})
for (let i = 0; i < 50; i++) {
  const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`).catch(() => null)
  if (r?.ok) break
  await new Promise((res) => setTimeout(res, 200))
}

const SMALL_TARGETS = () => {
  const out = []
  const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  for (const el of document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], label:has(input)')) {
    if (!isVisible(el)) continue
    const dialogs = [...document.querySelectorAll('dialog[open]')]
    if (dialogs.length && !dialogs[dialogs.length - 1].contains(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 44 || r.height < 44) out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).replace(/\s+/g, '.')}` : ''} ${Math.round(r.width)}×${Math.round(r.height)} ${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 16)}`)
  }
  return out
}

async function noScroll(page, label) {
  const r = await page.evaluate(() => ({ sw: document.body.scrollWidth, iw: window.innerWidth, dw: document.documentElement.scrollWidth }))
  check(`${label} 无横向滚动`, r.sw <= r.iw && r.dw <= r.iw, `scrollWidth=${r.sw} innerWidth=${r.iw}`)
}

async function audit(page, label) {
  await noScroll(page, label)
  for (const item of await page.evaluate(SMALL_TARGETS)) report.under44.push(`${label}: ${item}`)
}

async function loginContext(browser, userId, viewport) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport, isMobile: false, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const page = await ctx.newPage()
  page.problems = []
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()) })
  page.on('pageerror', (e) => page.problems.push(e.message))
  await page.goto(`${appUrl}/`)
  await page.waitForSelector('#open-new')
  return { ctx, page }
}

const pool = mysql.createPool(dbUrl)
const browser = await chromium.launch()
const cardText = (page) => page.$$eval('.card', (els) => els.map((c) => ({
  days: c.querySelector('.days').textContent.trim(),
  name: c.querySelector('.name').textContent.trim(),
  tier: c.className.replace('card t-', ''),
  color: getComputedStyle(c.querySelector('.days')).color
})))
const statText = async (page) => (await page.locator('.stats').innerText()).replace(/\s+/g, ' ')

try {
  // 空态
  {
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 })
    check('空态有说明和批量录入入口', await page.locator('.empty [data-batch]').count() === 1)
    check('版本号 v0.1.1', (await page.locator('#version').textContent()) === 'v0.1.1')
    await page.screenshot({ path: `${OUT}/375-empty.png` })
    await audit(page, '375 空态')
    await ctx.close()
  }

  // 真实数据：走接口造 6 条
  {
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 })
    for (const s of SAMPLE) {
      const r = await page.request.post(`${appUrl}/api/items`, { data: { name: s.name, due_date: addDays(today, s.days), category: s.category, remind_days: s.remind_days, amount: s.amount, assignee_id: s.assignee_id } })
      if (r.status() !== 201) throw new Error(`造数失败 ${r.status()} ${await r.text()}`)
    }
    await page.reload()
    await page.waitForSelector('.card')
    const cards = await cardText(page)
    report.sample = { today, stats: await statText(page), cards }
    console.log(`\n=== 真实数据实测（今天 ${today}）===\n统计：${report.sample.stats}`)
    console.table(cards.map((c, i) => ({ 序: i + 1, 剩余: c.days, 档位: c.tier, 颜色: c.color, 名称: c.name.slice(0, 18) })))
    check('6 条按剩余天数升序', JSON.stringify(cards.map((c) => c.days)) === JSON.stringify(['已过期 12 天', '已过期 3 天', '今天到期', '5 天后', '20 天后', '60 天后']))
    check('分档', JSON.stringify(cards.map((c) => c.tier)) === JSON.stringify(['expired', 'expired', 'red', 'red', 'yellow', 'gray']))
    const colors = [...new Set(cards.map((c) => c.color))]
    check('页面上正好三种颜色', colors.length === 3, colors.join(' / '))
    check('统计：已过期 2 · 7 天内 2 · 30 天内 3', report.sample.stats === '已过期 2 · 7 天内 2 · 30 天内 3', report.sample.stats)
    await ctx.close()
  }

  for (const [tag, width, height] of SIZES) {
    const { ctx, page } = await loginContext(browser, 11, { width, height })
    const label = tag

    const box = await page.locator('#version').boundingBox()
    check(`${label} 版本号靠右上`, box.x + box.width > width / 2 && box.y < 60, `x=${Math.round(box.x)} y=${Math.round(box.y)}`)
    const fab = await page.locator('#open-new').boundingBox()
    check(`${label} 新建在右下`, fab.x + fab.width > width - 40 && fab.y + fab.height > height - 90)
    await page.screenshot({ path: `${OUT}/${tag}-list.png`, fullPage: true })
    await audit(page, `${label} 列表`)

    // 统计点击筛选
    await page.click('.stat.s-expired')
    await page.waitForFunction(() => location.search === '?w=expired')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 2)
    check(`${label} 点已过期只剩已过期`, (await cardText(page)).every((c) => c.tier === 'expired'))
    check(`${label} 只看已过期同步高亮`, await page.locator('#only-expired.on').count() === 1)
    await audit(page, `${label} 筛已过期`)
    await page.click('#only-expired')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 6)
    await page.click('.stat.s-yellow')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 3)
    check(`${label} 30 天内是 3 条`, true)
    await page.click('.stat.s-yellow')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 6)
    await page.selectOption('#filter-cat', '合同')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 2)
    await page.selectOption('#filter-who', { label: '李雷' })
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1)
    check(`${label} 类别 + 负责人叠加筛选`, (await page.locator('.card .kv').innerText()).includes('李雷'))
    check(`${label} 刷新后筛选保留`, await page.reload().then(() => page.inputValue('#filter-who')) === '12')
    await page.selectOption('#filter-cat', '')
    await page.selectOption('#filter-who', '')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 6)

    // 新建：手机全屏 sheet，主按钮吸底
    await page.click('#open-new')
    await page.waitForSelector('#sheet[open]')
    await page.fill('#f-name', `新建测试 ${tag} O'Neil -- 合同`)
    await page.fill('#f-due', addDays(today, 15))
    await page.selectOption('#f-category', '合同')
    await page.fill('#f-amount', '1,200.5')
    check(`${label} 提醒天数默认 30`, (await page.inputValue('#f-remind')) === '30')
    check(`${label} 金额键盘 decimal`, (await page.getAttribute('#f-amount', 'inputmode')) === 'decimal')
    await page.setInputFiles('#f-file', pdfPath)
    await page.screenshot({ path: `${OUT}/${tag}-new.png` })
    await audit(page, `${label} 新建`)
    const save = await page.locator('#sheet-save').boundingBox()
    check(`${label} 主按钮在可见区`, save.y + save.height <= height, `bottom=${Math.round(save.y + save.height)}/${height}`)
    if (tag !== '1440') check(`${label} 弹层全屏`, (await page.locator('#sheet').boundingBox()).width === width)

    // 选类型错误的文件：提示 + 不进表单
    await page.setInputFiles('#f-file', exePath)
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 选 exe 被拦`, (await page.textContent('#toast')).includes('只支持'))
    await page.evaluate(() => { document.getElementById('toast').hidden = true })
    await page.setInputFiles('#f-file', hugePath)
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 选超 10MB 被拦`, (await page.textContent('#toast')).includes('10MB'))
    await page.evaluate(() => { document.getElementById('toast').hidden = true })
    await page.setInputFiles('#f-file', pdfPath)

    // 负责人
    await page.click('#f-assign')
    await page.waitForSelector('#picker[open] #picker-list button')
    await page.screenshot({ path: `${OUT}/${tag}-assign.png` })
    await audit(page, `${label} 选负责人`)
    await page.fill('#picker-q', '法务')
    await page.waitForFunction(() => document.querySelectorAll('#picker-list button').length === 1)
    await page.click('#picker-list button')
    check(`${label} 选人回填`, (await page.textContent('#f-assign-name')) === '李雷')

    // 校验失败的提示不能被弹层盖住
    await page.fill('#f-due', '')
    await page.click('#sheet-save')
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 弹层里能看到报错`, await page.evaluate(() => {
      const r = document.getElementById('toast').getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id === 'toast'
    }), await page.textContent('#toast'))
    await page.evaluate(() => { document.getElementById('toast').hidden = true })
    page.problems = page.problems.filter((p) => !p.includes('400')) // 上面故意提交的空日期
    await page.fill('#f-due', addDays(today, 15))

    await page.click('#sheet-save')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    const row = page.locator(`.card:has-text("新建测试 ${tag}")`)
    await row.waitFor()
    check(`${label} 新建进列表，带附件入口`, await row.locator('.att').count() === 1)
    check(`${label} 排序位置对（15 天后在 5 和 20 之间）`, (await cardText(page)).findIndex((c) => c.name.includes(`新建测试 ${tag}`)) === 4)

    // 附件下载入口：新窗口，PDF 直接交给浏览器
    await row.scrollIntoViewIfNeeded()
    await row.screenshot({ path: `${OUT}/${tag}-attachment-card.png` })
    const href = await row.locator('.att').getAttribute('href')
    check(`${label} 附件新窗口打开`, (await row.locator('.att').getAttribute('target')) === '_blank')
    const res = await page.request.get(`${appUrl}/${href}`)
    check(`${label} PDF 内联预览 + 中文文件名`, res.status() === 200 && res.headers()['content-type'] === 'application/pdf' && res.headers()['content-disposition'].startsWith('inline;') && res.headers()['content-disposition'].includes(encodeURIComponent('租赁合同')) && !res.headers()['content-security-policy'])

    // 详情：回填，换 PNG，新窗口真的打开
    await row.locator('[data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check(`${label} 名称带引号原样回填`, (await page.inputValue('#f-name')) === `新建测试 ${tag} O'Neil -- 合同`)
    check(`${label} 金额回填`, (await page.inputValue('#f-amount')) === '1200.50')
    check(`${label} 详情里有附件`, (await page.textContent('#att-link')) === '租赁合同（盖章版）.pdf')
    await page.screenshot({ path: `${OUT}/${tag}-attachment-detail.png` })
    await audit(page, `${label} 详情带附件`)
    await page.setInputFiles('#f-file', pngPath)
    await page.click('#sheet-save')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    await page.waitForFunction((t) => [...document.querySelectorAll('.att span')].some((s) => s.textContent === '营业执照.png'), tag)
    const [popup] = await Promise.all([ctx.waitForEvent('page'), row.locator('.att').click()])
    await popup.waitForLoadState()
    check(`${label} 点附件开新窗口（带登录态）`, popup.url().includes('/apps/expiry/attachments/') && await popup.evaluate(() => document.contentType) === 'image/png', popup.url().slice(-28))
    await popup.close()

    // 批量录入
    await page.click('#open-batch')
    await page.waitForSelector('#batch[open]')
    await page.fill('#batch-text', `批量甲 ${tag}, 2027-01-15, 合同\n日期乱写, 明年吧, 合同\n批量乙 ${tag}, 2027/02/20, 保险\n缺列的行\n批量丙 ${tag}, 2027-03-01, 发票`)
    await page.screenshot({ path: `${OUT}/${tag}-batch.png` })
    await audit(page, `${label} 批量录入`)
    await page.click('#batch-go')
    await page.waitForSelector('#batch-good li')
    check(`${label} 批量预览：好行 2 坏行 3`, await page.locator('#batch-good li').count() === 2 && await page.locator('#batch-bad li').count() === 3)
    const bad = await page.locator('#batch-bad').innerText()
    check(`${label} 坏行报行号`, ['第 2 行', '第 4 行', '第 5 行'].every((x) => bad.includes(x)))
    check(`${label} 主按钮变提交`, (await page.textContent('#batch-go')) === '提交 2 条')
    await page.screenshot({ path: `${OUT}/${tag}-batch-preview.png` })
    await audit(page, `${label} 批量预览`)
    const go = await page.locator('#batch-go').boundingBox()
    check(`${label} 批量主按钮在可见区`, go.y + go.height <= height, `bottom=${Math.round(go.y + go.height)}/${height}`)
    await page.click('#batch-go')
    await page.waitForSelector('#batch:not([open])', { state: 'attached' })
    await page.locator(`.card:has-text("批量甲 ${tag}")`).waitFor()
    check(`${label} 批量入库 2 条`, await page.locator(`.card:has-text("批量乙 ${tag}")`).count() === 1)
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 批量结果提示`, (await page.textContent('#toast')).includes('已录入 2 条，3 行没录入'))
    await page.screenshot({ path: `${OUT}/${tag}-list-full.png`, fullPage: true })
    await audit(page, `${label} 录入后列表`)

    // 键盘弹起：可视区变矮，主按钮还在
    if (tag === '375') {
      await page.click('#open-new')
      await page.waitForSelector('#sheet[open]')
      await page.setViewportSize({ width: 375, height: 380 })
      await page.waitForTimeout(100)
      const b = await page.locator('#sheet-save').boundingBox()
      check('375 键盘弹起时主按钮仍在可视区', b.y + b.height <= 380, `bottom=${Math.round(b.y + b.height)}/380`)
      await page.setViewportSize({ width: 375, height: 667 })
      await page.click('#sheet [data-close]')
    }

    // 删除要点两次
    await page.locator(`.card:has-text("批量甲 ${tag}") [data-open]`).click()
    await page.waitForSelector('#sheet[open]')
    await page.click('#sheet-delete')
    check(`${label} 删除要确认`, (await page.textContent('#sheet-delete')) === '再点一次确认' && await page.locator('#sheet[open]').count() === 1)
    await page.click('#sheet-delete')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    await page.locator(`.card:has-text("批量甲 ${tag}")`).waitFor({ state: 'detached' })

    // 设置页
    await page.click('a[href="settings"]')
    await page.waitForSelector('#notice-state')
    check(`${label} 设置页：能发时显示已开启`, (await page.textContent('#notice-state')).includes('已开启'))
    await page.screenshot({ path: `${OUT}/${tag}-settings.png` })
    await audit(page, `${label} 设置`)
    platform.state.notifyMode = 'forbidden'
    await page.reload()
    check(`${label} 设置页：平台不给发时写明未配置`, (await page.textContent('#notice-state')) === '未配置，不会主动提醒')
    await page.screenshot({ path: `${OUT}/${tag}-settings-off.png` })
    platform.state.notifyMode = 'ok'

    check(`${label} 控制台无报错`, page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
    // 下一档还要按 6 条算
    await pool.query("DELETE FROM expiry_item WHERE name LIKE '新建测试%' OR name LIKE '批量%'")
  }

  // 卡片是「标签 + 值」两列
  {
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 })
    const c = await page.locator('.kv > div').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    check('375 卡片是两列布局', c === 2)
    const clip = await page.locator('.card:has-text("华东区") .name span').evaluate((el) => ({ cut: el.scrollHeight > el.clientHeight + 2, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)), overflow: getComputedStyle(el).overflow }))
    check('375 长名称截断到两行，第三行不露出', clip.cut && clip.lines === 2 && clip.overflow === 'hidden', JSON.stringify(clip))
    await page.locator('.card:has-text("华东区") [data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check('375 点开看全名称', (await page.inputValue('#f-name')) === LONG_NAME)
    await ctx.close()
  }

  // 负责人和无关的人
  {
    const { ctx, page } = await loginContext(browser, 12, { width: 375, height: 667 })
    const names = (await cardText(page)).map((c) => c.name)
    check('负责人看到派给自己的', names.includes('今天到期 · 消防资质'))
    check('负责人看不到别人的', !names.includes('5 天后 · 办公室租赁合同'))
    await page.locator('.card:has-text("今天到期 · 消防资质") [data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check('负责人详情只读，没有保存和删除', await page.locator('#f-name').isDisabled() && !await page.locator('#sheet-save').isVisible() && !await page.locator('#sheet-delete').isVisible())
    await page.screenshot({ path: `${OUT}/375-assignee-detail.png` })
    await audit(page, '375 负责人详情')
    await ctx.close()

    const owner = await loginContext(browser, 11, { width: 375, height: 667 })
    const [row] = await pool.query("SELECT id FROM expiry_item WHERE name LIKE '5 天后%'")
    const up = await owner.page.request.put(`${appUrl}/api/items/${row[0].id}/attachment`, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.png' }, data: readFileSync(pngPath) })
    check('创建人上传成功', up.status() === 200, String(up.status()))
    await owner.ctx.close()
    const other = await loginContext(browser, 13, { width: 375, height: 667 })
    const r = await other.page.request.get(`${appUrl}/attachments/${row[0].id}`)
    check('无关的人下载附件 403', r.status() === 403, String(r.status()))
    await other.ctx.close()
  }

  // iOS 内核走一遍窄屏
  try {
    const wk = await webkit.launch()
    const { ctx, page } = await loginContext(wk, 11, { width: 375, height: 667 })
    await page.waitForSelector('.card')
    await noScroll(page, 'WebKit 375 列表')
    await page.click('#open-new')
    await page.waitForSelector('#sheet[open]')
    await noScroll(page, 'WebKit 375 新建')
    const b = await page.locator('#sheet-save').boundingBox()
    check('WebKit 375 主按钮在可见区', b.y + b.height <= 667, `bottom=${Math.round(b.y + b.height)}`)
    await page.screenshot({ path: `${OUT}/375-webkit-new.png` })
    await page.click('#sheet [data-close]')
    await page.click('#open-batch')
    await page.waitForSelector('#batch[open]')
    await noScroll(page, 'WebKit 375 批量')
    await ctx.close()
    await wk.close()
  } catch (e) {
    check('WebKit 走查', false, e.message.slice(0, 200))
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 600))
} finally {
  await browser.close()
  await pool.end()
  server.kill()
  await platform.close()
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  rmSync(dataDir, { recursive: true, force: true })
}

report.under44 = [...new Set(report.under44)]
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(`\n<44px 的可点元素（${report.under44.length} 个）：`)
for (const line of report.under44) console.log(`  ${line}`)
console.log(`\n检查 ${report.checks.length} 项，失败 ${report.checks.filter((c) => !c.pass).length} 项`)
process.exit(report.ok && !report.under44.length ? 0 : 1)
