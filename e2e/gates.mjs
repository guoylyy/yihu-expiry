// v0.2.3 验收：15 张截图 + 375-import-first-expanded + 375-import-upload + 375-filter-active + 视觉断言 + 导入全流程 + 断开 AI 的降级 + 老功能回归。产物都在 artifacts/v0.2.3/，不进 git
//   npm run e2e     临时库和 npm test 同一种方式
//   这里的「模型」是假平台的固定回复，验的是链路和降级，不是模型质量；模型质量用 scripts/real-model.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { chromium } from 'playwright-core'
import { startFakePlatform } from '../test/support/fake-platform.mjs'
import { buildDocx } from '../test/support/fixtures.mjs'
import { addDays, monthDayText, todayIn } from '../src/dates.js'
import { SIZES, SMALL_TARGETS, startApp, startDatabase } from './support.mjs'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3180
const PLATFORM_PORT = APP_PORT + 1
const LOCAL_PORT = APP_PORT + 2
const OUT = 'artifacts/v0.2.3'
const FIRST_ROW_MAX = 480 // 375 首屏：顶部到第一条台账的上限
const BARS_MAX = 96 // 375：统计行 + 筛选行的高度合计
const today = todayIn()
const LICENCE_DUE = addDays(today, 20)
const LONG_NAME = '华东区第三季度所有经销商返利对账与年度框架协议续签补充条款（含二零二六年修订版）法务审批稿'

// 故意的：许可证写了有效期，租赁合同整份没写到期日
const CONTRACT_HTML = `<html lang="zh-CN"><body style="font-family:'PingFang SC','Hiragino Sans GB',sans-serif;font-size:14px;line-height:1.8">
<h1>食品经营许可证</h1>
<p>许可证编号：JY13101150012345</p><p>经营者名称：上海以虎餐饮管理有限公司静安店</p>
<p>经营场所：上海市静安区南京西路 1266 号 B1-05</p><p>主体业态：餐饮服务经营者（中型餐馆）</p>
<p>有效期至：${LICENCE_DUE.replace('-', ' 年 ').replace('-', ' 月 ')} 日</p><p>日常监督管理人员：王芳</p>
<h1>写字楼租赁合同</h1>
<p>出租方（甲方）：恒隆广场物业管理有限公司</p><p>承租方（乙方）：上海以虎餐饮管理有限公司</p>
<p>租赁标的：恒隆广场办公楼 28 层 2803 室，建筑面积 186 平方米</p>
<p>年租金：人民币 240,000 元（大写：贰拾肆万元整），按季支付。</p>
<p>租赁期限：以双方另行签署的交付确认书为准。</p><p>乙方如需续租，应提前 60 天书面通知甲方。</p>
</body></html>`
const AI_REPLY = { items: [
  { name: '食品经营许可证（静安店）', category: '食品经营许可', expire_at: LICENCE_DUE, needs_date: false, remind_days: 30, owner: '王芳', amount: null, note: '许可证编号 JY13101150012345' },
  { name: '写字楼租赁合同（恒隆广场 2803）', category: '租赁合同', expire_at: null, needs_date: true, remind_days: 60, owner: null, amount: '240000', note: '续租需提前 60 天书面通知' }
] }
// 第 14 个字正好是左括号：截断时不能留下 `续（…`
const THIRD_NAME = '试导入丙取消勾选华东仓库续（二零二六修订版）'
const THREE_ROWS = { items: [
  { name: '试导入甲', category: '保险', expire_at: addDays(today, 90), remind_days: 30 },
  { name: '试导入乙', category: '瞎编的分类', expire_at: null, needs_date: true, remind_days: 30 },
  { name: THIRD_NAME, category: '保修', expire_at: addDays(today, 91), remind_days: 30 }
] }
const SAMPLE = [
  { name: '已过期 · 食品经营许可证（徐汇店）', days: -12, category: '食品经营许可', assignee_id: 13 },
  { name: LONG_NAME, days: -3, category: '租赁合同', assignee_id: 12 },
  { name: '今天到期 · 消防资质', days: 0, category: '资质证书', assignee_id: 12 },
  { name: '5 天后 · 办公室租赁合同', days: 5, category: '租赁合同' },
  { name: '20 天后 · 车辆保险', days: 20, category: '保险', amount: '12,800.50' },
  { name: '60 天后 · 冷库保修', days: 60, category: '保修', remind_days: 30 }
]

mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}
const section = (title) => console.log(`\n=== ${title} ===`)

const dbUrl = await startDatabase()
const work = mkdtempSync(join(tmpdir(), 'expiry-gates-'))
const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT } })
let llmInput = ''
platform.state.llm = (body) => { llmInput = body.messages[1].content; return JSON.stringify(AI_REPLY) }
const appUrl = `${platform.url}/apps/expiry`
const appEnv = { DATABASE_URL: dbUrl, EXPIRY_DATA_DIR: work, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/expiry', EXPIRY_AI_TIMEOUT_MS: '1500' }
const app = await startApp({ port: APP_PORT, env: appEnv })
const pool = mysql.createPool({ uri: dbUrl, dateStrings: ['DATE'] })
const browser = await chromium.launch()

async function open(width, height, userId = 11) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true })
  const page = await ctx.newPage()
  page.problems = []
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()) })
  page.on('pageerror', (e) => page.problems.push(e.message))
  await page.goto(`${appUrl}/`)
  return { ctx, page }
}

const under44 = new Set()
async function audit(page, label) {
  const r = await page.evaluate(() => ({ body: document.body.scrollWidth, doc: document.documentElement.scrollWidth, inner: window.innerWidth }))
  check(`${label} 无横向滚动`, r.body <= r.inner && r.doc <= r.inner, `body=${r.body} doc=${r.doc} inner=${r.inner}`)
  for (const s of await page.evaluate(SMALL_TARGETS)) under44.add(`${label}: ${s}`)
}

/** 令牌算出来的实际颜色，和元素的计算样式比 */
const tokenColors = (page, names) => page.evaluate((list) => {
  const probe = document.createElement('i')
  document.body.append(probe)
  const out = Object.fromEntries(list.map((name) => { probe.style.color = `var(${name})`; return [name, getComputedStyle(probe).color] }))
  probe.remove()
  return out
}, names)

/** 带底部固定条的页面：全页截图时固定条会印在第一屏底部盖住内容，先把视口撑到整页高 */
async function shotWithBar(page, path) {
  const size = page.viewportSize()
  await page.setViewportSize({ ...size, height: Math.max(size.height, await page.evaluate(() => document.documentElement.scrollHeight)) })
  await page.screenshot({ path })
  await page.setViewportSize(size)
}

const printSql = async () => {
  console.log('\nmysql> select name, category, expire_at, needs_date from expiry_item order by id desc limit 5;')
  console.table((await pool.query('SELECT name, category, expire_at, needs_date FROM expiry_item ORDER BY id DESC LIMIT 5'))[0])
}

try {
  // ---------- 门槛 4：真实 PDF → 确认 → 列表 → 日历 → 导出 ----------
  section('门槛 4：PDF 导入全流程（模型是假平台的固定回复）')
  {
    // 在空白页上打印，不是应用的页面：合同的内联样式过不了应用的 CSP
    const printer = await browser.newPage()
    await printer.setContent(CONTRACT_HTML)
    const pdf = join(OUT, '食品经营许可证与写字楼租赁合同.pdf')
    await printer.pdf({ path: pdf, format: 'A4' })
    await printer.close()
    const { ctx, page } = await open(1440, 900)
    await page.waitForSelector('.yh-empty a[href="import"]')
    check('空态：一句话 + 导入按钮', await page.locator('.yh-empty .yh-btn').count() === 1, await page.textContent('.yh-empty p'))
    await page.screenshot({ path: `${OUT}/flow-0-empty.png` })

    await page.click('.yh-empty a[href="import"]')
    await page.waitForSelector('#drop')
    await page.setInputFiles('#file-input', pdf)
    await page.waitForSelector('.confirm-row')
    check('上传：PDF 文字真的抽出来送给了模型', ['食品经营许可证', '写字楼租赁合同', '240,000', 'JY13101150012345'].every((w) => llmInput.includes(w)), JSON.stringify(llmInput.slice(0, 80)))
    check('确认页：2 条，默认全勾', await page.locator('.confirm-row').count() === 2 && (await page.textContent('#commit')) === '导入 2 条')
    const second = page.locator('.confirm-row').nth(1)
    check('确认页：缺日期的有标记', (await second.locator('.tag-needs').textContent()).includes('缺到期日'))
    check('确认页：带来源文件名', (await second.locator('.confirm-tags').textContent()).includes('.pdf'))
    await page.screenshot({ path: `${OUT}/flow-1-confirm.png`, fullPage: true })
    await page.reload()
    await page.waitForSelector('.confirm-row')
    check('确认页：刷新不丢', await page.locator('.confirm-row').count() === 2)
    check('确认页：刷新后还是只展开第一张', await page.locator('.confirm-row.folded').count() === 1 && await page.locator('.confirm-row').nth(1).evaluate((el) => el.classList.contains('folded')))
    await page.locator('.confirm-row').first().locator('[data-field="note"]').fill('静安店，改过的备注')

    await page.click('#commit')
    await page.waitForSelector('.item')
    await page.waitForSelector('#toast:not([hidden])')
    check('入库：提示已导入 2 条', (await page.textContent('#toast')) === '已导入 2 条')
    check('入库：地址栏干净', !page.url().includes('imported'))
    check('列表：出现 2 条', await page.locator('.item').count() === 2)
    check('列表：缺日期的排最前，文案待补', (await page.locator('.item .days').first().textContent()) === '待补到期日')
    check('列表：统计行末尾有缺日期 chip', (await page.textContent('.stat-line #needs-notice')) === '只看缺到期日')
    const zero = await page.locator('.stat.t-gray b').first().evaluate((el) => getComputedStyle(el).color)
    check('统计：0 用 text-2，不上色', zero === (await tokenColors(page, ['--yh-text-2']))['--yh-text-2'], zero)
    await page.screenshot({ path: `${OUT}/flow-2-list.png` })
    await printSql()

    await page.click('#tab-calendar')
    await page.waitForSelector('#calendar')
    if (LICENCE_DUE.slice(0, 7) !== today.slice(0, 7)) {
      await page.click('[aria-label="下个月"]')
      await page.waitForFunction((m) => location.search.includes(m), LICENCE_DUE.slice(0, 7))
    }
    await page.waitForSelector(`[data-date="${LICENCE_DUE}"]`)
    await page.click(`[data-date="${LICENCE_DUE}"]`)
    await page.waitForFunction((d) => location.search.includes(`day=${d}`), LICENCE_DUE)
    await page.waitForSelector('.cal-day.on')
    check('日历：点那天筛出当天', (await page.locator('.main-col #items .item').count()) === 1 && (await page.textContent('.main-col #items')).includes('食品经营许可证'))
    check('日历：缺日期的单独列在下面', (await page.textContent('.main-col #undated')).includes('写字楼租赁合同'))
    await page.screenshot({ path: `${OUT}/flow-3-calendar.png`, fullPage: true })

    await page.click('#open-export')
    await page.waitForSelector('#export[open]')
    await page.locator('#export input[value="all"]').check()
    await page.screenshot({ path: `${OUT}/flow-4-export.png` })
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-go')])
    const csvPath = join(OUT, '导出示例.csv')
    await download.saveAs(csvPath)
    const bytes = readFileSync(csvPath)
    const csv = bytes.toString('utf8')
    console.log(`\n下载文件名：${download.suggestedFilename()}\n前 3 字节：${bytes.subarray(0, 3).toString('hex')}\n--- CSV 原文\n${csv.slice(1)}---`)
    check('导出：有 BOM，中文解码正常', bytes.subarray(0, 3).toString('hex') === 'efbbbf' && csv.includes('食品经营许可证（静安店）') && csv.includes('写字楼租赁合同') && csv.includes('静安店，改过的备注'))
    check('导出：列名', csv.slice(1).startsWith('名称,分类,到期日,剩余天数,负责人,金额,备注\r\n'))
    check('流程无控制台报错', page.problems.length === 0, page.problems.join(' | ').slice(0, 200))
    await ctx.close()
  }

  // 真实 docx（textutil 之外的结构走单测），这里验 Word 经页面走通
  section('Word、图片')
  {
    const { ctx, page } = await open(1440, 900)
    const docx = join(work, '台账.docx')
    writeFileSync(docx, buildDocx(['证照台账', [['名称', '到期日'], ['营业执照', '2028-01-01']]]))
    const png = join(work, '营业执照.png')
    writeFileSync(png, 'x')
    await page.goto(`${appUrl}/import`)
    await page.setInputFiles('#file-input', png)
    await page.waitForSelector('.result-msg.bad')
    check('图片：明确提示未开通', (await page.textContent('.result-msg.bad')) === '营业执照.png：图片识别暂未开通，请先把证件信息转成文字')
    page.problems = page.problems.filter((p) => !p.includes('422'))
    platform.state.llm = (body) => { llmInput = body.messages[1].content; return JSON.stringify({ items: [{ name: '营业执照', category: '营业执照', expire_at: '2028-01-01' }] }) }
    await page.setInputFiles('#file-input', docx)
    await page.waitForSelector('.confirm-row')
    check('docx：表格里的字送到了模型', llmInput.includes('2028-01-01'))
    await page.locator('[data-remove]').click()
    await page.waitForSelector('#drop')
    check('删掉最后一条回到上传步', await page.locator('#step-confirm').isHidden())
    await ctx.close()
  }

  // ---------- 门槛 3：三档五页 ----------
  section('门槛 3：三档五页')
  await pool.query('DELETE FROM expiry_item')
  {
    const { ctx, page } = await open(375, 667)
    for (const s of SAMPLE) {
      const r = await page.request.post(`${appUrl}/api/items`, { data: { name: s.name, due_date: addDays(today, s.days), category: s.category, remind_days: s.remind_days, amount: s.amount, assignee_id: s.assignee_id } })
      if (r.status() !== 201) throw new Error(`造数失败 ${r.status()} ${await r.text()}`)
    }
    await page.request.post(`${appUrl}/api/import/commit`, { data: { items: [{ name: '待补日期的写字楼合同', category: '租赁合同', expire_at: '', file_name: '合同.pdf', owner: '王芳', amount: '240000' }] } })
    await ctx.close()
  }

  for (const [tag, width, height] of SIZES) {
    const { ctx, page } = await open(width, height)
    await page.waitForSelector('.item')
    await page.screenshot({ path: `${OUT}/${tag}-list.png`, fullPage: width < 1024 })
    await audit(page, `${tag} 列表`)
    const firstTop = await page.evaluate(() => Math.round(document.querySelector('#items .item').getBoundingClientRect().top + window.scrollY))
    console.log(`${tag} 顶部到第一条台账：${firstTop}px`)
    if (tag === '375') check('375 首屏：顶部到第一条台账 ≤480', firstTop <= FIRST_ROW_MAX, `${firstTop}px`)

    // 页头：三个文字链和标题同一行
    const head = await page.evaluate(() => {
      const title = document.querySelector('.head-row h1').getBoundingClientRect()
      const links = [...document.querySelectorAll('.head-links > *')]
      const rects = links.map((l) => l.getBoundingClientRect())
      const style = (l) => getComputedStyle(l)
      return { text: links.map((l) => l.textContent).join(), sameRow: rects.every((r) => r.top < title.bottom && r.bottom > title.top), rightOf: rects[0].left >= title.left, flat: links.every((l) => style(l).backgroundColor === 'rgba(0, 0, 0, 0)'), bold: links.map((l) => Number(style(l).fontWeight)) }
    })
    check(`${tag} 页头：导入、导出、新建是同一行的文字链，新建加粗`, head.text === '导入,导出,新建' && head.sameRow && head.rightOf && head.flat && head.bold[2] > head.bold[0], JSON.stringify(head))

    // 统计一行
    const line = await page.evaluate(() => {
      const box = document.querySelector('.stat-line').getBoundingClientRect()
      const stats = [...document.querySelectorAll('.stat')].map((s) => s.textContent.trim())
      const chip = document.querySelector('.stat-line #needs-notice').getBoundingClientRect()
      const last = document.querySelector('.stat:last-child').getBoundingClientRect()
      return { height: Math.round(box.height), stats, chipRight: chip.left >= last.right, chipAtEnd: Math.abs(chip.right - box.right) < 1, sameRow: Math.abs((chip.top + chip.bottom) - (last.top + last.bottom)) < 2 }
    })
    check(`${tag} 统计：一行，高 ≤64，缺日期 chip 在末尾`, line.height <= 64 && line.chipRight && line.chipAtEnd && line.sameRow, JSON.stringify(line))
    check(`${tag} 统计：文案和顺序`, line.stats.join('|') === '已过期2|今天1|7 天内2|30 天内3', line.stats.join('|'))
    const statTokens = await tokenColors(page, ['--yh-danger', '--yh-highlight'])
    const statColor = (cls) => page.locator(`.stat.${cls} b`).first().evaluate((el) => getComputedStyle(el).color)
    check(`${tag} 统计：颜色按紧急度`, (await statColor('t-expired')) === statTokens['--yh-danger'] && (await statColor('t-red')) === statTokens['--yh-danger'] && (await statColor('t-yellow')) === statTokens['--yh-highlight'])
    check(`${tag} 提醒期那句没了`, !(await page.textContent('.main-col')).includes('提醒期'))

    // 统计段放得下就不能靠横滑：横滑时最后一个数字是被缺日期压住的
    const statFit = () => page.evaluate(() => { const s = document.querySelector('.stats'); return s.scrollWidth - s.clientWidth })
    check(`${tag} 统计：内容没被裁`, await statFit() <= 0, `溢出 ${await statFit()}px`)
    await page.evaluate(() => { for (const b of document.querySelectorAll('.stat b')) b.textContent = '88' })
    check(`${tag} 统计：两位数也放得下`, await statFit() <= 0, `溢出 ${await statFit()}px`)

    // 数字变大也不折行、不撑破页面
    const bigger = await page.evaluate(() => {
      for (const b of document.querySelectorAll('.stat b')) b.textContent = '1234'
      const box = document.querySelector('.stat-line').getBoundingClientRect()
      const needs = document.getElementById('needs-notice').getBoundingClientRect()
      return { height: Math.round(box.height), page: document.documentElement.scrollWidth, width: innerWidth, needsIn: needs.right <= innerWidth }
    })
    check(`${tag} 统计：四位数也 ≤64、缺日期入口不出屏、不横向滚动`, bigger.height <= 64 && bigger.page <= bigger.width && bigger.needsIn, JSON.stringify(bigger))
    await page.reload()
    await page.waitForSelector('.item')

    // 筛选一行只有两个 44px 下拉，平分宽度；缺日期 chip 在统计行，全页只有一个
    const row = await page.evaluate(() => {
      const selects = [...document.querySelectorAll('.filter-row select')].map((s) => s.getBoundingClientRect())
      const fields = [...document.querySelectorAll('.filter-row .yh-field')].map((f) => f.getBoundingClientRect().width)
      return { heights: selects.map((r) => r.height), widths: fields, oneRow: Math.abs(selects[0].top - selects[1].top) < 1, children: document.querySelector('.filter-row').children.length, chips: document.querySelectorAll('.chip').length }
    })
    check(`${tag} 筛选：分类、负责人各占一半，下拉 44px`, row.heights.join() === '44,44' && row.oneRow && row.children === 2 && Math.abs(row.widths[0] - row.widths[1]) < 1, JSON.stringify(row))
    check(`${tag} 缺日期：全页只有一个 chip`, row.chips === 1, JSON.stringify(row))
    if (tag === '375') {
      const half = await page.evaluate(() => document.querySelector('.filter-row .yh-field').getBoundingClientRect().width / document.querySelector('.filter-row').getBoundingClientRect().width)
      check('375 筛选：一个下拉约占一半宽', half > 0.47 && half <= 0.5, half.toFixed(3))
    }

    // 三档都不许有被裁切的文字：控件要整个在页面里，单行文字不能超出自己的盒子
    const clippedText = () => page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('.stat-line a, .filter-row select')) {
        const r = el.getBoundingClientRect()
        const parent = el.closest('.stats, .stat-line, .filter-row').getBoundingClientRect()
        if (r.left < parent.left - 1 || r.right > parent.right + 1 || r.top < parent.top - 1 || r.bottom > parent.bottom + 1 || el.scrollWidth > el.clientWidth + 1) out.push(el.textContent.trim().slice(0, 12))
      }
      return out
    })
    const clipped = await clippedText()
    check(`${tag} 统计行、筛选行：没有被裁切的文字`, clipped.length === 0, clipped.join())

    // 高度：下拉和统计都是 44 的点击区
    const bars = await page.evaluate(() => ['.stat-line', '.filter-row'].map((s) => document.querySelector(s).getBoundingClientRect().height))
    console.log(`${tag} 统计行 ${bars[0]}px + 筛选行 ${bars[1]}px = ${bars[0] + bars[1]}px`)
    if (tag === '375') check('375 筛选行 + 统计行 ≤96', bars[0] + bars[1] <= BARS_MAX, `${bars[0]} + ${bars[1]} = ${bars[0] + bars[1]}px`)

    // 标题：切点不落在括号里，全文还在 title 上
    const titles = await page.$$eval('[data-fit]', (els) => els.filter((e) => e.getClientRects().length).map((e) => ({ text: e.textContent, full: e.dataset.full, cap: Number(e.dataset.fit), clamped: e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth })))
    const halfOpen = titles.filter((t) => t.clamped || [...t.text].length > t.cap || (t.text.endsWith('…') && /[（(][^）)]*…$/.test(t.text)))
    check(`${tag} 标题：没有被 CSS 切掉的，没有停在括号里的，不超过字数上限`, titles.length > 0 && halfOpen.length === 0, JSON.stringify(halfOpen.slice(0, 2)))
    const longTitle = page.locator(`.item-name[title="${LONG_NAME}"]`)
    const longText = await longTitle.locator('span').textContent()
    console.log(`${tag} 长标题：${longText}`)
    if (tag === '375') check('375 长标题：整段括号去掉', longText === '华东区第三季度所有经销商返利对账与年度框架协议续签补充条款…', longText)
    else check(`${tag} 长标题：放得下就是全文`, longText === LONG_NAME, longText)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForFunction((name) => document.querySelector(`.item-name[title="${name}"] span`).textContent === name, LONG_NAME)
    check(`${tag} 长标题：窗口变宽放回全文`, true)
    await page.setViewportSize({ width, height })
    await page.waitForFunction((name) => { const s = document.querySelector(`.item-name[title="${name}"] span`); return s.scrollHeight <= s.clientHeight }, LONG_NAME)

    const catOption = await page.locator('#filter-cat option[value="租赁合同"]').textContent()
    check(`${tag} 分类下拉带计数`, catOption === '租赁合同 3', catOption)

    // 列表行：单行、顺序统一
    const metas = await page.$$eval('#items .item-meta', (els) => els.map((e) => ({ h: Math.round(e.getBoundingClientRect().height), text: e.innerText.replace(/\s+/g, ' '), fit: e.scrollWidth <= e.clientWidth + 1, order: [...e.children].map((c) => c.classList.contains('yh-tag') ? 1 : c.classList.contains('item-date') ? 2 : c.classList.contains('item-owner') ? 3 : c.classList.contains('item-amount') ? 4 : 5) })))
    check(`${tag} 列表行：单行不溢出，分类·日期·负责人·金额`, metas.every((m) => m.h <= 44 && m.fit && m.order.join('') === [...m.order].sort().join('')), JSON.stringify(metas[0]))
    const dotted = await page.locator('.item:has-text("待补日期的写字楼合同") .item-owner').evaluate((el) => getComputedStyle(el, '::before').content)
    check(`${tag} 列表行：用 · 分隔`, dotted.includes('·'), dotted)

    if (width >= 1024) {
      check(`${tag} 列表：主栏 + 右侧栏`, await page.evaluate(() => {
        const main = document.querySelector('.main-col').getBoundingClientRect()
        const side = document.querySelector('.side').getBoundingClientRect()
        return side.width > 200 && side.left >= main.right && Math.abs(side.top - main.top) < 8
      }))
      check(`${tag} 右栏三块`, (await page.locator('.side h2').allTextContents()).map((t) => t.split(' ')[0]).join() === '本月到期,分类分布,最近新增')
    } else check(`${tag} 列表：窄屏单列`, !(await page.locator('.side').isVisible()))
    check(`${tag} 顶栏 sticky、高 56`, await page.evaluate(() => {
      const el = document.querySelector('.yh-top')
      return getComputedStyle(el).position === 'sticky' && Math.round(el.getBoundingClientRect().height) === 56
    }))
    const colors = await page.$$eval('#items .item', (els) => Object.fromEntries(els.map((e) => [e.className.match(/t-(\w+)/)[1], getComputedStyle(e.querySelector('.days')).color])))
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('i')
      document.body.append(probe)
      const of = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color }
      const out = { danger: of('--yh-danger'), highlight: of('--yh-highlight'), muted: of('--yh-text-3') }
      probe.remove()
      return out
    })
    check(`${tag} 剩余天数三色用令牌`, colors.expired === tokens.danger && colors.red === tokens.danger && colors.yellow === tokens.highlight && colors.gray === tokens.muted, JSON.stringify(colors))
    check(`${tag} 负责人为空整行不显示`, await page.locator('.item:has-text("5 天后") .item-owner').count() === 0 && !(await page.textContent('#items')).includes('未指定'))
    check(`${tag} 文字负责人显示，没绑账号`, (await page.textContent('.item:has-text("待补日期的写字楼合同") .item-owner')) === '负责人 王芳')

    // 筛选
    await page.click('.stat:has-text("已过期")')
    await page.waitForFunction(() => location.search === '?w=expired')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 2)
    await page.click('.stat:has-text("已过期")')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 7)
    await page.click('.stat:has-text("今天")')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 1)
    await page.click('.stat:has-text("今天")')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 7)
    await page.click('#needs-notice')
    await page.waitForFunction(() => location.search === '?w=needs' && document.querySelectorAll('#items .item').length === 1)
    await page.waitForSelector('#needs-notice.on')
    const chipOn = await page.locator('#needs-notice').evaluate((el) => getComputedStyle(el).backgroundColor)
    const chipToken = await page.evaluate(() => { const p = document.createElement('i'); document.body.append(p); p.style.backgroundColor = 'var(--yh-primary)'; const c = getComputedStyle(p).backgroundColor; p.remove(); return c })
    check(`${tag} 缺日期：点了只看缺日期的，chip 主色底，文字不变`, (await page.textContent('#items')).includes('待补日期的写字楼合同') && (await page.textContent('.needs-chip.on')) === '只看缺到期日' && await page.locator('.needs-chip').count() === 1 && chipOn === chipToken, chipOn)
    const clippedOn = await clippedText()
    check(`${tag} 选中态：没有被裁切的文字`, clippedOn.length === 0, clippedOn.join())
    await audit(page, `${tag} 列表（只看缺日期）`)
    if (tag === '375') await page.screenshot({ path: `${OUT}/375-filter-active.png`, fullPage: true })
    await page.click('#needs-notice')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 7)
    await page.selectOption('#filter-cat', '租赁合同')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 3)
    check(`${tag} 分类下拉筛选，列表上方出现可关闭的 chip`, (await page.textContent('#clear-category')) === '租赁合同×' && (await page.inputValue('#filter-cat')) === '租赁合同')
    const picked = await page.evaluate(() => [document.querySelector('#filters').getBoundingClientRect().bottom, document.querySelector('#clear-category').getBoundingClientRect().top, document.querySelector('#items').getBoundingClientRect().top])
    check(`${tag} 分类 chip 在筛选行和列表之间`, picked[0] <= picked[1] && picked[1] < picked[2], picked.join())
    await page.click('#clear-category')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 7)
    check(`${tag} 关掉分类 chip，下拉回到分类`, (await page.inputValue('#filter-cat')) === '' && await page.locator('#clear-category').count() === 0 && (await page.locator('#filter-cat option:checked').textContent()) === '分类')
    await page.selectOption('#filter-cat', '租赁合同')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 3)
    await audit(page, `${tag} 列表（选了分类）`)
    await page.selectOption('#filter-who', { label: '李雷' })
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 1)
    check(`${tag} 刷新后筛选保留`, await page.reload().then(() => page.inputValue('#filter-who')) === '12')
    await page.click('#clear-category')
    await page.waitForFunction(() => !document.getElementById('clear-category'))
    await page.selectOption('#filter-who', '')
    await page.waitForFunction(() => document.querySelectorAll('#items .item').length === 7)

    // 头像菜单
    await page.click('#user-menu summary')
    await page.waitForSelector('.yh-menu-list a[href="settings"]')
    check(`${tag} 头像菜单`, (await page.locator('.yh-menu-list a').allTextContents()).join() === '设置,关于,退出')
    await audit(page, `${tag} 头像菜单`)
    await page.keyboard.press('Escape')

    // 弹层
    await page.click('#open-new')
    await page.waitForSelector('#sheet[open]')
    await audit(page, `${tag} 新建弹层`)
    await page.click('#f-assign')
    await page.waitForSelector('#picker[open] #picker-list button')
    await audit(page, `${tag} 选人弹层`)
    await page.click('#picker-list button:has-text("李雷")')
    check(`${tag} 选人回填`, (await page.textContent('#f-assign-name')) === '李雷')
    await page.click('#sheet [data-close]')
    await page.click('#open-export')
    await page.waitForSelector('#export[open]')
    await audit(page, `${tag} 导出弹层`)
    await page.click('#export [data-close]')

    // 日历
    await page.click('#tab-calendar')
    await page.waitForSelector('#calendar')
    await page.waitForSelector('.cal-day.has')
    const cal = await page.evaluate(() => {
      const dot = document.querySelector('.cal-day.has .dot').getBoundingClientRect()
      const days = [...document.querySelectorAll('.cal-grid .cal-day:not(.out)')]
      return { dot: [dot.width, dot.height], allButtons: days.every((d) => d.tagName === 'BUTTON'), dots: document.querySelectorAll('.dot').length, has: document.querySelectorAll('.cal-day.has').length, oldNumber: document.querySelectorAll('.cal-day b').length, small: days.filter((d) => d.getBoundingClientRect().width < 44 || d.getBoundingClientRect().height < 44).length }
    })
    check(`${tag} 日历：4px 圆点，有到期项才有，格子是 button ≥44`, cal.dot.join() === '4,4' && cal.dots === cal.has && cal.allButtons && !cal.oldNumber && !cal.small, JSON.stringify(cal))
    await page.click(`[data-date="${today}"]`)
    await page.waitForSelector('.cal-day.on')
    await page.waitForFunction(() => document.querySelectorAll('.main-col #items .item').length === 1)
    const calTitle = await page.locator('.main-col h2.group').first().textContent()
    check(`${tag} 日历：点选当天，标题写几月几日几项`, calTitle === `${monthDayText(today)} · 1 项`, calTitle)
    await page.screenshot({ path: `${OUT}/${tag}-calendar.png`, fullPage: true })
    await audit(page, `${tag} 日历`)

    // 导入确认：3 条里取消勾选 1 条
    await page.goto(`${appUrl}/import`)
    await page.waitForSelector('#drop')
    if (tag === '375') {
      await page.screenshot({ path: `${OUT}/375-import-upload.png`, fullPage: true })
    }
    await audit(page, `${tag} 导入上传`)
    platform.state.llm = () => JSON.stringify(THREE_ROWS)
    await page.fill('#paste-text', '一张台账表')
    await page.click('#paste-btn')
    await page.waitForSelector('.confirm-row')
    if (tag === '375') await shotWithBar(page, `${OUT}/375-import-first-expanded.png`) // 识别完什么都没动的样子
    check(`${tag} 确认页：非法分类回落其他`, (await page.locator('.confirm-row').nth(1).locator('select').inputValue()) === '其他')
    const confirmRow = (n) => page.locator('.confirm-row').nth(n)
    const first0 = confirmRow(0)
    const isFolded = (n) => confirmRow(n).evaluate((el) => el.classList.contains('folded'))
    check(`${tag} 确认页：默认只展开第一张`, !(await isFolded(0)) && await isFolded(1) && await isFolded(2) && !(await confirmRow(1).locator('.confirm-grid').isVisible()))
    check(`${tag} 确认页：折叠摘要`, (await confirmRow(1).locator('.confirm-summary').textContent()) === '试导入乙 · 其他 · 缺日期' && await confirmRow(1).locator('.confirm-summary').isVisible(), await confirmRow(1).locator('.confirm-summary').textContent())
    const summaryCut = await page.$$eval('.confirm-row.folded', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length)
    check(`${tag} 确认页：折叠行不溢出`, summaryCut === 0)
    const third = confirmRow(2)
    const thirdText = await third.locator('.confirm-summary').textContent()
    check(`${tag} 确认页：长名称截到 14 字补…，不留左括号，分类和日期完整`, thirdText === `试导入丙取消勾选华东仓库续… · 保修 · ${addDays(today, 91)}` && (await third.locator('.summary-name').getAttribute('title')) === THIRD_NAME, thirdText)
    const cut = await third.locator('.confirm-summary').evaluate((el) => [...el.children].some((c) => c.scrollWidth > c.clientWidth))
    check(`${tag} 确认页：折叠摘要没有被省略号吃掉`, !cut)
    const summaryHeight = await third.evaluate((el) => Math.round(el.getBoundingClientRect().height))
    check(`${tag} 确认页：折叠行不超过两行字的高度`, summaryHeight <= 54, `${summaryHeight}px`)

    // 整行点击：摘要、卡片空白处都能展开收起，勾选框和其他控件不触发
    await third.locator('.summary-name').click()
    check(`${tag} 确认页：点摘要展开`, !(await isFolded(2)) && (await third.locator('[data-toggle]').textContent()) === '收起' && (await third.locator('[data-toggle]').getAttribute('aria-expanded')) === 'true')
    await third.locator('.row-title').click()
    check(`${tag} 确认页：点标题行收起`, await isFolded(2))
    const box = await third.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + 2)
    check(`${tag} 确认页：点卡片边上的空白也展开`, !(await isFolded(2)))
    await third.locator('.row-title').click()
    await third.locator('[data-field="selected"]').click({ force: true })
    check(`${tag} 确认页：点勾选框不展开`, await isFolded(2) && !(await third.locator('[data-field="selected"]').isChecked()))
    await third.locator('[data-field="selected"]').click({ force: true })
    await first0.locator('.confirm-grid').click({ position: { x: 1, y: 1 } })
    check(`${tag} 确认页：点展开卡片的表单区不收起`, !(await isFolded(0)))

    await confirmRow(2).locator('[data-field="selected"]').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await confirmRow(2).locator('[data-field="selected"]').uncheck({ force: true })
    check(`${tag} 确认页：取消勾选后数量跟着变`, (await page.textContent('#commit')) === '导入 2 条')
    check(`${tag} 确认页：勾选不影响折叠`, await isFolded(2))
    await confirmRow(2).locator('[data-toggle]').click()
    check(`${tag} 确认页：展开不影响勾选`, !(await isFolded(2)) && !(await confirmRow(2).locator('[data-field="selected"]').isChecked()) && await confirmRow(2).locator('.confirm-grid').isVisible())
    await confirmRow(2).locator('[data-toggle]').click()
    check(`${tag} 确认页：收起不影响勾选`, await isFolded(2) && !(await confirmRow(2).locator('[data-field="selected"]').isChecked()))

    // 到期日：文本框 + 日历图标
    const first = confirmRow(0)
    const dateBox = first.locator('[data-field="expire_at"]')
    check(`${tag} 确认页：到期日是 YYYY-MM-DD 文本框`, (await dateBox.getAttribute('type')) === 'text' && (await dateBox.inputValue()) === addDays(today, 90) && (await dateBox.getAttribute('placeholder')) === 'YYYY-MM-DD')
    const hit = await first.locator('.date-pick').evaluate((el) => {
      const r = el.getBoundingClientRect()
      el.scrollIntoView({ block: 'center' })
      const c = el.getBoundingClientRect()
      return { w: r.width, h: r.height, top: document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.type }
    })
    check(`${tag} 确认页：日历图标 44px，点到的是原生日期框`, hit.w >= 44 && hit.h >= 44 && hit.top === 'date', JSON.stringify(hit))
    await first.locator('.date-pick input').fill('2027-01-30')
    check(`${tag} 确认页：日历选的日期写回文本框和摘要`, (await dateBox.inputValue()) === '2027-01-30' && (await first.locator('.summary-rest').textContent()).endsWith('2027-01-30'))
    await dateBox.fill(addDays(today, 90))
    check(`${tag} 确认页：手输的日期同步给日历`, (await first.locator('.date-pick input').inputValue()) === addDays(today, 90))
    await dateBox.fill('')
    check(`${tag} 确认页：清空日期出现缺日期标记`, await first.locator('.tag-needs').count() === 1)
    await dateBox.fill(addDays(today, 90))

    // 占位文字和 label
    const form = await first.locator('.confirm-grid').evaluate((el) => ({ labels: [...el.querySelectorAll('.yh-label')].map((l) => l.textContent), holders: [...el.querySelectorAll('input')].map((i) => i.placeholder).filter(Boolean) }))
    check(`${tag} 确认页：可空写在 label 上，不留「选填」`, ['负责人（可空）', '金额（可空）', '备注（可空）'].every((l) => form.labels.includes(l)) && !(await page.textContent('#rows')).includes('选填') && form.holders.sort().join() === '240000,YYYY-MM-DD', JSON.stringify(form))

    // 名称：标题样式，点改名才变输入框
    const title = await first.locator('.row-title').evaluate((el) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight].join() })
    check(`${tag} 确认页：名称是 20px/600 的标题`, title === '20px,600' && !(await first.locator('.confirm-name').isVisible()), title)
    await first.locator('[data-rename]').click()
    check(`${tag} 确认页：点改名才变输入框`, await first.locator('.confirm-name').isVisible() && !(await first.locator('.row-title').isVisible()))
    await first.locator('.confirm-name').fill('试导入甲改')
    await first.locator('.confirm-name').press('Enter')
    check(`${tag} 确认页：改完回到标题`, (await first.locator('.row-title').textContent()) === '试导入甲改' && !(await first.locator('.confirm-name').isVisible()))

    await page.evaluate(() => window.scrollTo(0, 0)) // 滚动后截全页，sticky 顶栏会印在页面中间
    await shotWithBar(page, `${OUT}/${tag}-import-confirm.png`)
    await audit(page, `${tag} 导入确认`)

    // 填错后折起来再提交：要自己展开，不然看不到错在哪
    await first.locator('[data-field="remind_days"]').fill('abc')
    await first.locator('[data-toggle]').click()
    await audit(page, `${tag} 导入确认（全部折叠）`)
    await page.click('#commit')
    await page.waitForSelector('.confirm-row.bad')
    check(`${tag} 确认页：服务端报错标到那一行`, (await page.textContent('.confirm-row.bad .yh-field-error')).includes('第 1 条'))
    check(`${tag} 确认页：报错的行自动展开`, !(await isFolded(0)) && await page.locator('.confirm-row.bad .yh-field-error').isVisible())
    page.problems = page.problems.filter((p) => !p.includes('400'))
    await page.locator('.confirm-row').nth(0).locator('[data-field="remind_days"]').fill('30')
    await page.click('#commit')
    await page.waitForSelector('.item')
    const [[{ n, off }]] = await pool.query("SELECT SUM(name LIKE '试导入%') AS n, SUM(name LIKE '%取消勾选%') AS off FROM expiry_item")
    check(`${tag} 只导入勾选的`, Number(n) === 2 && Number(off) === 0, `n=${n} off=${off}`)
    await pool.query("DELETE FROM expiry_item WHERE name LIKE '试导入%'")
    platform.state.llm = () => JSON.stringify(AI_REPLY)

    await page.goto(`${appUrl}/about`)
    await page.waitForSelector('.info')
    await page.screenshot({ path: `${OUT}/${tag}-about.png` })
    await audit(page, `${tag} 关于`)

    await page.goto(`${appUrl}/settings`)
    await page.waitForSelector('.cat-row')
    await page.screenshot({ path: `${OUT}/${tag}-settings.png`, fullPage: true })
    await audit(page, `${tag} 设置`)
    await page.click('[data-action="rename"]')
    await page.waitForSelector('#rename[open]')
    await audit(page, `${tag} 改名弹层`)
    await page.click('#rename [data-close]')

    check(`${tag} 控制台无报错`, page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  // 设置即时生效
  section('设置即时生效')
  {
    const { ctx, page } = await open(1440, 900)
    await page.goto(`${appUrl}/settings`)
    await page.waitForSelector('.cat-row')
    check('关于设置：提醒状态已开启', (await page.textContent('#notice-state')).includes('已开启，每天 09:00'))
    await page.fill('#cat-name', '消防')
    await page.click('#cat-add-btn')
    await page.waitForSelector('.cat-row[data-name="消防"]')
    await page.click('.cat-row[data-name="消防"] [data-action="rename"]')
    await page.fill('#rename-input', '消防资质')
    await page.click('#rename-save')
    await page.waitForSelector('.cat-row[data-name="消防资质"]')
    await page.click('.cat-row[data-name="消防资质"] [data-action="up"]')
    await page.waitForFunction(() => document.querySelectorAll('.cat-row')[5].dataset.name === '消防资质')
    await page.click('.cat-row[data-name="保修"] [data-action="remove"]')
    await page.waitForSelector('#confirm[open]')
    await audit(page, '1440 删除分类确认')
    await page.click('#confirm-yes')
    await page.waitForFunction(() => !document.querySelector('.cat-row[data-name="保修"]'))
    await page.selectOption('#s-hour', '7')
    await page.waitForSelector('#toast:not([hidden])')
    await page.fill('#s-remind', '45')
    await page.locator('#s-remind').blur()
    await page.waitForFunction(() => document.getElementById('toast').textContent === '已保存')
    await page.click('#s-owner')
    await page.waitForSelector('#picker[open] #picker-list button')
    await page.click('#picker-list button:has-text("韩梅梅")')
    await page.waitForFunction(() => document.getElementById('s-owner-name').textContent === '韩梅梅')
    await page.reload()
    await page.waitForSelector('.cat-row')
    check('设置：刷新后都在', (await page.textContent('#notice-state')).includes('每天 07:00') && (await page.inputValue('#s-remind')) === '45' && (await page.textContent('#s-owner-name')) === '韩梅梅')
    await page.goto(`${appUrl}/`)
    await page.waitForSelector('.item')
    const catOptions = await page.locator('#filter-cat option').evaluateAll((els) => els.map((o) => o.value))
    check('分类：列表的下拉跟着变，保修的条目转到其他', catOptions.includes('消防资质') && !catOptions.includes('保修') && (await page.textContent('.item:has-text("冷库保修") .yh-tag')) === '其他')
    await page.click('#open-new')
    await page.waitForSelector('#sheet[open]')
    check('默认值：新建弹层带上默认提醒天数和负责人', (await page.inputValue('#f-remind')) === '45' && (await page.textContent('#f-assign-name')) === '韩梅梅')
    await page.click('#sheet [data-close]')
    await pool.query('DELETE FROM expiry_setting')
    await ctx.close()
  }

  // 分类再多也只是下拉变长，页头高度不变
  section('分类很多')
  {
    const { ctx, page } = await open(375, 667)
    await page.waitForSelector('.item')
    const top = () => page.evaluate(() => Math.round(document.querySelector('#items .item').getBoundingClientRect().top + window.scrollY))
    const before = await top()
    for (const name of ['消防资质', '环保批文', '特种设备', '商标注册', '域名备案', '软件授权', '车辆年检', '劳动合同']) {
      const r = await page.request.post(`${appUrl}/api/categories`, { data: { name } })
      if (r.status() !== 201) throw new Error(`加分类失败 ${r.status()} ${await r.text()}`)
    }
    await page.reload()
    await page.waitForSelector('.item')
    check('375 分类很多：第一条台账的位置不变', (await top()) === before, `${before} → ${await top()}`)
    await audit(page, '375 分类很多')
    await page.selectOption('#filter-cat', '劳动合同')
    await page.waitForSelector('#clear-category')
    await page.reload()
    await page.waitForSelector('#clear-category')
    check('375 分类很多：刷新后选中的分类保留', (await page.inputValue('#filter-cat')) === '劳动合同')
    await pool.query('DELETE FROM expiry_setting')
    await ctx.close()
  }

  // 老功能回归：新建带附件、批量录入、删除、负责人只读、补日期
  section('老功能回归')
  {
    const { ctx, page } = await open(375, 667)
    await page.waitForSelector('.item')
    const pdf = join(work, '租赁合同（盖章版）.pdf')
    writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
    await page.click('#open-new')
    await page.waitForSelector('#sheet[open]')
    await page.fill('#f-name', "回归 O'Neil -- 合同")
    await page.fill('#f-due', addDays(today, 15))
    await page.selectOption('#f-category', '租赁合同')
    await page.fill('#f-amount', '1,200.5')
    await page.setInputFiles('#f-file', pdf)
    await page.waitForTimeout(300) // 手机上弹层有 0.2 秒上滑动画，动画中量的位置不算数
    const save = await page.locator('#sheet-save').boundingBox()
    check('375 主按钮在可见区', save.y + save.height <= 667, `bottom=${Math.round(save.y + save.height)}`)
    await page.click('#sheet-save')
    const row = page.locator('.item:has-text("回归 O\'Neil")')
    await row.waitFor()
    check('新建带附件进列表', await row.locator('.att').count() === 1 && (await row.locator('.item-amount').textContent()) === '¥1,200.50')
    await row.locator('[data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check('详情回填', (await page.inputValue('#f-name')) === "回归 O'Neil -- 合同" && (await page.inputValue('#f-amount')) === '1200.50')
    await page.click('#sheet-delete')
    check('删除要确认', (await page.textContent('#sheet-delete')) === '再点一次确认')
    await page.click('#sheet-delete')
    await row.waitFor({ state: 'detached' })

    await page.goto(`${appUrl}/import`)
    await page.click('#batch-link')
    await page.waitForSelector('#batch[open]')
    await audit(page, '375 批量录入')
    await page.fill('#batch-text', '批量甲, 2027-01-15, 租赁合同\n日期乱写, 明年吧, 租赁合同\n批量丙, 2027-03-01, 发票')
    await page.click('#batch-go')
    await page.waitForSelector('#batch-good li')
    check('批量预览：好行 1 坏行 2', await page.locator('#batch-good li').count() === 1 && await page.locator('#batch-bad li').count() === 2)
    await page.click('#batch-go')
    await page.waitForSelector('#batch:not([open])', { state: 'attached' })
    await page.locator('.item:has-text("批量甲")').waitFor()

    await page.locator('.item:has-text("待补日期的写字楼合同") [data-open]').click()
    await page.waitForSelector('#sheet[open]')
    check('缺日期的详情：提示要补，负责人文字回填', (await page.textContent('#sheet-hint')).includes('还没有到期日') && (await page.textContent('#f-assign-name')) === '王芳')
    await page.fill('#f-due', addDays(today, 40))
    await page.click('#sheet-save')
    await page.waitForSelector('#sheet:not([open])', { state: 'attached' })
    await page.waitForFunction(() => !document.getElementById('needs-notice'))
    const [[row2]] = await pool.query("SELECT needs_date, expire_at, owner_name FROM expiry_item WHERE name = '待补日期的写字楼合同'")
    check('补上日期：标记清除，负责人文字还在', row2.needs_date === 0 && row2.expire_at === addDays(today, 40) && row2.owner_name === '王芳', JSON.stringify(row2))
    check('回归无控制台报错', page.problems.length === 0, page.problems.join(' | ').slice(0, 200))
    await ctx.close()

    const other = await open(375, 667, 12)
    await other.page.locator('.item:has-text("今天到期 · 消防资质") [data-open]').click()
    await other.page.waitForSelector('#sheet[open]')
    check('负责人详情只读', await other.page.locator('#f-name').isDisabled() && !(await other.page.locator('#sheet-save').isVisible()))
    await audit(other.page, '375 负责人详情')
    check('负责人看不到别人的', !(await other.page.content()).includes('5 天后 · 办公室租赁合同'))
    await other.ctx.close()
  }

  // ---------- 断开 AI ----------
  section('断开平台 AI')
  {
    const { ctx, page } = await open(1440, 900)
    const scenario = async (label, llm, rejectKey = false) => {
      platform.state.llm = llm
      platform.state.rejectKey = rejectKey
      await page.goto(`${appUrl}/import`)
      await page.fill('#paste-text', '食品经营许可证，有效期至 2027 年 3 月 31 日')
      await page.click('#paste-btn')
      await page.waitForSelector('#degrade:not([hidden])')
      const msg = await page.textContent('#degrade-text')
      console.log(`[${label}] 页面：${msg}`)
      check(`${label}：提示手动录入，不 500`, /自动识别失败，可以手动录入/.test(msg))
    }
    await scenario('模型接口报错', () => undefined)
    await scenario('假 key（平台拒绝）', () => JSON.stringify(AI_REPLY), true)
    await scenario('模型回垃圾', () => '抱歉，我无法处理这个请求')
    await scenario('模型挂起超时', () => new Promise(() => {}))
    await page.screenshot({ path: `${OUT}/degrade-import.png`, fullPage: true })

    // 确认到一半继续添加，这次识别失败：已识别的不丢，回得去
    platform.state.llm = () => JSON.stringify(THREE_ROWS)
    await page.fill('#paste-text', '先识别一份')
    await page.click('#paste-btn')
    await page.waitForSelector('.confirm-row')
    await page.click('#add-more')
    platform.state.llm = () => undefined
    await page.fill('#paste-text', '第二份')
    await page.click('#paste-btn')
    await page.waitForSelector('#degrade:not([hidden])')
    await page.click('#back-confirm')
    check('继续添加失败后能回到确认，已识别的还在', await page.locator('.confirm-row').count() === 3)
    await page.evaluate(() => sessionStorage.clear())
    await page.goto(`${appUrl}/import`)
    await page.fill('#paste-text', '再来一次')
    await page.click('#paste-btn')
    await page.waitForSelector('#degrade:not([hidden])')
    await page.click('#manual-new')
    await page.waitForSelector('#sheet[open]')
    check('手动新增按钮直接打开新建弹层', (await page.textContent('#sheet-title')) === '新建条目')
    platform.state.rejectKey = false
    await ctx.close()
  }

  // 本地单人：完全没有平台凭证
  {
    const local = await startApp({ port: LOCAL_PORT, env: { DATABASE_URL: dbUrl, EXPIRY_DATA_DIR: work, YH_CLIENT_ID: '', YH_CLIENT_SECRET: '', YH_APP_URL: '', YH_BASE_PATH: '' } })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${LOCAL_PORT}/import`)
      await page.fill('#paste-text', '营业执照')
      await page.click('#paste-btn')
      await page.waitForSelector('#degrade:not([hidden])')
      check('本地单人：提示未配置模型', /还没配置模型/.test(await page.textContent('#degrade-text')))
      await page.goto(`http://127.0.0.1:${LOCAL_PORT}/about`)
      check('本地单人：运行模式、模型', (await page.textContent('#a-mode')) === '本地单人' && (await page.textContent('#a-model')) === '未配置')
      check('本地单人：菜单没有退出', await page.locator('#logout-link').count() === 0)
      await ctx.close()
    } finally {
      local.kill()
    }
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 800))
} finally {
  await browser.close()
  await pool.end()
  app.kill()
  await platform.close()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n<44px 的可点元素（${under44.size} 个）：`)
for (const s of under44) console.log(`  ${s}`)
const failed = results.filter((r) => !r.pass)
console.log(`\n检查 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length || under44.size ? 1 : 0)
