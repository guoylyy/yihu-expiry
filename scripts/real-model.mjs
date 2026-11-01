// 用真实平台模型抽一段合同和证照文字，打印模型原始回复和收敛后的条目。e2e 里的模型是固定回复，改提示词后要跑这个。凭证只从环境变量读，不打印
//   YH_CLIENT_ID=… YH_CLIENT_SECRET=… YH_API_URL=<平台地址> node scripts/real-model.mjs
import { Workspace } from '../src/yh-one.mjs'
import { extractItems } from '../src/extract.js'
import { CATEGORIES, REMIND_DEFAULT } from '../src/items.js'
import { todayIn, tzName } from '../src/dates.js'

const SOURCE = `食品经营许可证
许可证编号：JY13101150012345
经营者名称：上海以虎餐饮管理有限公司静安店
有效期至：2027 年 3 月 31 日
日常监督管理人员：王芳

写字楼租赁合同
出租方：恒隆广场物业管理有限公司
租赁标的：恒隆广场办公楼 28 层 2803 室
年租金：人民币 240,000 元，按季支付
租赁期限：以双方另行签署的交付确认书为准
乙方如需续租，应提前 60 天书面通知甲方`

const missing = ['YH_CLIENT_ID', 'YH_CLIENT_SECRET', 'YH_API_URL'].filter((k) => !process.env[k])
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}`)
  process.exit(2)
}

const ws = new Workspace()
let raw = null
let model = null
const llm = async (opts) => {
  const r = await ws.llm(opts)
  raw = r?.choices?.[0]?.message?.content ?? null
  model = r?.model ?? null
  return r
}
const started = Date.now()
const out = await extractItems(SOURCE, { llm, today: todayIn(), tz: tzName(), categories: CATEGORIES, remindDays: REMIND_DEFAULT, timeoutMs: 120_000 })
console.log(`模型：${model}  耗时：${Date.now() - started}ms`)
console.log('--- 模型原始回复\n' + raw)
console.log('--- 收敛后的条目\n' + JSON.stringify(out, null, 2))
process.exit(out.ok ? 0 : 1)
