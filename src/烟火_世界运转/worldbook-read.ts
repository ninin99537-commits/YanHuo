/**
 * 收集当前聊天激活的世界书条目内容, **直接使用酒馆主 AI 的激活机制**(EjsTemplate 环境里的
 * getWorldInfoActivatedData, 与主 AI 完全一致: 蓝灯常驻、绿灯关键词匹配、概率等)——
 * 主 AI 读到什么, 世界引擎就读到什么; 主 AI 匹配不到的条目, 世界引擎也读不到。
 *
 * 默认只读角色卡绑定世界书(主 + 附加)与聊天世界书; 全局世界书由设置开关控制(默认关)。
 * 条目内的 ACU 模板语法会求值: <if> 条件按主 AI 规则用 ACU 表格数据求值, 只保留命中分支;
 * 其余表达式/标签移除。烟火自己写入的条目自动排除; 彼方等其它条目照常读取(它们也是世界的一部分)。
 */

import { useHost } from './host';

/** 移除世界书条目里无法求值的模板语法：{[...]} 表达式、<random/> 等标签、$v: 变量引用(不处理 <if>, <if> 由 evaluateTemplate 求值) */
function stripOtherSyntax(content: string): string {
  if (!/\{\[|<(?:random|calc|max|min)\b|\$(?:v|random|calc|max|min):|<%/i.test(content)) return content;
  let result = content;
  // {[ ... ]} 表达式块
  let out = '';
  let i = 0;
  while (i < result.length) {
    if (result[i] === '{' && result[i + 1] === '[') {
      let depth = 1;
      let inQuote: string | null = null;
      let j = i + 2;
      for (; j < result.length; j++) {
        const ch = result[j];
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
          continue;
        }
        if (ch === "'" || ch === '"') {
          inQuote = ch;
          continue;
        }
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      j++;
      if (result[j] === '}') j++;
      i = j;
      continue;
    }
    out += result[i];
    i++;
  }
  result = out;
  // 自闭合值标签与变量引用
  result = result.replace(/<(?:random|calc|max|min)\b[^>]*\/?>/gi, '');
  result = result.replace(/\$(?:v|random|calc|max|min):[a-zA-Z_][a-zA-Z0-9_]*/g, '');
  // EJS 未渲染时的兜底：移除残留的 <% ... %> 模板块
  result = result.replace(/<%[\s\S]*?%>/g, '');
  // 兜底：移除残留的 elseif/else 标签(防不完整结构)
  result = result.replace(/<\/?(?:elseif|else)\b[^>]*>/gi, '');
  return result;
}

function getAcuApi(): any {
  try {
    return window.parent?.AutoCardUpdaterAPI ?? (window as any).AutoCardUpdaterAPI;
  } catch {
    return undefined;
  }
}

/** ACU 表格快照缓存(按表名集合缓存, 30 秒内复用) */
let sheetsCache: { key: string; time: number; sheets: { name: string; content: string[][] }[] } | null = null;
const SHEETS_TTL = 30_000;

/** 从世界书内容里收集 <if cell:表名/...> 用到的表名(只用到的表才查) */
function collectCellTables(contents: string[]): string[] {
  const tables = new Set<string>();
  for (const content of contents) {
    const re = /cell:\s*([^/\s]+)\s*\//gi;
    for (const m of content.matchAll(re)) {
      if (m[1]) tables.add(m[1]);
    }
  }
  return [...tables];
}

async function buildEvalContext(scanText: string, tableNames: string[]) {
  const key = [...tableNames].sort().join('|');
  if (sheetsCache && sheetsCache.key === key && Date.now() - sheetsCache.time < SHEETS_TTL) {
    return { scanText, sheets: sheetsCache.sheets };
  }
  const sheets: { name: string; content: string[][] }[] = [];
  const api = getAcuApi();
  if (tableNames.length > 0) {
    // 用 exportTableAsJson(原生/SQLite 模式都可用、结构稳定), 只保留用到的表
    let allNames: string[] = [];
    try {
      const all = api?.exportTableAsJson?.();
      if (all && typeof all === 'object') {
        const list = Object.values(all) as any[];
        allNames = list.filter(s => s && typeof s.name === 'string').map(s => s.name);
        for (const s of list) {
          if (s && typeof s.name === 'string' && Array.isArray(s.content) && tableNames.includes(s.name)) {
            sheets.push({ name: s.name, content: s.content });
          }
        }
      }
    } catch {
      // ACU 未就绪或无表格时按空数据处理
    }
    if (sheets.length < tableNames.length) {
      const missing = tableNames.filter(n => !sheets.some(s => s.name === n));
      console.warn(`[烟火] 世界书 <if cell:> 引用的表未找到: ${missing.join('、')}(可用表: ${allNames.join('、') || '(无)'})`);
    }
    sheetsCache = { key, time: Date.now(), sheets };
  }
  return { scanText, sheets };
}

function getCellValue(ctx: { sheets: { name: string; content: string[][] }[] }, tableName: string, rowName: string, colName?: string): unknown {
  const sheet = ctx.sheets.find(s => s.name === tableName);
  if (!sheet || sheet.content.length === 0) return undefined;
  const headers = sheet.content[0];
  // 列：先精确匹配表头，再模糊匹配(表头包含列名, 如"性别/年龄"匹配"年龄")
  let colIdx = -1;
  if (colName) {
    colIdx = headers.indexOf(colName);
    if (colIdx === -1) colIdx = headers.findIndex(h => h.includes(colName) || colName.includes(h));
  }
  // 行：先精确(任意单元格等于行名), 再模糊(任意单元格包含行名)
  let rowIdx = -1;
  for (let r = 1; r < sheet.content.length; r++) {
    const row = sheet.content[r];
    if (row && row.some(cell => cell !== null && cell !== undefined && String(cell) === String(rowName))) {
      rowIdx = r;
      break;
    }
  }
  if (rowIdx === -1) {
    for (let r = 1; r < sheet.content.length; r++) {
      const row = sheet.content[r];
      if (row && row.some(cell => cell !== null && cell !== undefined && String(cell).includes(String(rowName)))) {
        rowIdx = r;
        break;
      }
    }
  }
  if (rowIdx === -1 && colName) {
    const swappedCol = headers.indexOf(rowName);
    const swappedRow = sheet.content.findIndex((row, r) => r > 0 && row && row.some(cell => String(cell) === String(colName)));
    if (swappedCol !== -1 && swappedRow !== -1) {
      rowIdx = swappedRow;
      colIdx = swappedCol;
    }
  }
  if (rowIdx === -1 || colIdx === -1) {
    logCellLookupFailure(sheet.name, headers, rowName, colName, rowIdx === -1, colIdx === -1);
    return undefined;
  }
  return sheet.content[rowIdx][colIdx];
}

/** 查值失败诊断：只对每个 表/行/列 组合记录一次, 避免刷屏 */
const cellDebugSeen = new Set<string>();
function logCellLookupFailure(sheetName: string, headers: string[], rowName: string, colName?: string, rowMissing = false, colMissing = false) {
  const key = `${sheetName}/${rowName}/${colName ?? ''}`;
  if (cellDebugSeen.has(key)) return;
  cellDebugSeen.add(key);
  const reason = rowMissing && colMissing ? '行和列都没找到' : rowMissing ? '行未找到' : '列未找到';
  console.warn(`[烟火] <if cell:> 查值失败(${reason}): ${sheetName}/${rowName}/${colName ?? '(两段式)'}\n  该表实际表头: ${headers.join('、')}`);
}

function compareValue(value: unknown, op: string, rawValue: string): boolean {
  const aStr = String(value);
  // 数值比较：单元格值可能是 "女/19" 这种复合串, 先尝试整体转数字, 失败则提取第一个数字
  let aNum = typeof value === 'number' ? value : parseFloat(aStr);
  if (!Number.isFinite(aNum)) {
    const m = aStr.match(/-?\d+(\.\d+)?/);
    if (m) aNum = parseFloat(m[0]);
  }
  const bNum = parseFloat(rawValue);
  const numeric = Number.isFinite(aNum) && Number.isFinite(bNum);
  const x = numeric ? aNum : aStr;
  const y = numeric ? bNum : rawValue;
  switch (op) {
    case '>=':
      return x >= y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '<':
      return x < y;
    case '!=':
      return x !== y;
    case '=':
    case '==':
      return x === y;
    default:
      return false;
  }
}

function evaluateCellExpr(expr: string, ctx: { scanText: string; sheets: { name: string; content: string[][] }[] }): boolean | null {
  const norm = expr
    .replace(/＞/g, '>')
    .replace(/＜/g, '<')
    .replace(/＝/g, '==')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/≦/g, '<=')
    .replace(/≠/g, '!=');
  const m = norm.match(/^(.+?)\s*(>=|<=|==|!=|=|>|<)\s*(.+)$/);
  if (!m) return null;
  const cellRef = m[1].trim();
  const parts = cellRef.split('/').map(s => s.trim());
  if (parts.length < 2) return null;
  const value = getCellValue(ctx, parts[0], parts[1], parts.length >= 3 ? parts[2] : undefined);
  if (value === undefined || value === null) return null;
  return compareValue(value, m[2], m[3].trim());
}

/** seed 关键词匹配(支持 A,B=OR / A&B=AND / !k 取反 / 括号分组) */
function evaluateSeedExpr(expr: string, ctx: { scanText: string }): boolean | null {
  const text = (ctx.scanText || '').toLowerCase();
  const groups = expr.split(',').map(g => g.trim()).filter(Boolean);
  if (groups.length === 0) return null;
  return groups.some(group => {
    const parts = group.split('&').map(p => p.trim()).filter(Boolean);
    return parts.every(p => {
      const neg = p.startsWith('!');
      const kw = (neg ? p.slice(1) : p).replace(/^\(|\)$/g, '').toLowerCase();
      const hit = kw.length > 0 && text.includes(kw);
      return neg ? !hit : hit;
    });
  });
}

function evaluateLeaf(leaf: string, ctx: { scanText: string; sheets: { name: string; content: string[][] }[] }): boolean | null {
  const m = leaf.match(/^(cell|seed|db|sql|v):([\s\S]*)$/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const arg = m[2].trim();
  if (type === 'cell') return evaluateCellExpr(arg, ctx);
  if (type === 'seed') return evaluateSeedExpr(arg, ctx);
  return null; // db/sql/v 依赖 SQLite 运行时, 不模拟
}

/** cond 表达式递归下降求值：OR(,) -> AND(&) -> NOT(!) -> primary(() | 叶子) */
function evalCond(expr: string, ctx: { scanText: string; sheets: { name: string; content: string[][] }[] }): boolean | null {
  let pos = 0;
  const skipWs = () => {
    while (pos < expr.length && /\s/.test(expr[pos])) pos++;
  };
  function parseOr(): boolean | null {
    let value = parseAnd();
    for (;;) {
      skipWs();
      if (expr[pos] === ',') {
        pos++;
        const v = parseAnd();
        value = value === null || v === null ? null : value || v;
      } else break;
    }
    return value;
  }
  function parseAnd(): boolean | null {
    let value = parseNot();
    for (;;) {
      skipWs();
      if (expr[pos] === '&') {
        pos++;
        const v = parseNot();
        value = value === null || v === null ? null : value && v;
      } else break;
    }
    return value;
  }
  function parseNot(): boolean | null {
    skipWs();
    if (expr[pos] === '!') {
      pos++;
      const v = parseNot();
      return v === null ? null : !v;
    }
    return parsePrimary();
  }
  function parsePrimary(): boolean | null {
    skipWs();
    if (pos >= expr.length) return null;
    if (expr[pos] === '(') {
      pos++;
      const v = parseOr();
      skipWs();
      if (expr[pos] === ')') pos++;
      return v;
    }
    const rest = expr.slice(pos);
    const pm = rest.match(/^(cell|seed|db|sql|v):/i);
    if (pm) {
      const type = pm[0].slice(0, -1).toLowerCase();
      const afterPrefix = rest.slice(pm[0].length);
      if (type === 'sql') {
        const qm = afterPrefix.match(/^"([\s\S]*?)"/);
        if (!qm) return null;
        pos += pm[0].length + qm[0].length;
        return evaluateLeaf('sql:' + qm[1], ctx);
      }
      const lm = afterPrefix.match(/^[^&!,()]+/);
      if (!lm) return null;
      pos += pm[0].length + lm[0].length;
      return evaluateLeaf(pm[0] + lm[0], ctx);
    }
    const lm = rest.match(/^[^&!,()]+/);
    if (!lm) return null;
    pos += lm[0].length;
    return evaluateLeaf('seed:' + lm[0], ctx);
  }
  const result = parseOr();
  skipWs();
  return pos >= expr.length ? result : null;
}

function evaluateCondition(type: string, expr: string, ctx: { scanText: string; sheets: { name: string; content: string[][] }[] }): boolean | null {
  const t = (type || '').toLowerCase();
  if (t === 'cond') return evalCond(expr, ctx);
  if (t === 'cell') return evaluateCellExpr(expr, ctx);
  if (t === 'seed') return evaluateSeedExpr(expr, ctx);
  return null; // db/sql 无法求值
}

/** 递归求值 <if>...</if>(含 <else>、支持嵌套), 返回选中的分支内容 */
function evaluateTemplate(content: string, ctx: { scanText: string; sheets: { name: string; content: string[][] }[] }): string {
  let result = '';
  let i = 0;
  while (i < content.length) {
    const openIdx = content.indexOf('<if', i);
    if (openIdx === -1) {
      result += content.slice(i);
      break;
    }
    result += content.slice(i, openIdx);
    const tagMatch = content.slice(openIdx).match(/^<if\s+([a-zA-Z]+)\s*=\s*"([^"]*)"\s*>/i);
    if (!tagMatch) {
      result += '<if';
      i = openIdx + 3;
      continue;
    }
    const type = tagMatch[1];
    const expr = tagMatch[2];
    const tagEnd = openIdx + tagMatch[0].length - 1;
    const close = findMatchingClose(content, tagEnd + 1);
    if (!close) {
      result += content.slice(openIdx);
      break;
    }
    const block = content.slice(tagEnd + 1, close);
    const elseIdx = findTopLevelElse(block);
    const ifContent = elseIdx === -1 ? block : block.slice(0, elseIdx);
    const elseContent = elseIdx === -1 ? '' : block.slice(elseIdx).replace(/^<else\b[^>]*>/i, '');
    const cond = evaluateCondition(type, expr, ctx);
    const branch = cond === false ? elseContent : ifContent; // 无法求值时保守保留主分支
    result += evaluateTemplate(branch, ctx);
    i = close + '</if>'.length;
  }
  return result;
}

function findMatchingClose(content: string, start: number): number | null {
  const re = /<\/?if\b/g;
  let depth = 1; // 已计入外层 <if>
  for (const m of content.matchAll(re)) {
    const index = m.index ?? -1;
    if (index < start) continue;
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return index;
    } else {
      depth++;
    }
  }
  return null;
}

function findTopLevelElse(block: string): number {
  const re = /<\/?if\b|<else\b/g;
  let depth = 0;
  for (const m of block.matchAll(re)) {
    if (m[0].startsWith('</')) depth--;
    else if (m[0].startsWith('<if')) depth++;
    else if (m[0].startsWith('<else') && depth === 0) return m.index ?? -1;
  }
  return -1;
}

/** EJS 模板环境缓存(prepareContext 会合并全部消息楼层变量, 成本不低; 30 秒内复用) */
let ejsContextCache: { time: number; env: unknown } | null = null;
const EJS_CONTEXT_TTL = 30_000;
async function getEjsContext(): Promise<unknown> {
  if (ejsContextCache && Date.now() - ejsContextCache.time < EJS_CONTEXT_TTL) return ejsContextCache.env;
  let env: unknown = null;
  try {
    env = await useHost().ejs.prepareContext();
  } catch {
    // prepareContext 失败时返回 null
  }
  if (env !== null) ejsContextCache = { time: Date.now(), env };
  return env;
}

/** 自动排除的世界书条目特征(名字/内容开头): 仅烟火自己写入的条目——不把自身输出当设定。
 * 彼方等其它插件的条目不排除: 它们也是世界的一部分, 与主 AI 读到的保持一致 */
const SELF_EXCLUDE_MARKS = ['【烟火】世界动向', '[烟火 · 世界动向]'];

export interface WorldbookReadOptions {
  excludeNames?: string[];
  includeGlobal?: boolean;
}

export async function getActiveWorldbookText(scanText: string, options: WorldbookReadOptions = {}): Promise<string> {
  // 排除名单: 条目名/comment 与排除项相等或包含即不读;
  // 名字在激活数据里可能不可靠(可能只在 comment), 故内容开头(如 "[烟火 · 世界动向]")也参与匹配
  const excludes = [...(options.excludeNames ?? []), ...SELF_EXCLUDE_MARKS].map(s => String(s).trim()).filter(Boolean);
  const isExcluded = (entry: any) => {
    if (!entry) return false;
    if (entry?.extra?.yanhuo === true) return true;
    const name = String(entry.name ?? '').trim();
    const comment = String(entry.comment ?? '').trim();
    const content = String(entry.content ?? '').trim();
    return excludes.some(item => {
      if (!item) return false;
      return name === item || comment === item || (name && name.includes(item)) || (comment && comment.includes(item)) || (content && content.startsWith(item));
    });
  };
  const names: string[] = [];
  try {
    const charWorldbooks = useHost().worldbook.boundNames();
    if (charWorldbooks?.primary) names.push(charWorldbooks.primary);
    (charWorldbooks?.additional ?? []).forEach(name => names.push(name));
  } catch {
    // 未打开角色卡时忽略
  }
  try {
    const chatWorldbook = useHost().worldbook.chatName();
    if (chatWorldbook) names.push(chatWorldbook);
  } catch {
    // 无聊天世界书时忽略
  }
  if (options.includeGlobal) {
    try {
      useHost().worldbook.globalNames().forEach(name => names.push(name));
    } catch {
      // 忽略
    }
  }
  if (names.length === 0) return '';
  // EJS 模板环境提供 getWorldInfoActivatedData(主 AI 的世界书激活逻辑), 同时复用于 EJS 渲染; 带 30 秒缓存
  const env: any = await getEjsContext();
  if (!env || typeof env.getWorldInfoActivatedData !== 'function') {
    console.warn('[烟火] 模板环境不可用, 跳过世界书读取');
    return '';
  }
  // 1. 收集各世界书的激活条目(用酒馆主 AI 的激活机制)
  const activatedAll: any[] = [];
  {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      let activated: any[];
      try {
        activated = (await env.getWorldInfoActivatedData(name, scanText)) || [];
      } catch {
        continue;
      }
      for (const entry of activated) {
        if (entry && !entry.disable && entry.content && !isExcluded(entry)) {
          activatedAll.push(entry);
        }
      }
    }
  }
  // 2. 只查 <if cell:> 用到的表, 供条件求值
  const ctx = await buildEvalContext(scanText, collectCellTables(activatedAll.map(entry => entry.content)));
  // 3. 处理并组装条目内容(顺带提示哪些条目引用了不存在的表)
  const loggedMissingTables = new Set<string>();
  const lines: string[] = [];
  for (const entry of activatedAll) {
    const label = typeof entry.comment === 'string' && entry.comment ? entry.comment : entry.key ? (Array.isArray(entry.key) ? entry.key.join('、') : entry.key) : '(未命名条目)';
    for (const table of collectCellTables([entry.content])) {
      if (!ctx.sheets.some(s => s.name === table) && !loggedMissingTables.has(table)) {
        loggedMissingTables.add(table);
        console.warn(`[烟火] 世界书条目「${label}」引用了不存在的表: ${table}, 请在世界书里改成正确的表名`);
      }
    }
    const needsEjs = entry.content.includes('<%');
    const text = await processEntryContent(entry.content, ctx, needsEjs ? env : null, label);
    if (!text.trim()) continue;
    lines.push(text);
  }
  return lines.join('\n\n');
}

/**
 * 展开酒馆助手扩展变量宏({{get_message_variable::路径}} / {{get_chat_variable::路径}} /
 * {{get_global_variable::路径}} / {{get_preset_variable::路径}} / {{get_character_variable::路径}} /
 * {{format_message_variable::路径}}):
 * `substitudeMacros` 只是酒馆本体 substituteParamsExtended 的包装, 不认识这些助手宏,
 * 不展开的话会原样发给世界引擎(主 AI 侧由酒馆助手的生成管线展开, 烟火需自行处理)。
 */
function expandHelperMacros(text: string, label = '(未命名条目)'): string {
  const macroRe = /\{\{(get_message_variable|format_message_variable|get_chat_variable|get_global_variable|get_preset_variable|get_character_variable)::([^{}]+)\}\}/gi;
  if (!macroRe.test(text)) return text;
  const kindOf: Record<string, any> = {
    get_message_variable: { type: 'message', message_id: 'latest' },
    format_message_variable: { type: 'message', message_id: 'latest' },
    get_chat_variable: { type: 'chat' },
    get_global_variable: { type: 'global' },
    get_preset_variable: { type: 'preset' },
    get_character_variable: { type: 'character' },
  };
  const sources: Record<string, any> = {};
  const missing: string[] = [];
  const result = text.replace(macroRe, (match: string, macroName: string, rawPath: string) => {
    const path = String(rawPath).trim();
    const key = macroName.toLowerCase();
    if (!(key in sources)) {
      try {
        sources[key] = useHost().vars.get(kindOf[key]) ?? {};
      } catch (error) {
        console.warn(`[烟火] 世界书条目「${label}」读取${macroName}的变量失败: ${error instanceof Error ? error.message : String(error)}`);
        sources[key] = {};
      }
    }
    const value = _.get(sources[key], path);
    if (value === undefined || value === null) {
      missing.push(`${macroName}::${path}`);
      return '';
    }
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
  if (missing.length > 0) console.warn(`[烟火] 世界书条目「${label}」以下助手变量宏没有取到值(已替换为空): ${[...new Set(missing)].join('、')}`);
  return result;
}

/**
 * 处理一条世界书内容, 按主 AI 的顺序：
 * 1. <if> 条件求值(选命中分支)
 * 2. EJS 模板渲染(<% %>, 环境与主 AI 相同, MVU 变量等可直接使用)
 * 3. 酒馆宏替换({{user}}/{{char}} 等) + 酒馆助手扩展变量宏展开
 * 4. 移除其余无法求值的模板语法
 * 所有失败都会输出日志(不再静默吞掉), 方便从日志页排查条目模板问题。
 */
async function processEntryContent(content: string, ctx: { scanText: string; sheets: { name: string; content: string[][] }[] }, ejsEnv: unknown, label = '(未命名条目)'): Promise<string> {
  let text = evaluateTemplate(content, ctx);
  if (ejsEnv && text.includes('<%')) {
    // 插件导出名大小写不一致(evalTemplate / evaltemplate)的兼容收在接缝里(见 host.ts 的 HostEjs):
    // 这里只管求值, 返回 null 即插件不可用, 模板块随后会被 stripOtherSyntax 移除。
    try {
      const 求值结果 = await useHost().ejs.evaluate(text, ejsEnv as Record<string, any>);
      if (求值结果 === null) {
        console.warn(`[烟火] 世界书条目「${label}」含 EJS 模板, 但 EjsTemplate.evalTemplate 不可用(请检查提示词模板语法插件版本), 模板块将被移除`);
      } else {
        text = 求值结果;
      }
    } catch (error) {
      // 不再静默: 附带语法诊断, 方便排查条目里的模板错误
      let syntax = '';
      try {
        syntax = await useHost().ejs.syntaxError(text);
      } catch {
        // 诊断失败不影响主日志
      }
      console.warn(`[烟火] 世界书条目「${label}」EJS 渲染失败(模板块将被移除): ${error instanceof Error ? error.message : String(error)}${syntax ? `\n语法诊断: ${syntax}` : ''}`);
    }
  }
  if (text.includes('{{')) {
    try {
      text = useHost().macros.expand(text);
    } catch (error) {
      console.warn(`[烟火] 世界书条目「${label}」酒馆宏替换失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  text = expandHelperMacros(text, label);
  if (/<%[\s\S]*?%>/.test(text)) console.warn(`[烟火] 世界书条目「${label}」仍残留未渲染的 EJS 模板块(通常为渲染失败或语法错误, 见上方日志), 已移除`);
  return stripOtherSyntax(text);
}
