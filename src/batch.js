// 批量录入的解析：每行「名称, 到期日, 类别」。坏行列出行号和原因，好行照常进，不整批失败
import { parseDate } from './dates.js'
import { CATEGORIES, HttpError, NAME_MAX } from './items.js'

export const BATCH_MAX = 200
const COLUMNS = 3

export function parseBatch(text, categories = CATEGORIES) {
  const rows = []
  const errors = []
  // 行号按用户看到的算，空行也占号
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/)
  lines.forEach((raw, i) => {
    if (!raw.trim()) return
    const line = i + 1
    const fail = (reason) => errors.push({ line, raw: raw.trim(), reason })
    const cols = raw.split(/[,，]/).map((c) => c.trim())
    if (cols.length !== COLUMNS) return fail(cols.length < COLUMNS ? `缺列：要 3 列，这行只有 ${cols.length} 列` : `多了列：要 3 列，这行有 ${cols.length} 列，名称里不能带逗号`)
    const [name, dueRaw, category] = cols
    if (!name) return fail('名称是空的')
    if ([...name].length > NAME_MAX) return fail(`名称不能超过 ${NAME_MAX} 字`)
    const due = parseDate(dueRaw)
    if (!due) return fail(`到期日「${dueRaw}」不对，要写成 2026-11-20 或 2026/11/20`)
    if (!categories.includes(category)) return fail(`类别「${category}」不对，只能是 ${categories.join(' / ')}`)
    rows.push({ line, name, due_date: due, category })
  })
  if (rows.length + errors.length > BATCH_MAX) throw new HttpError(400, `一次最多 ${BATCH_MAX} 行`)
  return { rows, errors }
}
