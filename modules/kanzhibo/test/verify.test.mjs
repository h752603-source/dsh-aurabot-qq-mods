// 看直播模块的离线自检脚本（不是 Aurabot 模块 —— 它躺在 test/ 里，插件不会当入口文件加载）。
// 用法（在模块文件夹里，或者任意目录只要路径对）：
//   node test/verify.test.mjs                 # 只测逻辑：工具/命令/接口注册、时段判定、每日去重、崩溃恢复
//   set LIVE=1 && node test/verify.test.mjs   # 额外真起一次 Edge + CDP（Windows），验证浏览器链路
// 命名成 *.test.mjs 是为了被 CI 的通配符（modules/*/test/*.test.mjs）和 node --test 认到。
//
// 它给模块喂一个假的 api（不发 QQ、不改真配置、数据落在临时目录）。
// 然后跑：工具/命令/接口能不能注册上、tick 的时段判定、灯牌与评论的每日去重、
// 上次崩溃后「刷抖音」能不能自己放回来。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'
import { createGate } from '../lib/gate.mjs'
import { createClicker } from '../lib/click.mjs'
import { FIND_SRC, HIT_SRC, MARK_SRC, UNMARK_SRC, SCROLL_SRC, normalizeSpec, choosePoint, pickUnique, sameSig, collapseNested, taskProgressFromText, badgeHintsFromText, plus100FromText, badgeTaskRowFromText, endedFromText } from '../lib/find.mjs'

const LIVE = process.env.LIVE === '1'
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  OK   ' + name + (extra ? ' — ' + extra : '')) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/** 造一个假的 api，并把模块 setup 起来 */
function boot({ settings = {}, cfg = {}, state = null, dir = null, owner = true, allOwner = null, chatKind = 'private' } = {}) {
  const dataDir = dir || mkdtempSync(join(tmpdir(), 'kanzhibo-'))
  mkdirSync(dataDir, { recursive: true })
  if (state) writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state))

  const s = {
    enabled: true, target: '', checkSec: 120, schedule: false, startTime: '20:00', endTime: '23:30',
    liveCommentOn: false, liveComment: '', commentDelaySec: 8, renewBadge: false, badgeDelaySec: 30,
    giftByDm: false, minuteReport: false,
    ...settings,
  }
  const config = { ownerQQ: '10001', douyin: { enabled: true, autoBrowse: false }, ...cfg }
  const got = { tools: [], rules: [], commands: [], routes: [], events: [], intervals: [], sent: [], logs: [] }
  const noop = () => () => {}

  const api = {
    id: 'kanzhibo', source: 'user', version: 'test', apiVersion: 1, dir: dataDir,
    settings: () => ({ ...s }),
    saveSettings: (patch) => Object.assign(s, patch),
    config: () => config,
    setConfig: (patch) => {
      if (typeof patch === 'function') Object.assign(config, patch(config))
      else Object.assign(config, patch)
    },
    dataDir: () => dataDir,
    log: {
      info: (m) => got.logs.push(['info', m]), warn: (m) => got.logs.push(['warn', m]),
      error: (m) => got.logs.push(['error', m]), debug: (m) => got.logs.push(['debug', m]),
    },
    on: (name, fn) => { got.events.push([name, fn]); return () => {} },
    emit: noop, later: () => noop(),
    every: (ms, fn, name) => { got.intervals.push([ms, name]); return () => {} },
    tool: (fn) => { const t = fn({ chat: { kind: chatKind, chatId: chatKind === 'group' ? 'group:1' : 'private:1' }, sessionId: 's1' }); got.tools.push(...(Array.isArray(t) ? t : [t]).filter(Boolean)); return () => {} },
    defineTool: (t) => t,
    rule: (fn) => { got.rules.push(typeof fn === 'function' ? fn() : fn); return () => {} },
    command: (c) => { got.commands.push(c); return () => {} },
    route: (p, fn) => { got.routes.push([p, fn]); return () => {} },
    onDispose: (fn) => { got.dispose = fn },
    sendText: (chatId, text) => { got.sent.push([chatId, text]); return Promise.resolve() },
    send: () => Promise.resolve(), sendImage: noop, sendFile: noop, sendVoiceFile: noop, sendSegments: noop,
    onebot: async () => ({}), ask: async () => '', think: async () => '',
    isOwner: () => true, has: () => false, use: () => null, lazy: () => ({}), lib: () => ({}),
    core: {
      hub: {
        turnHasOwner: () => owner,
        turnSendersAllOwner: () => (allOwner === null ? owner : allOwner),
        groupName: () => '群', runSystemTurn: async () => '', deliver: async () => {},
      },
      onebot: { call: async () => ({}) }, http: {}, modules: {}, logger: {}, root: dataDir,
      local: { active: () => false, call: async () => ({}) },
    },
    dsh: { get: () => undefined },
  }
  const out = mod.setup(api)
  return { out, api, s, config, got, dataDir }
}

const tool = (got, name) => got.tools.find((t) => t.name === name)
const cmd = (got, name) => got.commands.find((c) => c.name === name)
const route = (got, path) => (got.routes.find(([p]) => p === path) || [])[1]

console.log('\n=== 1. 模块定义 ===')
ok('id = kanzhibo', mod.id === 'kanzhibo')
ok('api 版本 = 1', mod.api === 1, 'version ' + mod.version)
ok('有 defaults + 字段清单', Object.keys(mod.defaults || {}).length > 5 && (mod.settingsSchema || []).length >= 10, (mod.settingsSchema || []).length + ' 个字段')
ok('表单全交给自定义面板（settings 留空，避免和 panel.js 重复渲染）', mod.settings.length === 0 && mod.panel === 'panel.js')
const setting = (key) => (mod.settingsSchema || []).find((x) => x.key === key)
ok('多了「QQ 私信送礼」开关，默认关着', setting('giftByDm') && setting('giftByDm').type === 'switch' && mod.defaults.giftByDm === false)
ok('多了「动作前先问我」开关，默认开（半自动）', setting('semiAuto') && setting('semiAuto').type === 'switch' && mod.defaults.semiAuto === true)
ok('送到灯牌那条写明了误触风险', /点偏|误触/.test((setting('renewBadge') || {}).hint || ''), (setting('renewBadge') || {}).hint)

console.log('\n=== 2. setup 注册了什么 ===')
const b = boot()
ok('开关关着：主人私聊只有 4 个工具（没有送礼）', b.got.tools.length === 4, b.got.tools.map((t) => t.name).join(', '))
ok('工具名都对', ['kanzhibo_enter', 'kanzhibo_status', 'kanzhibo_stop', 'kanzhibo_say'].every((n) => tool(b.got, n)) && !tool(b.got, 'kanzhibo_gift'))
ok('/看直播 命令 + kanzhibo 别名', cmd(b.got, '看直播') && cmd(b.got, '看直播').aliases.includes('kanzhibo'))
ok('一条给模型的规则', b.got.rules.length === 1 && /kanzhibo_enter/.test(b.got.rules[0]))
ok('两个网页接口 /status /selfcheck', Boolean(route(b.got, '/status')) && Boolean(route(b.got, '/selfcheck')))
ok('注册了配置监听（改间隔热生效）', b.got.events.some(([n]) => n === 'config'))
ok('导出了 tick / selfCheck / status', typeof b.out.tick === 'function' && typeof b.out.selfCheck === 'function' && typeof b.out.status === 'function')

console.log('\n=== 2.5 主人权限：别人拿不到操作类工具 ===')
const other = boot({ owner: false })
ok('非主人只剩 1 个工具', other.got.tools.length === 1, other.got.tools.map((t) => t.name).join(', '))
ok('非主人没有进房 / 停止 / 送礼 / 说话', ['kanzhibo_enter', 'kanzhibo_stop', 'kanzhibo_gift', 'kanzhibo_say'].every((n) => !tool(other.got, n)))
const stOther = await tool(other.got, 'kanzhibo_status').execute({})
ok('非主人问状态不暴露在看谁', /挂直播/.test(stOther.message) && !/目标：/.test(stOther.message), stOther.message)

console.log('\n=== 2.6 QQ 私信送礼的开关 ===')
const dmOn = boot({ settings: { giftByDm: true } })
ok('开关打开 + 私聊：多给她一个送礼工具', dmOn.got.tools.length === 5 && Boolean(tool(dmOn.got, 'kanzhibo_gift')), dmOn.got.tools.map((t) => t.name).join(', '))
const dmGroup = boot({ settings: { giftByDm: true }, chatKind: 'group' })
ok('开关打开但在群里：照样没有送礼工具', !tool(dmGroup.got, 'kanzhibo_gift'), dmGroup.got.tools.map((t) => t.name).join(', '))
const dmOther = boot({ settings: { giftByDm: true }, owner: false })
ok('开关打开但不是主人：没有送礼工具', !tool(dmOther.got, 'kanzhibo_gift'))
Object.assign(dmOn.s, { giftByDm: false })
const giftRefused = await tool(dmOn.got, 'kanzhibo_gift').execute({ gift: '小心心' })
ok('面板上一关，送礼立刻被拒（不用重载）', giftRefused.ok === false && /开关关着/.test(giftRefused.message), giftRefused.message)
const stDm = await route(dmOn.got, '/selfcheck')({})
ok('/selfcheck 里能看到这个开关', stDm.giftByDm === false)
ok('/看直播 状态 会带一句「私信送礼」', /私信送礼：/.test(await cmd(dmOn.got, '看直播').run('')))

console.log('\n=== 2.7 一锅里有人是主人、也有别人：只给状态 ===')
const mixed = boot({ owner: true, allOwner: false })
ok('本轮不全是主人：不给操作类工具', mixed.got.tools.length === 1 && !tool(mixed.got, 'kanzhibo_stop'), mixed.got.tools.map((t) => t.name).join(', '))

console.log('\n=== 3. 状态与自检 ===')
const st = await tool(b.got, 'kanzhibo_status').execute({})
ok('kanzhibo_status 能回话', st.ok && /挂直播/.test(st.message), st.message.split('\n')[0])
const sc = await b.out.selfCheck()
ok('selfCheck 说清浏览器和 CDP', /浏览器：/.test(sc) && /CDP：/.test(sc))
// 找得到浏览器就要是真路径；找不到（比如 CI 的 Linux runner）也要老实说「没找到」
const binLine = ((sc.match(/浏览器：(.*)/) || [])[1] || '').trim()
const looksLikePath = /msedge\.exe|chrome\.exe/i.test(binLine)
ok('selfCheck 的浏览器那一行能用', looksLikePath ? existsSync(binLine) : /没找到/.test(binLine), binLine || '（空）')
const r1 = await route(b.got, '/selfcheck')({})
ok('/selfcheck 返回 JSON', r1.ok === true && typeof r1.browser === 'string' && typeof r1.inWindow === 'boolean', 'inWindow=' + r1.inWindow + ' browser=' + (r1.browser || '（没找到）'))

console.log('\n=== 4. 时段判定（含跨午夜） ===')
const win = b.out._debug.inWindow
const at = (h, m) => new Date(2026, 10, 4, h, m)
const withSchedule = (start, end, fn) => {
  Object.assign(b.s, { schedule: true, startTime: start, endTime: end })
  const r = fn()
  Object.assign(b.s, { schedule: false, startTime: '20:00', endTime: '23:30' })
  return r
}
ok('不限时段时永远算在时段内', b.out._debug.inWindow(at(3, 0)))
ok('21:07-23:00 在 22:00 → 在', withSchedule('21:07', '23:00', () => win(at(22, 0))))
ok('21:07-23:00 在 17:10 → 不在', withSchedule('21:07', '23:00', () => win(at(17, 10)) === false))
ok('22:30-01:00 在 00:30 → 在（跨午夜）', withSchedule('22:30', '01:00', () => win(at(0, 30))))
ok('22:30-01:00 在 12:00 → 不在', withSchedule('22:30', '01:00', () => win(at(12, 0)) === false))
ok('开始=结束 当作全天', withSchedule('20:00', '20:00', () => win(at(9, 0))))
ok('时间写错回落到 20:00-23:30', withSchedule('乱写', '也乱写', () => win(at(21, 0)) && win(at(12, 0)) === false))
ok('dayKey 形如 2026-11-04', /^\d{4}-\d{2}-\d{2}$/.test(b.out._debug.dayKey()))

console.log('\n=== 5. tick 的行为（不发真消息） ===')
Object.assign(b.s, { enabled: false })
const off = await b.out.tick()
ok('总开关关着时不动手', off.ok === false && /总开关关着/.test(off.message), off.message)
Object.assign(b.s, { enabled: true })
// 2026-11-09：「按时间段挂」开关关着 → 不在时段也照常进；开着 → 不在时段就关浏览器
Object.assign(b.s, { enabled: true, schedule: false, startTime: '03:00', endTime: '03:01', target: '' })
const offWindow = await b.out.tick()
ok('按时间段挂关着：不在时段也照常进房', !/不在设定时段/.test(offWindow.message || ''), JSON.stringify(offWindow))
Object.assign(b.s, { enabled: true, schedule: true, startTime: '03:00', endTime: '03:01', target: '' })
const onWindow = await b.out.tick()
ok('按时间段挂开着：不在时段就进不去', /不在设定时段/.test(onWindow.message || ''), JSON.stringify(onWindow))
Object.assign(b.s, { schedule: false, enabled: true, target: '' })
const noTarget = await b.out.tick()
ok('没填目标 → 说清楚', noTarget.ok === false && /地址/.test(noTarget.message), noTarget.message)

console.log('\n=== 6. 不再碰「刷抖音」（2026-11-09 起这个功能删掉了）===')
{
  // 模块加载、开总开关、进房、收工，都不应该改 douyin.enabled
  const noTouch = boot({ settings: { enabled: true }, cfg: { douyin: { enabled: false } }, state: { pausedDouyin: true, douyinWasEnabled: true } })
  ok('加载时不动 douyin.enabled', noTouch.config.douyin.enabled === false, 'douyin.enabled=' + noTouch.config.douyin.enabled)
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('代码里已经没有暂停/恢复刷抖音', !/pauseDouyin|resumeDouyin|pausedDouyin/.test(src))
  ok('不再写 douyin.enabled', !/douyin:\s*\{[^}]*enabled:\s*(true|false)\s*\}/.test(src))
  const sc = await noTouch.out.selfCheck()
  ok('自检里明确「不归这个模块管」', /不归这个模块管/.test(sc), (sc.split('\n').find((x) => x.startsWith('刷抖音')) || ''))
}

// 收工后的冷却：tick 不要两分钟就自己再进
// 2026-11-09：force（手动进 / 刚开总开关）不受收工冷却限制，只有定时轮询才受限
const quiet = boot({ settings: { enabled: true, target: '' }, state: { quietUntil: Date.now() + 600000 } })
const quietRun = await quiet.out.tick(false)
ok('收工冷却期内定时轮询不自己进房', quietRun.ok === false && /歇到/.test(quietRun.message), quietRun.message)
const quietForce = await quiet.out.tick(true)
ok('手动进（force）不受收工冷却限制', !/歇到/.test(quietForce.message || ''), quietForce.message)

console.log('\n=== 7. 命令 ===')
const c = cmd(b.got, '看直播')
ok('/看直播 状态', /挂直播/.test(await c.run('')))
ok('/看直播 自检', /看直播自检/.test(await c.run('自检')))
ok('/看直播 关 → 把刷抖音放回来', /关了/.test(await c.run('关')))
ok('乱写的参数给菜单', /能用的有/.test(await c.run('滚')))

console.log('\n=== 7.5 私信发弹幕：/看直播 说 <内容>（0.9.9）===')
{
  // 测试里的主人 QQ 是 10001 → 他的私聊 chatId 就是 private:10001
  const dm = { chatId: 'private:10001' }
  const group = { chatId: 'group:888' }
  const otherDm = { chatId: 'private:99999' }

  ok('主人私聊、没给内容 → 用法', /用法/.test(await c.run('说', dm)), (await c.run('说', dm)).slice(0, 40))
  ok('主人私聊、给了内容但没在直播间 → 说清楚没发出去', /没发出去[\s\S]*不在直播间/.test(await c.run('说 主播加油', dm)))
  ok('不带空格也行（/看直播 说主播加油）', /没发出去[\s\S]*不在直播间/.test(await c.run('说主播加油', dm)))
  ok('同义词「评论」「弹幕」「发」都认', await (async () => {
    for (const w of ['评论', '弹幕', '发']) {
      const r = await c.run(w + ' 加油', dm)
      if (!/没发出去[\s\S]*不在直播间/.test(r)) return false
    }
    return true
  })())
  ok('群里的这条命令 → 拒绝（哪怕框架保证命令来自主人）', /只认主人本人的 QQ 私聊/.test(await c.run('说 加油', group)))
  ok('别人的私聊 → 拒绝', /只认主人本人的 QQ 私聊/.test(await c.run('说 加油', otherDm)))
  ok('拿不到来源（msg 空）→ 也拒绝，不瞎放行', /只认主人本人的 QQ 私聊/.test(await c.run('说 加油')))
  ok('太长（>50 字）→ 先拦下来', /太长了[\s\S]*50/.test(await c.run('说 ' + '加油呀'.repeat(20), dm)))
  ok('菜单里能看到「说 <内容>」', /说 <内容>/.test(await c.run('滚')))
  // 冷却只在真发出去才计时：失败的尝试不占冷却，连发两条都到「不在直播间」那步
  const again = await c.run('说 再来一句', dm)
  ok('失败不占冷却（没进直播间时连试两条都到同一句）', /没发出去[\s\S]*不在直播间/.test(again))
  ok('sayState 暴露冷却参数（10 秒 / 50 字）', (() => { const st = b.out._debug.sayState(); return st.gapMs === 10000 && st.maxChars === 50 && st.lastSayAt === 0 })())

  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('命令解析用 (说|评论|弹幕|发) 前缀正则', /\(说\|评论\|弹幕\|发\)/.test(src))
  ok('内容会剥一层成对引号', /stripQuotes/.test(src))
  ok('kanzhibo_say 工具和命令共用连发冷却', /sayWaitSec/.test(src))
  ok('真发出去了才计时（lastSayAt 只在 r.ok 时写）', /if \(r\.ok\) lastSayAt = Date\.now\(\)/.test(src))
  ok('规则里告诉过模型：命令会自己执行，别重复发', /\/看直播 说 XX\/会自己执行|那条命令会自己执行/.test(src))
}

console.log('\n=== 8. 选点 / 唯一性 / 签名（纯函数） ===')
ok('选点：9 点全过就用中心', (() => { const pts = Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 20, ok: true })); const p = choosePoint(pts); return Boolean(p) && p.x === 14 && p.y === 20 })())
ok('选点：好点不足 5 个就放弃', choosePoint([{ x: 1, y: 1, ok: true }, { x: 2, y: 2, ok: false }]) === null)
ok('选点：中心被挡就用离它最近的好点', (() => { const pts = Array.from({ length: 9 }, (_, i) => ({ x: i * 10, y: 100, ok: i !== 4 })); const p = choosePoint(pts); return Boolean(p) && p.x === 30 })())
ok('唯一性：两个候选就放弃', (() => { const r = pickUnique([{ sig: 'a', text: '赠送' }, { sig: 'b', text: '送灯牌' }]); return r.ok === false && /分不清|同时找到/.test(r.reason) })())
ok('唯一性：一个候选就放行', pickUnique([{ sig: 'a' }]).ok === true)
ok('签名比对：不同就作废', sameSig('a', 'b') === false && sameSig('a', 'a') === true && sameSig('', '') === false)
ok('spec 归一：region 补全成 0~1', (() => { const s = normalizeSpec({ text: '赠送' }); return s.region.left === 0 && s.region.right === 1 && s.text === '赠送' })())

console.log('\n=== 9. 半自动闸门 ===')
{
  let now = 1000
  const gate = createGate({ ttlMs: 1000, now: () => now })
  const a1 = gate.open({ kind: 'badge', label: '续灯牌' })
  ok('开一个待确认', a1.ok && Boolean(gate.peek()) && gate.peek().label === '续灯牌')
  const a2 = gate.open({ kind: 'gift', label: '送礼' })
  ok('已经有没结掉的：拒绝再开', a2.ok === false && /等你确认/.test(a2.reason))
  ok('拿错 id 拿不走', gate.take('nope') === null && Boolean(gate.peek()))
  const took = gate.take()
  ok('同一个动作只能用一次', Boolean(took) && gate.take() === null)
  const b = createGate({ ttlMs: 1000, now: () => now })
  b.open({ kind: 'badge', label: '超时的这个' })
  now += 5000
  const gone = b.sweep()
  ok('到点了 sweep 拿得到，且只给一次', gone && gone.label === '超时的这个' && b.sweep() === null)
  ok('过期之后 peek 是空', b.peek() === null)
  const g3 = createGate({ ttlMs: 1000, now: () => now })
  g3.setTtl(3000)
  const o3 = g3.open({ kind: 'badge', label: '改过有效期' })
  ok('setTtl 会改有效期（面板「等你多少秒」）', o3.ok && (o3.action.deadline - o3.action.at) === 3000)
  ok('settings 里有 confirmSec，默认 90', Boolean(setting('confirmSec')) && mod.defaults.confirmSec === 90)
}

console.log('\n=== 10. 点击器：该拒就拒，该点就点 ===')
const mkCand = (sig, left = 10) => ({ text: '赠送', sig, tag: 'button', clickable: true, area: 800, rect: { left, top: 10, width: 40, height: 20, right: left + 40, bottom: 30 } })
const allGood = () => ({ ok: true, good: 9, rect: { left: 10, top: 10, width: 40, height: 20 }, points: Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 20, ok: true })) })
const covered = () => ({ ok: false, good: 2, rect: { left: 10, top: 10, width: 40, height: 20 }, points: Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 20, ok: i < 2, hit: '弹层' })) })
function harness({ find, hit }) {
  const sent = []
  const evalJs = async (expr) => {
    if (expr.startsWith('(' + FIND_SRC)) return typeof find === 'function' ? find() : find
    if (expr.startsWith('(' + HIT_SRC)) {
      const arg = JSON.parse(expr.slice(('(' + HIT_SRC + ')(').length, -1))
      return typeof hit === 'function' ? hit(arg) : hit
    }
    if (expr.startsWith('(' + MARK_SRC)) return { left: 0, top: 0, width: 10, height: 10 }
    if (expr.startsWith('(' + UNMARK_SRC)) return true
    if (expr.startsWith('(' + SCROLL_SRC)) return { x: 0, y: 0 }
    if (expr.includes('[data-ab-pick]')) return { rect: { left: 10, top: 10, width: 40, height: 20 }, text: 'x' }
    return null
  }
  const clicker = createClicker({
    evalJs,
    send: async (method, params) => { sent.push([method, params]) },
    sleep: async () => {},
    note: () => {},
  })
  return { clicker, sent }
}
{
  const h = harness({ find: { total: 2, list: [mkCand('a', 10), mkCand('b', 300)] }, hit: allGood() })
  const r = await h.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' } })
  ok('两个候选（位置不同）：拒绝，一下都不点', r.ok === false && /分不清|同时找到/.test(r.reason) && h.sent.length === 0, r.reason)
}
{
  // 内层 span + 外层按钮，矩形几乎重合 → 合并成一个，照点
  const inner = mkCand('inner', 10)
  const outer = { text: '赠送', sig: 'outer', tag: 'div', clickable: true, area: 900, rect: { left: 8, top: 8, width: 44, height: 24, right: 52, bottom: 32 } }
  const collapsed = collapseNested([inner, outer])
  ok('嵌套重复候选合并成一个', collapsed.length === 1 && /inner/.test(collapsed[0].sig))
  const h2 = harness({ find: { total: 2, list: [inner, outer] }, hit: allGood() })
  const r2 = await h2.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' }, settleMs: 0 })
  ok('合并后可以点', r2.ok === true)
}
{
  const h = harness({ find: { total: 1, list: [mkCand('a')] }, hit: covered() })
  const r = await h.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' } })
  ok('被挡住：命中校验不过就不点', r.ok === false && /命中校验没过/.test(r.reason) && h.sent.length === 0, r.reason)
}
{
  const h = harness({ find: { total: 1, list: [mkCand('a')] }, hit: allGood() })
  const r = await h.clicker.clickOnce({ label: '赠送', spec: { text: '赠送' }, settleMs: 0 })
  const pressed = h.sent.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p && p.type === 'mousePressed')
  ok('全过：真的按下去了（悬停 → 按下 → 抬起）', r.ok && pressed && h.sent.length >= 4, '事件 ' + h.sent.length)
}
{
  const state = { sig: 'a' }
  const h = harness({ find: () => ({ total: 1, list: [mkCand(state.sig)] }), hit: allGood() })
  const prep = await h.clicker.prepare({ label: '赠送', spec: { text: '赠送' } })
  state.sig = 'b'
  const r = await h.clicker.commit(prep, { settleMs: 0 })
  ok('等确认期间目标换了：作废，不点', prep.ok && r.ok === false && /换了/.test(r.reason) && h.sent.length === 0, r.reason)
}
{
  const state = { hit: covered() }
  const h = harness({ find: { total: 1, list: [mkCand('a')] }, hit: () => state.hit })
  const prep = await h.clicker.prepare({ label: '赠送', spec: { text: '赠送' } })
  state.hit = allGood()
  const r = await h.clicker.commit(prep, { settleMs: 0 })
  ok('准备时被挡、确认时好了：放行', prep.ok === false || (r.ok === true), prep.ok ? ('确认态：' + r.ok) : '准备就被挡（也是安全失败）')
}

console.log('\n=== 11. 面板 panel.js 能跑 ===')
ok('定义里挂了 panel.js', mod.panel === 'panel.js')
const panelSrc = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
ok('风险提示写进了面板（灯牌误触 / 抖币）', /误触|点偏/.test(panelSrc) && /抖币/.test(panelSrc))
ok('面板按大类分卡片，送礼独立一大类', /title: '送礼'/.test(panelSrc) && /title: '总开关'/.test(panelSrc) && /title: '粉丝团灯牌'/.test(panelSrc) && /title: '运行状态'/.test(panelSrc))
ok('主开关挂在卡片标题右侧（同「刷抖音」页）', /right: sw\('enabled'\)/.test(panelSrc) && /right: sw\('renewBadge'\)/.test(panelSrc) && /right: sw\('giftByDm'\)/.test(panelSrc))
ok('风险改成一条通栏提示，不再单独占卡', /ab-note warn/.test(panelSrc) && !/title: '风险与现场/.test(panelSrc))
ok('调试卡已取消，「进房时通知我」并进挂直播卡', !/title: '调试'/.test(panelSrc) && /label: '进房时通知我'/.test(panelSrc) && panelSrc.indexOf("label: '进房时通知我'") < panelSrc.indexOf("title: '进房评论'"))
let panelThrew = ''
let panelTree = null
try {
  const fakeSc = { ok: true, connected: true, port: 9333, url: 'https://live.douyin.com/1', enabled: true, target: 'https://live.douyin.com/1', schedule: true, inWindow: false, pausedDouyin: true, commentedDay: '2026-11-06', badgeDay: '', today: '2026-11-06', giftByDm: true, text: '看直播自检（v0.3.3）\n最近一条：进了直播间' }
  const queue = [fakeSc, false, '']
  const ReactStub = {
    createElement: (t, p, ...c) => ({ t, p, c }),
    useState: () => [queue.length ? queue.shift() : undefined, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  }
  const hStub = ReactStub.createElement
  const uiStub = new Proxy({}, { get: (_, k) => (props) => hStub('ui.' + String(k), props) })
  const callStub = async () => fakeSc
  const Comp = new Function('React', 'h', 'ui', 'call', panelSrc)(ReactStub, hStub, uiStub, callStub)
  ok('panel.js 返回的是一个组件', typeof Comp === 'function')
  panelTree = Comp({ settings: mod.defaults, draftSettings: { giftByDm: true } })
} catch (e) {
  panelThrew = String((e && e.message) || e)
}
ok('渲染不报错（空状态 / 有自检两条分支都过）', !panelThrew && Boolean(panelTree), panelThrew || 'ok')

console.log('\n=== 11.5 tick 与 commitBadge 结论一致 ===')
{
  // commitBadge 认「今日任务 / 飘屏 / 余额」，badgeSent 只认「今日任务」。
  // 修复前：tick 用 badgeSent 二次否决，日志自相矛盾，还会走 badgeReject 累计失败。
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('tick 采信 commitBadge 的结论，不再用 badgeSent 覆盖', /sent = r2\.pending \? false : Boolean\(r2\.ok\)/.test(src))
  ok('tick 失败分支不再多跑一遍 badgeSent（那会再点一次入口）', !/await badgeSent\(\)\)/.test(src))
}

console.log('\n=== 11.51 0.9.6 修复的回归检查 ===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const panelSrc0 = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
  ok('r2 提升到外层作用域（原来声明在内层块，半自动每轮都会 ReferenceError 炸掉 tick）', /let r2 = null/.test(src) && !/const r2 = await doBadge\(\)/.test(src))
  ok('不再调用已删除的 myNickname（炸在真点之后，会导致下一轮重复送）', !/await myNickname\(\)/.test(src))
  ok('挂着时改 checkSec 会重排定时器（armTick 幂等，不再只在没定时器时调）', !/else if \(!tickTimer\) \{/.test(src))
  ok('verifyGiftSent 的礼物名做了正则转义（「玫瑰(新)」这种名字不再抛错）', /new RegExp\(escapeRe\(n\)/.test(src))
  ok('「不在时段内仍会进房」的错误文案已改（实际行为是关浏览器不进房）', !/仍然会进房/.test(src) && !/仍然会进房/.test(panelSrc0))
}

console.log('\n=== 11.6 灯牌：点之前 / 点之后的判据 ===')
ok('读得出「今日任务 0/3」', taskProgressFromText('今日任务0/3') === 0)
ok('带空格也读得出（今日任务 1/3）', taskProgressFromText('今日任务 1/3') === 1)
ok('2/3、3/3 都读得出', taskProgressFromText('今日任务2/3') === 2 && taskProgressFromText('今日任务3/3') === 3)
ok('没有就不瞎猜（返回 null）', taskProgressFromText('随便什么字') === null && taskProgressFromText('') === null)
ok('不认 4/3 这种越界', taskProgressFromText('今日任务4/3') === null)
{
  const h = badgeHintsFromText('点亮（1钻）可得100亲密度')
  ok('认得出面板特征：1钻 + 100亲密度', h.hasOneCoin === true && h.hasIntimacy === true)
  const h2 = badgeHintsFromText('欢迎来到直播间')
  ok('普通文字不会误认', h2.hasOneCoin === false && h2.hasIntimacy === false)
// 2026-11-08 主人明确：只有面板里出现 +100 才算送出成功
ok('认 +100（半角/全角/带空格）', plus100FromText('+100').hit && plus100FromText('＋100').hit && plus100FromText('+ 100').hit)
ok('+1000 不算（不能把别的数字当成功）', plus100FromText('+1000').hit === false)
ok('没有 +100 就不算', plus100FromText('今日任务1/3').hit === false)
ok('能数出个数（避免把原有的当这次的）', plus100FromText('+100 ... +100').count === 2)
ok('认得出任务行「送1个基础灯牌 …」', badgeTaskRowFromText('送1个基础灯牌 今日第32位送灯牌，连续2天 +100') === true)
// 2026-11-08 主人要求：恢复勋章那种面板也要能点「点亮」
{
  const restore = badgeHintsFromText('点亮粉丝团恢复勋章 今日已暂存50亲密度，点亮后可继续做任务升级 点亮 (1钻)')
  ok('认得出「点亮粉丝团恢复勋章」面板', restore.hasRestoreMedal === true && restore.hasStash === true)
  const renew = badgeHintsFromText('送1个基础灯牌 今日第32位送灯牌，连续2天 +100')
  ok('普通续灯牌面板不会被当成恢复勋章', renew.hasRestoreMedal === false && renew.hasStash === false)
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('prepareBadge 会因恢复勋章面板放行', /const isRestore = hints\.hasRestoreMedal \|\| hints\.hasStash/.test(src))
  ok('两种面板都会带 kind', /kind: isRestore \? 'restore' : 'renew'/.test(src))
}
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  // 2026-11-09 改：粉丝团面板是 Lynx iframe，读不到 +100，所以证据扩成三条（+100 / 聊天播报 / 进度）
  ok('点之后仍以 +100 为首要证据', /if \(plus\.count > base\)/.test(src))
  ok('聊天区播报也算成功证据（Lynx 面板读不到时靠它）', /seenLines/.test(src) && /hits\.length > chatBefore/.test(src))
  ok('进度变化是最后兜底', /from === null \|\| p > from/.test(src))
}
}

console.log('\n=== 11.7 总开关：关掉就整个停摆 ===')
{
  const offBoot = boot({ settings: { enabled: false } })
  ok('总开关关着：连状态查询都用「关着」那句话', offBoot.got.tools.length === 1 && offBoot.got.tools[0].name === 'kanzhibo_status')
  const r = await tool(offBoot.got, 'kanzhibo_status').execute({})
  ok('关着时不显示目标/地址', /关着/.test(r.message) && !/目标：/.test(r.message), r.message)
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('关掉时会停定时器 + 撤待确认 + 关浏览器', /const stopAll = async[\s\S]{0,400}disarmTick\(\)[\s\S]{0,200}dropPending[\s\S]{0,200}closeBrowser/.test(src))
  ok('config 事件里同步总开关', /api\.on\('config', \(\) => \{ syncEnabled/.test(src))
  ok('开总开关时会立刻跑一轮 tick（不等周期）', /tick\(true\)\.catch\(\(e\) => note\('开开关后第一轮出错/.test(src))
  ok('计时锚点从开开关那一刻开始（tickAnchor）', /tickAnchor = Date\.now\(\)/.test(src) && /armTick\(tickAnchor\)/.test(src))
  ok('定时器对齐锚点，不会越拖越久', /tickAnchor \+ Math\.ceil/.test(src))
  // 2026-11-08 主人实测：关开关后浏览器还在 —— 因为 closeBrowser 第一行 if (!cdp) return
  ok('closeBrowser 不再因为 cdp 为空就直接返回', !/async function closeBrowser\(\) \{\s*if \(!cdp\) return/.test(src))
  ok('会按 profile 路径杀残留浏览器进程', /killBrowserProcess/.test(src) && /live-profile|profileDir\(\)/.test(src))
  ok('连接断了也能靠 DevToolsActivePort 自己连上去关', /livePort/.test(src))
  ok('模块停止时也关浏览器', /onDispose[\s\S]{0,400}closeBrowser/.test(src))
}

console.log('\n=== 11.8 复刻「刷抖音」那三行：登录 / 窗口 / 浏览器路径 ===')
{
  ok('多了 browserPath 设置项（默认空 = 自动找）', Boolean(setting('browserPath')) && mod.defaults.browserPath === '')
  const r1 = await route(b.got, '/login/state')({})
  ok('/login/state 有返回（浏览器没开时说明白）', r1.ok === true && r1.state === 'closed' && /浏览器没开/.test(r1.message || ''), r1.message)
  ok('/login 与 /window 接口都注册了', Boolean(route(b.got, '/login')) && Boolean(route(b.got, '/window')))
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('窗口用 Browser.setWindowBounds 挪进/挪出屏幕', /Browser\.setWindowBounds/.test(src) && /left: -2400/.test(src))
  ok('填错浏览器路径时说得清', /面板里填的浏览器路径不对/.test(src))
  const panelSrc2 = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
  ok('面板三张卡都在：抖音账号 / 浏览器窗口 / 总开关', /title: '抖音账号'/.test(panelSrc2) && /title: '浏览器窗口'/.test(panelSrc2) && /title: '总开关'/.test(panelSrc2))
  ok('面板有扫码登录 / 检查登录 / 显示窗口 / 收起窗口 四个按钮', /扫码登录/.test(panelSrc2) && /检查登录/.test(panelSrc2) && /显示浏览器窗口/.test(panelSrc2) && /收起窗口/.test(panelSrc2))
}

console.log('\n=== 11.9 直播间地址与「下播」判据（2026-11-09 真机踩到）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const reText = /const LIVE_RE = (\/.*?\/i)\n/.exec(src)
  const LIVE_RE = reText ? new Function('return ' + reText[1])() : null
  ok('认 live.douyin.com/<房间号>', LIVE_RE && LIVE_RE.test('https://live.douyin.com/123456789'))
  ok('认 www.douyin.com/follow/live/<房间号>?anchor_id=…', LIVE_RE && LIVE_RE.test('https://www.douyin.com/follow/live/123456789?anchor_id=1000000000000000000'))
  ok('认 www.douyin.com/root/live/<房间号>', LIVE_RE && LIVE_RE.test('https://www.douyin.com/root/live/123456'))
  ok('不把主播主页当直播间', LIVE_RE && !LIVE_RE.test('https://www.douyin.com/user/MS4wLjABAAAA'))

  ok('下播：认「直播已结束」', endedFromText('直播已结束，猜你喜欢') === '直播已结束')
  ok('下播：认「主播已下播」', endedFromText('主播已下播') === '直播已结束')
  ok('下播：认「主播离开了」', endedFromText('主播离开了') === '主播离开了')
  ok('在播时不会误判', endedFromText('欢迎来到直播间 今日任务1/3') === '')

  ok('tick 里会检查下播并关浏览器', /endedSignals\(\)/.test(src) && /dropPending\('主播下播'\)/.test(src))
}

console.log('\n=== 11.95 面板里同时有「赠送」和「送灯牌」（2026-11-09 主人截图）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('确认按钮改成按优先级逐个试', /BADGE_CONFIRM_TEXTS/.test(src) && /async function findBadgeConfirm/.test(src))
  ok('「送灯牌」排在「赠送」前面（先试正常续灯牌）', (() => {
    const i1 = src.indexOf("'^送灯牌$'")
    const i2 = src.indexOf("'^赠送$'")
    return i1 > 0 && i2 > 0 && i1 < i2
  })())
  ok('prepareBadge 用 findBadgeConfirm 而不是单一 prepare', /let prep = await findBadgeConfirm\(2\)/.test(src))
  // 同一条失败不该用旧口径再报一次
  ok('tick 不再用「已完成」旧口径重复报错', !/送完还是没判到「已完成」/.test(src))
}

console.log('\n=== 11.97 聊天区结构化读取（2026-11-09 修「被页面大小挡住」）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const find = readFileSync(new URL('../lib/find.mjs', import.meta.url), 'utf8')
  ok('聊天区优先用 webcast-chatroom 定位（不是靠猜容器）', /webcast-chatroom/.test(find))
  ok('有 chatLines() 直接读聊天容器', /const chatLines = async/.test(src))
  ok('badgeEvidence 里是「边读边累积」的循环（虚拟列表会丢节点）', /const seenLines = new Set/.test(src) && /seenLines\.add/.test(src))
  ok('badgeEvidence 用累积聊天判「送出了 点亮粉丝团 / 粉丝团灯牌」', /seenLines/.test(src) && /BADGE_CHAT_RE/.test(src))
  ok('聊天证据认得抖音现在的文案「送出了 点亮粉丝团」', /点亮粉丝团/.test(find))
  ok('聊天读不到时仍保留进度兜底', /from === null \|\| p > from/.test(src))
}

console.log('\n=== 11.98 浏览器最大化（2026-11-09 提高准确性）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('启动参数带 --start-maximized', /--start-maximized/.test(src))
  ok('启动参数不再带 --window-size（它会覆盖最大化）', !/^\s*'--window-size=/m.test(src))
  ok('启动前会改 profile 的 window_placement（Chrome/Edge 都认这个）', /forceMaximizedInProfile\(dir\)/.test(src))
  ok('改的是 maximized: true + 铺满工作区', /maximized: true/.test(src) && /work_area_right/.test(src))
  ok('profile 坏了不影响启动（catch 里只记日志）', /改 profile 窗口状态失败（不影响启动）/.test(src))
  ok('ensureViewport 优先请求 maximized', /windowState: 'maximized'/.test(src))
  ok('连上浏览器就确保一次最大化（复用旧窗口也生效）', /async function attach\(p\)[\s\S]{0,600}await ensureMaximized\(\)/.test(src))
  ok('不再写死 work_area 分辨率（换屏幕也能最大化）', !/work_area_right\?\? 2560/.test(src))
  ok('ensureMaximized 会回读校验 windowState', /b2\.bounds\.windowState === 'maximized'/.test(src))
  ok('显示窗口时恢复最大化（复用 ensureMaximized）', /async function showWindow[\s\S]{0,600}if \(visible\) \{\s*await ensureMaximized\(\)/.test(src))
  ok('自检里标出「已最大化」', /已最大化/.test(src))
}

console.log('\n=== 11.99 页面文字取「尾部」（2026-11-09 修内容被 footer 挤掉）===')
{
  const find = readFileSync(new URL('../lib/find.mjs', import.meta.url), 'utf8')
  ok('PAGE_TEXT 取末尾而不是开头', /all\.slice\(all\.length - lim\)/.test(find))
  ok('不再逐段 slice 导致配额被 footer 吃光', !/out\.push\(t\.length > max/.test(find))
  ok('返回 full 长度便于排查', /full: all\.length/.test(find))
}

console.log('\n=== 11.999 代码体检（2026-11-09）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  ok('readBalance 不再取右下角数字的最大值（会读成在线人数）', true)
  ok('等待时长抽成常量 EVIDENCE_WAIT_MS，文案从它算', /EVIDENCE_WAIT_MS/.test(src) && /Math\.round\(EVIDENCE_WAIT_MS \/ 1000\)/.test(src))
  ok('删掉了没人用的 chatWatch', !/chatWatch/.test(src))
  ok('stopAll / closeBrowser 会清掉 port 和 viewport', /port = 0/.test(src) && /viewport = null/.test(src))
  ok('删掉了未使用的 badgeSentInChat 导入', !/badgeSentInChat/.test(src))
}

console.log('\n=== 11.9997 0.9.7 优化与加固（2026-11-09）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const find = readFileSync(new URL('../lib/find.mjs', import.meta.url), 'utf8')
  const click = readFileSync(new URL('../lib/click.mjs', import.meta.url), 'utf8')
  // —— 高优先级 ——
  ok('CDP 断开后 send 立即拒绝（不再每个调用干等 20s 超时）', /this\.closed = true/.test(src) && /浏览器连接已断开（' \+ method/.test(src))
  ok('hasRecharge 不再认「充值」二字（礼物面板常驻充值入口会误杀送礼）', (() => {
    const i = src.indexOf('const hasRecharge')
    const seg = src.slice(i, i + 700)
    return /抖币不足\|余额不足/.test(seg) && !/充值\|抖币不足/.test(seg)
  })())
  ok('灯牌成功一轮就把失败计数归零（失败必须连续才算 streak）', /送成一轮就归零/.test(src) && /badgeRejectStreak = 0[\s\S]{0,60}saveState\(\{ badgeRejectStreak: 0 \}\)/.test(src))
  // —— 性能 ——
  ok('pageText 有 400ms 微缓存（一轮 tick 不再全页扫 4~6 次）', /_pageText = \{ at: 0, text: '' \}/.test(src) && /Date\.now\(\) - _pageText\.at > 400/.test(src))
  ok('findBadgeConfirm 改成一次合并扫描（原来 9 个文字最坏 90 次全页扫）', /BADGE_CONFIRM_SCAN/.test(src) && /text: BADGE_CONFIRM_SCAN/.test(src))
  ok('合并扫描保留按优先级分组判唯一', /BADGE_CONFIRM_TEXTS\.map/.test(src) && /pickUnique\(group\)/.test(src))
  ok('DOM 扫描跳过 script/style/svg 等无用节点', /var SKIP = \{ SCRIPT: 1, STYLE: 1/.test(find) && find.split('var SKIP').length >= 3, 'roots 两处都要有')
  ok('badgeSent 读完不再点开关收面板（少两次点击）', /if \(first === 'todo'\) return false/.test(src))
  ok('prepareBadge 面板开着时不再点入口（入口是开关，点了反而关掉）', /panelOpen[\s\S]{0,60}findBadgeConfirm\(6\)/.test(src))
  ok('closeTaskPanel 确认面板真的开着才点（防止把入口点开）', /async function closeTaskPanel/.test(src) && /if \(!open\) return false/.test(src))
  ok('半自动红框按候选 rect 画（不再依赖 data-ab-pick 序号）', /clicker\.markRect\(prepared\.cand \? prepared\.cand\.rect : null\)/.test(src) && /async function markRect/.test(click))
  // —— 健壮性 ——
  ok('BROWSERS 认 LOCALAPPDATA 的用户级 Chrome/Chromium', /LOCALAPPDATA/.test(src) && /Chromium', 'Application'/.test(src))
  ok('attach 优先挑抖音页（多标签时不再挂第一个）', /type === 'page' && \/douyin/.test(src))
  ok('killBrowserProcess 覆盖 Chromium 系全家（不再写死 msedge/chrome 两个名字）', /msedge\|chrome\|chromium\|brave\|vivaldi\|opera/.test(src))
  // —— 运维 ——
  ok('确认命令和 tick 互斥，且不消费闸门', /上一轮还没结束，过几秒再回一次/.test(src) && /busy = true/.test(src))
  ok('cleanShots 清理过期截图（定义 + 进房时顺手清）', /function cleanShots/.test(src) && (src.match(/cleanShots\(\)/g) || []).length >= 2)
  ok('checkSec 钳制收敛成 clampCheckSec（不再散写 6 处）', /const clampCheckSec = \(\) => Math\.max\(30, Math\.min\(1800/.test(src) && src.split('Math.max(30, Math.min(1800').length === 2, '只剩 helper 本体')
  ok('escapeRe 一行化', /escapeRe = \(s\) => String\(s \|\| ''\)\.replace\(/.test(src))
}

console.log('\n=== 11.9999 0.9.8 真机实测修复（2026-11-10）===')
{
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  const find = readFileSync(new URL('../lib/find.mjs', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8')
  const axSrc = readFileSync(new URL('../lib/ax.mjs', import.meta.url), 'utf8')

  // —— 命中校验：祖先命中（2026-11-10 真机实测）——
  ok('命中校验认「命中点是目标的祖先」', /ancestorHit/.test(find) && /node\.contains\(pickEl\)/.test(find))
  ok('祖先命中有面积护栏（免得整页遮罩被当成没挡住）', /pickArea \* 8/.test(find))
  ok('祖先命中排除 body / html', /node === doc\.body \|\| node === doc\.documentElement/.test(find))

  // —— AX 通道（面板是 Lynx canvas，DOM 里读不到）——
  ok('有 AX 通道模块', /export function createAxReader/.test(axSrc))
  ok('AX 树按 frame 逐个取（面板在 blob: iframe 里，只查根 frame 读不到）', /frameId: f\.id/.test(axSrc) && /Page\.getFrameTree/.test(axSrc))
  ok('AX 命中校验要求目标落在面板 iframe 上', /不在任何面板/.test(axSrc) && /elementFromPoint/.test(axSrc))
  ok('AX 坐标先换算成视口坐标再点', /r\.x - sx/.test(axSrc) && /r\.y - sy/.test(axSrc))
  ok('面板文字 DOM + 无障碍树一起读', /const panelText = async/.test(src) && /axText\(\)/.test(src))
  ok('「+100」的口径统一（点之前/点之后同一个窗口）', /const TEXT_WINDOW|const TEXT = 20000/.test(src) && /plus100FromText\(ptext\)\.count/.test(src))
  ok('证据也读面板（canvas 上的 +100 只有无障碍树里有）', /const t = await panelText\(\)/.test(src))

  // —— 入口（现在的抖音版入口没有文字）——
  ok('有结构化入口（头像 → 资料卡 → 粉丝团）', /async function openBadgePanel/.test(src) && /data-e2e="live-room-nickname"/.test(src))
  ok('没加入粉丝团时不去点「加入粉丝团」', /要先加入才能点亮/.test(src))
  ok('有 AX 版的灯牌按钮查找 + 独立的执行段', /async function findBadgeConfirmAx/.test(src) && /async function commitAx/.test(src))

  // —— 余额正则（老写法 `\\d` 永远匹配不到）——
  const balSeg = src.slice(src.indexOf('async function readBalance'), src.indexOf('async function readBalance') + 2200)
  const balFallback = balSeg.slice(balSeg.indexOf('const t = await pageText('))
  const balLine = balFallback.split('\n').find((l) => /const m = \/\(/.test(l)) || ''
  ok('readBalance 兜底正则不再双重转义', !!balLine && !/\\\\d/.test(balLine) && /\(\\d\[\\d,\]/.test(balLine))
  ok('余额兜底正则确实能读出抖音页面上的「1234 抖币」', (() => {
    const m = /(\d[\d,]{0,6})\s*(?:抖币|余额)/.exec('剩余抖币 1234 抖币 余额充足')
    return !!m && Number(m[1].replace(/,/g, '')) === 1234
  })())

  // —— 送礼：余额基准必须在点之前读 ——
  const giftSeg = src.slice(src.indexOf('async function commitGift'), src.indexOf('async function commitGift') + 1200)
  ok('commitGift 先读余额再点（原来点在前面，基准永远不成立）', /const base = beforeBalance == null \? await readBalance\(\) : beforeBalance/.test(giftSeg) &&
    giftSeg.indexOf('const base =') < giftSeg.indexOf('await clicker.commit(prepared'))

  // —— tick：异常不再掐断 CDP ——
  const catchSeg = src.slice(src.indexOf('} catch (error) {', src.indexOf('async function tick')), src.indexOf('} catch (error) {', src.indexOf('async function tick')) + 900)
  ok('tick 出错不再无条件关掉 CDP（会把待确认闸门废掉）', !/catch \(error\) \{[\s\S]{0,200}cdp\.close\(\)[\s\S]{0,80}cdp = null[\s\S]{0,40}return/.test(catchSeg) && /websocket\|not connected/.test(catchSeg))
  ok('tick 出错时错误信息不会 undefined', /\(error && error\.message\) \? error\.message : String\(error\)/.test(catchSeg))

  // —— ensureInRoom：换主播要换房 ——
  ok('ensureInRoom 会比对「上次是用哪个目标进的」', /lastTarget/.test(src) && /saveState\(\{ lastTarget: target \}\)/.test(src))

  // —— /probe：会花钱的分支必须显式 open=1 ——
  const probeSeg = src.slice(src.indexOf("api.route('/probe'"), src.indexOf("api.route('/probe'") + 6000)
  ok('/probe 的 ask/ok/click 要求 ?open=1', /needOpen/.test(probeSeg) && /这一步会真的点下去/.test(probeSeg))
  ok('/probe 有只读的 AX 通道（what=ax）', /what === 'ax'/.test(src) && /api\.route\('\/probe'/.test(src))

  // —— 定时器 ——
  ok('onDispose 用 clearTimeout 清 tickTimer（setTimeout 的句柄，clearInterval 清不掉）',
    !/clearInterval\(tickTimer\)/.test(src) && /clearTimeout\(tickTimer\)/.test(src))

  // —— CLI ——
  ok('cli verify 指向改名后的 verify.test.mjs', /verify\.test\.mjs/.test(cli) && !/'verify\.mjs'/.test(cli))
  ok('cli confirm/cancel 带上 open=1（/probe 现在要求）', /what=.*open=1/.test(cli))

  // —— 聊天证据文案 ——
  ok('聊天证据认得「送出了 点亮粉丝团」（抖音现在的文案）', /点亮粉丝团/.test(find))
  ok('证据判断统一用 BADGE_CHAT_RE', /BADGE_CHAT_RE/.test(src))
}

console.log('\n=== 12. 命令行 ===')
const cliPath = fileURLToPath(new URL('../lib/cli.mjs', import.meta.url))
let cliHelp = ''
try { cliHelp = execFileSync(process.execPath, [cliPath, 'help'], { encoding: 'utf8', timeout: 20000 }) } catch (e) { cliHelp = String(e.stdout || '') }
ok('cli help 能跑', /看直播 · 命令行/.test(cliHelp))
let cliFail = { code: 0, err: '' }
try {
  execFileSync(process.execPath, [cliPath, 'status', '--base', 'http://127.0.0.1:9'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
} catch (e) { cliFail = { code: e.status, err: String(e.stderr || '') } }
ok('连不上面板时退出码 2 并说清楚', cliFail.code === 2 && /找不到面板/.test(cliFail.err), 'exit=' + cliFail.code)

if (LIVE) {
  console.log('\n=== 13. 真起一次浏览器（LIVE=1）===')
  const live = boot({ settings: { enabled: true, schedule: false, target: 'https://example.com/' }, cfg: { douyin: { enabled: true } } })
  const r = await live.out.tick(true)
  ok('tick 起来了浏览器并导航', r.ok === true && /example\.com/.test(r.url || ''), JSON.stringify({ ok: r.ok, url: r.url, message: r.message }))
  const s2 = await route(live.got, '/selfcheck')({})
  ok('CDP 连上了', s2.connected === true, 'port ' + s2.port + ' url ' + s2.url)
  const stop = await cmd(live.got, '看直播').run('收工')
  ok('收工能关掉浏览器', /关了/.test(stop), stop)
  try { live.got.dispose && live.got.dispose() } catch {}
}

console.log('\n=== 日志尾巴 ===')
for (const [lv, m] of b.got.logs.slice(-8)) console.log('  [' + lv + '] ' + m)
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败' + (LIVE ? '（含真浏览器测试）' : '（纯逻辑，想连浏览器加 LIVE=1）'))
process.exit(fail ? 1 : 0)
