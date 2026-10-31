// v0.1.1 验收：同一批 7 条数据先后跑 v0.1.0 和当前代码，对比 375 页面高度，再走查空字段的显示。截图和报告写到 artifacts/e2e/
//   npm run e2e:slim
import { execSync, spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { chromium } from 'playwright-core'
import { startFakePlatform } from '../test/support/fake-platform.mjs'
import { addDays, todayIn } from '../src/dates.js'

const BASE_COMMIT = '48f322d' // v0.1.0
const APP_PORT = Number(process.env.E2E_APP_PORT) || 3180
const PLATFORM_PORT = APP_PORT + 1
const DB_PORT = 3362
const NAME = 'expiry-slim-mysql'
const OUT = 'artifacts/e2e'
const today = todayIn()

// 无负责人无金额 5 条（其中 1 条带附件、1 条带备注），有负责人有金额 2 条
const SAMPLE = [
  { name: '空 · 办公室租赁合同', days: -3, category: '合同' },
  { name: '空 · 消防资质', days: 5, category: '资质' },
  { name: '空 · 车辆保险', days: 20, category: '保险' },
  { name: '空 · 带附件的营业执照', days: 45, category: '证照', file: true },
  { name: '空 · 带备注的设备年检', days: 60, category: '设备', note: '年检站要提前一周约' },
  { name: '有人 · 食品经营许可证', days: 2, category: '证照', assignee_id: 12, amount: '12800.50' },
  { name: '有人 · 华东仓租赁合同', days: 25, category: '合同', assignee_id: 13, amount: '3600' }
]
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

mkdirSync(OUT, { recursive: true })
const dataDir = mkdtempSync(path.join(tmpdir(), 'expiry-slim-'))
const oldDir = mkdtempSync(path.join(tmpdir(), 'expiry-v010-'))
execSync(`git archive ${BASE_COMMIT} | tar -x -C ${oldDir}`)
symlinkSync(path.resolve('node_modules'), path.join(oldDir, 'node_modules'))
const pdfPath = path.join(dataDir, '合同.pdf')
writeFileSync(pdfPath, PDF)

const report = { ok: true, checks: [], heights: {} }
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass, detail })
  if (!pass) report.ok = false
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}

spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
execFileSync('docker', ['run', '-d', '--rm', '--name', NAME, '-e', 'MYSQL_ROOT_PASSWORD=e2e', '-e', 'MYSQL_DATABASE=expiry_e2e', '-p', `127.0.0.1:${DB_PORT}:3306`, 'mysql:8.0', '--skip-log-bin'], { stdio: 'ignore' })
const dbUrl = `mysql://root:e2e@127.0.0.1:${DB_PORT}/expiry_e2e`
for (let i = 0; i < 120; i++) {
  try { await (await mysql.createConnection(dbUrl)).end(); break } catch { await new Promise((r) => setTimeout(r, 1000)) }
}

const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT } })
const appUrl = `${platform.url}/apps/expiry`

async function startApp(cwd) {
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'staging', PORT: String(APP_PORT), DATABASE_URL: dbUrl, EXPIRY_DATA_DIR: dataDir, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/expiry' }
  })
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/health`).catch(() => null)
    if (r?.ok) break
    await new Promise((res) => setTimeout(res, 200))
  }
  return () => new Promise((resolve) => { server.once('exit', resolve); server.kill() })
}

async function open(browser, userId, viewport) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const page = await ctx.newPage()
  await page.goto(`${appUrl}/`)
  await page.waitForSelector('#open-new')
  return { ctx, page }
}

const measure = (page) => page.evaluate(() => ({ height: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, innerWidth: window.innerWidth }))
const card = (page, name) => page.locator(`.card:has-text("${name}")`)
const openCard = async (page, name) => {
  await card(page, name).locator('[data-open]').click()
  await page.waitForSelector('#sheet[open]')
}
const shown = (page, key) => page.locator(`#sheet [data-optional="${key}"]`).isVisible()

const browser = await chromium.launch()
let stopApp = await startApp(oldDir)
try {
  // 改造前
  {
    const { ctx, page } = await open(browser, 11, { width: 375, height: 667 })
    for (const s of SAMPLE) {
      const r = await page.request.post(`${appUrl}/api/items`, { data: { name: s.name, due_date: addDays(today, s.days), category: s.category, amount: s.amount, note: s.note, assignee_id: s.assignee_id } })
      if (r.status() !== 201) throw new Error(`造数失败 ${r.status()} ${await r.text()}`)
      if (s.file) await page.request.put(`${appUrl}/api/items/${(await r.json()).id}/attachment`, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('合同.pdf') }, data: Buffer.from(PDF) })
    }
    await page.reload()
    await page.waitForSelector('.card')
    check('改造前版本确实是 v0.1.0', (await page.textContent('#version')) === 'v0.1.0')
    check('改造前 7 条', await page.locator('.card').count() === 7)
    report.heights.before = await measure(page)
    await page.screenshot({ path: `${OUT}/slim-before-375-list.png`, fullPage: true })
    await ctx.close()
  }
  await stopApp()

  // 改造后
  stopApp = await startApp(process.cwd())
  {
    const { ctx, page } = await open(browser, 11, { width: 375, height: 667 })
    check('改造后版本 v0.1.1', (await page.textContent('#version')) === 'v0.1.1')
    check('改造后 7 条', await page.locator('.card').count() === 7)
    report.heights.after = await measure(page)
    const { before, after } = report.heights
    check('375 页面高度减少', after.height < before.height, `${before.height}px → ${after.height}px（少 ${before.height - after.height}px）`)
    check('375 scrollWidth <= innerWidth', after.scrollWidth <= after.innerWidth && after.bodyWidth <= after.innerWidth, `scrollWidth=${after.scrollWidth} innerWidth=${after.innerWidth}`)
    await page.screenshot({ path: `${OUT}/slim-after-375-list.png`, fullPage: true })

    const text = await page.locator('.cards').innerText()
    check('卡片上没有「未指定」', !text.includes('未指定'))
    check('只有 2 张卡片有负责人行', await page.locator('.kv dt:text-is("负责人")').count() === 2)
    check('有负责人的卡片显示姓名', (await card(page, '有人 · 食品').innerText()).includes('李雷'))
    const heights = await page.$$eval('.card', (els) => Object.fromEntries(els.map((c) => [c.querySelector('.name').textContent.trim(), Math.round(c.getBoundingClientRect().height)])))
    check('字段少的卡片更矮', heights['空 · 消防资质'] < heights['有人 · 食品经营许可证'], JSON.stringify(heights))

    await page.selectOption('#filter-who', { label: '未指定' })
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 5)
    check('筛「未指定」出 5 条', true)
    await page.selectOption('#filter-who', '')
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 7)

    // 无负责人的详情：只有创建人看得到，所以一定是可编辑态
    await openCard(page, '空 · 消防资质')
    const sheet = await page.locator('#sheet').innerText()
    check('无负责人详情不出现「未指定」', !sheet.includes('未指定'))
    for (const [key, label] of [['assign', '负责人'], ['amount', '金额'], ['note', '备注'], ['att', '附件']]) {
      check(`空详情不显示${label}行`, !await shown(page, key) && !sheet.includes(label))
    }
    check('创建人有补填入口', await page.locator('#sheet-more').isVisible())
    await page.screenshot({ path: `${OUT}/slim-after-375-detail-empty.png` })
    await page.click('#sheet [data-close]')

    await openCard(page, '有人 · 食品')
    check('有值的详情显示负责人和金额', await shown(page, 'assign') && await shown(page, 'amount') && (await page.textContent('#f-assign-name')) === '李雷' && (await page.inputValue('#f-amount')) === '12800.50')
    check('空的备注、附件还是不显示', !await shown(page, 'note') && !await shown(page, 'att'))
    await page.screenshot({ path: `${OUT}/slim-after-375-detail-filled.png` })
    await page.click('#sheet [data-close]')

    await openCard(page, '空 · 带备注')
    check('有备注的详情显示备注', await shown(page, 'note') && (await page.inputValue('#f-note')) === '年检站要提前一周约')
    await page.click('#sheet [data-close]')
    await openCard(page, '空 · 带附件')
    check('有附件的详情显示附件', await shown(page, 'att') && (await page.textContent('#att-link')) === '合同.pdf')
    await page.click('#sheet [data-close]')

    // 新建：四行都在，标选填；上一次详情折起来的不能带过来
    await page.click('#open-new')
    await page.waitForSelector('#sheet[open]')
    check('新建表单四个选填项都在', (await Promise.all(['assign', 'amount', 'note', 'att'].map((k) => shown(page, k)))).every(Boolean))
    check('新建没有补填按钮', !await page.locator('#sheet-more').isVisible())
    check('新建：选填标在负责人、金额、备注后', await page.locator('#sheet .opt:visible').count() === 3)
    check('金额键盘 decimal', (await page.getAttribute('#f-amount', 'inputmode')) === 'decimal')
    await page.screenshot({ path: `${OUT}/slim-after-375-new.png` })

    // 附件上传失败后留在弹层，附件行不能被折掉
    await page.fill('#f-name', '临时 · 上传失败')
    await page.fill('#f-due', addDays(today, 90))
    await page.setInputFiles('#f-file', pdfPath)
    await page.route('**/attachment', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"磁盘满了"}' }))
    await page.click('#sheet-save')
    await page.waitForSelector('#toast:not([hidden])')
    check('附件失败后附件行还在', await shown(page, 'att') && await page.locator('#f-file').isEnabled())
    await page.unroute('**/attachment')

    // 补填：展开后选人保存，卡片上出现，再清掉恢复原样
    await page.click('#sheet [data-close]')
    await openCard(page, '空 · 车辆保险')
    await page.click('#sheet-more')
    check('展开后四行都能填', (await Promise.all(['assign', 'amount', 'note', 'att'].map((k) => shown(page, k)))).every(Boolean))
    check('展开后也不写「未指定」', !(await page.locator('#sheet').innerText()).includes('未指定'))
    await page.click('#f-assign')
    await page.waitForSelector('#picker[open] #picker-list button')
    await page.fill('#picker-q', '法务')
    await page.waitForFunction(() => document.querySelectorAll('#picker-list button').length === 1)
    await page.click('#picker-list button')
    await page.fill('#f-amount', '99')
    await page.click('#sheet-save')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('车辆保险') && c.textContent.includes('李雷')))
    await openCard(page, '空 · 车辆保险')
    check('补填后存上了', (await page.textContent('#f-assign-name')) === '李雷' && (await page.inputValue('#f-amount')) === '99.00')
    await page.click('#sheet [data-close]')
    await ctx.close()
  }

  // 只读：负责人看详情，没有补填入口
  {
    const { ctx, page } = await open(browser, 13, { width: 375, height: 667 })
    await openCard(page, '有人 · 华东仓')
    check('负责人只读详情：空行不显示、没有补填', !await shown(page, 'note') && !await shown(page, 'att') && await shown(page, 'assign') && !await page.locator('#sheet-more').isVisible())
    await ctx.close()
  }

  // 1440：补填测试动过的那条恢复成空，截图要的是 5 空 2 有
  {
    const pool = mysql.createPool(dbUrl)
    await pool.query("UPDATE expiry_item SET assignee_id = NULL, amount = NULL WHERE name LIKE '空 · 车辆保险'")
    await pool.query("DELETE FROM expiry_item WHERE name LIKE '临时%'")
    await pool.end()
    const { ctx, page } = await open(browser, 11, { width: 1440, height: 900 })
    await page.screenshot({ path: `${OUT}/slim-after-1440-list.png`, fullPage: true })
    const m = await measure(page)
    check('1440 scrollWidth <= innerWidth', m.scrollWidth <= m.innerWidth, `scrollWidth=${m.scrollWidth} innerWidth=${m.innerWidth}`)
    const col = await card(page, '空 · 带附件').evaluate((c) => Math.round(c.querySelector('.kv-att').getBoundingClientRect().left - c.querySelector('.kv').getBoundingClientRect().left))
    check('1440 无负责人时附件仍在第三列', col === 244, `offset=${col}`)
    await openCard(page, '空 · 消防资质')
    check('1440 无负责人详情不出现「未指定」', !(await page.locator('#sheet').innerText()).includes('未指定'))
    await page.screenshot({ path: `${OUT}/slim-after-1440-detail-empty.png` })
    await ctx.close()
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 600))
} finally {
  await browser.close()
  await stopApp()
  await platform.close()
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(oldDir, { recursive: true, force: true })
}

writeFileSync(`${OUT}/slim-report.json`, JSON.stringify(report, null, 2))
console.log(`\n检查 ${report.checks.length} 项，失败 ${report.checks.filter((c) => !c.pass).length} 项`)
process.exit(report.ok ? 0 : 1)
