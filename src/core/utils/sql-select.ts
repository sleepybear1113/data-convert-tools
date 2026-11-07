/**
 * 极简 SQL 解析：判断一条 SQL 是否是「对单表不做筛选/排序/变换的读取」，
 * 即 `SELECT <列列表> FROM <表名> [别名] [LIMIT <n>]`。
 * 满足时返回表名（去引号），否则返回 null。
 *
 * 允许：列子集、`*`、列别名（含 AS）、表别名、LIMIT 常量。
 * 拒绝：WHERE/GROUP/ORDER/OFFSET/JOIN/UNION/子查询/函数调用/DISTINCT、多表、注释。
 */

type Token = { type: 'ident' | 'number' | 'punct'; value: string; quoted: boolean }

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = []
  let index = 0
  const isIdentStart = (char: string): boolean => /[A-Za-z_\u0080-\uffff]/u.test(char)

  while (index < input.length) {
    const char = input[index]
    if (/\s/u.test(char)) {
      index += 1
      continue
    }
    // 注释：-- 行注释 与 /* 块注释 */ 按空白处理。
    if (char === '-' && input[index + 1] === '-') {
      const end = input.indexOf('\n', index)
      index = end === -1 ? input.length : end + 1
      continue
    }
    if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2)
      if (end === -1) return null
      index = end + 2
      continue
    }
    // 字符串字面量：出现即意味着表达式或值，直接拒绝。
    if (char === "'") return null

    if (char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      const end = input.indexOf(close === '"' ? '"' : close, index + 1)
      if (end === -1) return null
      const raw = input.slice(index + 1, end)
      if (close === '"' && raw.includes('"') && input[end + 1] === '"') {
        // 转义引号（""）不支持：表名含引号的场景极少，直接拒绝以保证严谨。
        return null
      }
      tokens.push({ type: 'ident', value: raw, quoted: true })
      index = end + 1
      continue
    }

    if (char === '(' || char === ')') {
      // 任何括号（函数调用 / 子查询）都不属于简单单表读取。
      return null
    }
    if (char === ',' || char === '.' || char === ';' || char === '*') {
      tokens.push({ type: 'punct', value: char, quoted: false })
      index += 1
      continue
    }
    if (/\d/u.test(char)) {
      const match = /^\d+(?:\.\d+)?/u.exec(input.slice(index))
      if (!match) return null
      tokens.push({ type: 'number', value: match[0], quoted: false })
      index += match[0].length
      continue
    }
    if (isIdentStart(char)) {
      const match = /^[\w$\u0080-\uffff]+/u.exec(input.slice(index))
      if (!match) return null
      tokens.push({ type: 'ident', value: match[0], quoted: false })
      index += match[0].length
      continue
    }
    // 其余符号（运算符等）意味着表达式，拒绝。
    return null
  }
  return tokens
}

function unquote(token: Token): string {
  return token.value
}

const IDENT = (token: Token): boolean => token.type === 'ident'
const KEYWORD = (token: Token, keyword: string): boolean =>
  token.type === 'ident' && !token.quoted && token.value.toUpperCase() === keyword

export function simpleSelectSourceTable(sql: string): string | null {
  const trimmed = sql.trim().replace(/;+\s*$/u, '')
  if (!trimmed) return null
  const tokens = tokenize(trimmed)
  if (!tokens || tokens.length < 4) return null

  let cursor = 0
  if (!KEYWORD(tokens[cursor], 'SELECT')) return null
  cursor += 1

  // 列列表：到顶层 FROM 为止；只允许标识符 / * / 逗号 / AS 别名。
  let sawFrom = false
  let expectAlias = false
  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (KEYWORD(token, 'FROM')) {
      sawFrom = true
      cursor += 1
      break
    }
    if (KEYWORD(token, 'DISTINCT')) return null
    if (expectAlias) {
      if (!IDENT(token)) return null
      expectAlias = false
      cursor += 1
      continue
    }
    if (KEYWORD(token, 'AS')) {
      expectAlias = true
      cursor += 1
      continue
    }
    if (token.type === 'punct' && (token.value === ',' || token.value === '*')) {
      cursor += 1
      continue
    }
    if (token.type === 'punct' && token.value === '.') {
      cursor += 1
      continue
    }
    if (IDENT(token)) {
      cursor += 1
      continue
    }
    return null
  }
  if (!sawFrom) return null

  // 表名：一个标识符（可带引号）。多表（逗号）或子查询已被前面的规则拒绝。
  const tableToken = tokens[cursor]
  if (!tableToken || !IDENT(tableToken)) return null
  const tableName = unquote(tableToken)
  cursor += 1

  // 可选表别名：`AS p` 或裸标识符（非 LIMIT）。
  if (cursor < tokens.length && KEYWORD(tokens[cursor], 'AS')) {
    cursor += 1
    const alias = tokens[cursor]
    if (!alias || !IDENT(alias) || KEYWORD(alias, 'LIMIT')) return null
    cursor += 1
  } else if (cursor < tokens.length && IDENT(tokens[cursor]) && !KEYWORD(tokens[cursor], 'LIMIT')) {
    cursor += 1
  }

  // 可选 LIMIT <整数常量>；不允许 OFFSET、逗号形式的 LIMIT 等。
  if (cursor < tokens.length) {
    if (!KEYWORD(tokens[cursor], 'LIMIT')) return null
    cursor += 1
    const limitValue = tokens[cursor]
    if (!limitValue || limitValue.type !== 'number' || !/^\d+$/u.test(limitValue.value)) return null
    cursor += 1
    if (cursor !== tokens.length) return null
  }

  return tableName
}
