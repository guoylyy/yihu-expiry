// MCP：无状态 Streamable HTTP，只回 JSON。平台调用时每个请求都带 Bearer access_token（代表当前用户）
import { VERSION } from './version.js'
import { addDays, daysLeft, daysText, todayIn } from './dates.js'
import { CATEGORIES, HttpError, REMIND_MAX, toolInput } from './items.js'

const LIST_DAYS = 30
const LIST_MAX = 50

const brief = (t, today) => ({
  id: t.id,
  name: t.name,
  category: t.category,
  due_date: t.due_date,
  days_left: daysLeft(t.due_date, today),
  label: daysText(daysLeft(t.due_date, today))
})

function parseDays(v) {
  if (v === undefined || v === null || v === '') return LIST_DAYS
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > REMIND_MAX) throw new HttpError(400, `days 要是 0 到 ${REMIND_MAX} 的整数`)
  return n
}

export function buildTools({ items, settings, onCreated }) {
  return [
    {
      name: 'list_expiring',
      title: '查看快到期的条目',
      description: '查用户到期台账里已经过期、以及 days 天内到期的合同、证照、资质、保险、设备，包括自己创建的和自己负责的，按剩余天数升序。用户问「什么快到期了」「哪些合同要续」「有没有过期的证照」时用。',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: `未来多少天内到期，默认 ${LIST_DAYS}。已过期的总会带上` }
        }
      },
      annotations: { readOnlyHint: true },
      run: async (user, args) => {
        const today = todayIn()
        const days = parseDays(args.days)
        const rows = (await items.list(user.id, {}, today)).filter((t) => t.due_date <= addDays(today, days))
        return { total: rows.length, list: rows.slice(0, LIST_MAX).map((t) => brief(t, today)) }
      }
    },
    {
      name: 'create_expiry',
      title: '新建到期条目',
      description: '在用户的到期台账里记一条有到期日的东西。用户说「记一下这份合同明年 3 月到期」「营业执照什么时候到期帮我记上」时用。返回新建的条目。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '名称，如「华东仓租赁合同」' },
          due_date: { type: 'string', description: '到期日：YYYY-MM-DD 或 YYYY/MM/DD，也接受明天、30天后' },
          category: { type: 'string', description: `类别，不填为其他。默认有 ${CATEGORIES.join('、')}，用户可以在设置里增删，不在清单里会报错` }
        },
        required: ['name', 'due_date']
      },
      run: async (user, args) => {
        const today = todayIn()
        const item = await items.create(user.id, await settings.withDefaults(user.id, toolInput(args, today)), { source: 'ai' })
        onCreated?.(user, item)
        return brief(item, today)
      }
    }
  ]
}

export function mcpHandler({ ws, tools, devUser }) {
  return async (req, res) => {
    const { id, method, params } = req.body || {}
    const reply = (result) => res.json({ jsonrpc: '2.0', id, result })
    const fail = (code, message, status = 200) => res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

    // 不允许匿名：initialize / tools/list 也一样，平台每个请求都带 token
    const user = ws.enabled ? await ws.userFromToken(req.headers.authorization) : devUser
    if (!user) return fail(-32001, '未授权：需要平台签发的 access_token', 401)

    if (id === undefined) return res.status(202).end() // 通知（如 notifications/initialized）不用回
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'expiry', version: VERSION } })
    }
    if (method === 'ping') return reply({})
    if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => t) })
    if (method === 'tools/call') {
      const tool = tools.find((t) => t.name === params?.name)
      if (!tool) return fail(-32602, `没有工具 ${params?.name}`)
      try {
        const out = await tool.run(user, params.arguments || {})
        ws.track(user, `mcp.${tool.name}`, { via: 'ai' })
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out })
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.status ? e.message : '操作失败，请稍后再试' }], isError: true })
      }
    }
    return fail(-32601, `不支持 ${method}`)
  }
}
