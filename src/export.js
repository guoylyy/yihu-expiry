// 导出：CSV 给 Excel，Markdown 给文档。这里只拼文本，不碰库
export const EXPORT_COLUMNS = ['名称', '分类', '到期日', '剩余天数', '负责人', '金额', '备注']

const row = (t) => [t.name, t.category, t.due_date ?? '', t.days ?? '', t.owner ?? '', t.amount ?? '', t.note ?? '']

/** 名称、备注是用户写的甚至是模型抽的：以这些字符开头的格子 Excel 会当公式执行，前面垫一个单引号 */
const guardFormula = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s)

/** RFC 4180：有逗号、引号、换行才加引号，引号写两遍 */
export function csvCell(v) {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 带 BOM，否则 Excel 按 GBK 打开中文全乱。剩余天数和金额是数字，负数不算公式 */
export function toCsv(items) {
  const lines = items.map((t) => row(t).map((v, i) => csvCell(i === 3 || i === 5 ? v : guardFormula(String(v)))).join(','))
  return `﻿${[EXPORT_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`
}

const mdCell = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function toMarkdown(items, title) {
  const head = `| ${EXPORT_COLUMNS.join(' | ')} |\n|${EXPORT_COLUMNS.map(() => ' --- ').join('|')}|`
  const lines = items.map((t) => `| ${row(t).map(mdCell).join(' | ')} |`)
  return `# ${title}\n\n${[head, ...lines].join('\n')}\n`
}

/** 下载文件名：中文走 filename*，老客户端看到的是下划线 */
export function downloadHeader(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
