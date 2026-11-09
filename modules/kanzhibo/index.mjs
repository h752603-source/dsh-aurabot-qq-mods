// 扩展模块「看直播」—— 放在 Aurabot 数据目录 modules/kanzhibo/ 里，插件升级不会动它。
// 保存就生效（几秒内自动重新加载），出错了去面板「已安装」页看原因。
//
// 干的事：
//   1. 用一台独立的 Edge 窗口挂在抖音直播间（给直播间地址，或给主播主页自己找「直播中」）。
//   2. 等页面真正加载出来（有评论框了）再发一条你自己定制的评论，同一个房间只发一次。
//   3. 按设置续粉丝团灯牌 / 送礼（半自动先截图发主人私聊，等一句「确认」才点）。

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createClicker } from './lib/click.mjs'
import { createGate } from './lib/gate.mjs'
import { createAxReader, axSig } from './lib/ax.mjs'
import { PAGE_TEXT_SRC, taskProgressFromText, badgeHintsFromText, plus100FromText, badgeTaskRowFromText, endedFromText, CHAT_LINES_SRC, collapseNested, pickUnique, choosePoint, sameSig, normalizeSpec, describeHit, BADGE_CHAT_RE } from './lib/find.mjs'

// 版本只写这一处：定义和自检里的字符串都读它，省得又出现「自检写着 v0.4.0」这种事。
// 2026-11-10 → 0.9.8：修灯牌入口点不成（命中校验把祖先当挡板）、面板读不到（改走无障碍树）、
//   聊天证据认不出「送出了 点亮粉丝团」、余额兜底正则失效、/probe 能不花钱就点开等一堆问题。
const VERSION = '0.9.9'

// 点完之后等证据的时间（ms）。放在这里，失败文案里的秒数也从它算，避免又写死一个 12。
const EVIDENCE_WAIT_MS = 20_000

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // 2026-11-09 加：Chrome / Chromium 的「用户级安装」默认落在 LOCALAPPDATA（很常见），
  //   光查 Program Files 会误报「找不到浏览器，先装一个」。
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe') : '',
].filter(Boolean)

// 2026-11-09：抖音直播间有两种地址，都要认：
//   https://live.douyin.com/<房间号>
//   https://www.douyin.com/follow/live/<房间号>?anchor_id=...（关注页点进来的）
const LIVE_RE = /^https:\/\/(?:live\.douyin\.com|(?:www|m)\.douyin\.com\/(?:[a-z-]+\/)*live)\/\d+/i

/** 从两种直播间地址里取房间号；取不到返回 ''。 */
const liveRoomId = (u) => {
  const s = String(u || '')
  const m = /^https?:\/\/(?:live\.douyin\.com|(?:www|m)\.douyin\.com\/(?:[a-z-]+\/)*live)\/(\d+)/i.exec(s)
  return m ? m[1] : ''
}

/** 这个地址看起来是「直播间」，而不是主播主页 / 别的页面。 */
const isLiveUrl = (u) => LIVE_RE.test(String(u || ''))
const isLiveTarget = (u) => {
  const s = String(u || '')
  if (isLiveUrl(s)) return true
  // 用户可能只贴了房间号
  return /^\d{6,}$/.test(s.trim())
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 找浏览器：面板里填了路径就先用它（填错/不存在会明确说出来），否则按 BROWSERS 顺序自动找。 */
function findBrowser(custom) {
  const want = String(custom || '').trim()
  if (want) return existsSync(want) ? want : ''
  return BROWSERS.find((p) => existsSync(p)) || ''
}

async function getJson(url, ms = 3000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    // 2026-11-09 加：连接断开后 ws.send() 是静默丢弃的（不抛错），挂起的请求只能干等
    //   20 秒超时才失败 —— 断线后一轮 tick 里每个 evalJs 都要白卡 20s。
    //   close 事件置位，send 里直接拒绝。
    this.closed = false
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
      else p.resolve(msg.result || {})
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('浏览器连接断了')) }
      this.pending.clear()
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连 CDP 超时')), 8000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连不上 CDP')) })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    // 2026-11-09 修：断开（或还没连上）就直接失败，别把 20 秒超时当成报错方式。
    if (this.closed || (this.ws.readyState !== undefined && this.ws.readyState !== 1)) {
      return Promise.reject(new Error('浏览器连接已断开（' + method + '）'))
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时：' + method)) }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws.close() } catch {}
  }
}

export default {
  id: 'kanzhibo',
  // 名字里有「抖音」：面板导航的分组是看模块名来分的（逛/刷/B站/抖音/小红书/闲鱼/淘宝/微博/知乎/贴吧/快手/触站/小黑盒 → 「平台」组，
  // 其余归一「系统」组）。所以这个模块要在「平台」下挂着，名字就得带上「抖音」。改名会连带面板标签一起变。
  name: '抖音看直播',
  version: VERSION,
  api: 1,
  // 面板「已安装」页那一行只显示 名字 / id / 状态 / description，不读 version 字段（客户端 ModuleRow 里没有这一项），
  // 所以版本号写在 description 开头，那一行才看得见；名字里不能加（名字决定导航分组，还要留给「平台」组认「抖音」）。
  description: 'v' + VERSION + ' · 挂抖音直播间 + 进房评论 + 续粉丝团灯牌 + 私信发弹幕（/看直播 说）；送礼另有一道锁（只认主人私聊）',

  defaults: {
    enabled: false,
    target: '',
    checkSec: 120,
    schedule: false,
    startTime: '20:00',
    endTime: '23:30',
    liveCommentOn: false,
    liveComment: '',
    commentDelaySec: 8,
    renewBadge: false,
    badgeDelaySec: 30,
    // 2026-11-06 加：送礼是花抖币的真动作，单独一道锁，默认关着。
    giftByDm: false,
    // 2026-11-06 加：半自动 —— 真点下去之前先截图发主人私聊，等他一句「确认」。
    semiAuto: true,
    // 等你点头等多少秒（超时就自动撤，不点）
    confirmSec: 90,
    browserPath: '',
    minuteReport: false,
  },
  // 面板是自定义的（panel.js 按大类分卡片）；字段清单放在 settingsSchema 里，自检脚本也读它。
  settings: [],
  settingsSchema: [
  // 顺序按「要不要挂 → 什么时候挂 → 挂谁 → 进房评论 → 灯牌 → 礼物 → 调试」排（面板里是按大类分的卡片）。
    // —— 挂直播：要不要挂 / 什么时候挂 ——
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉后这个模块什么都不做：不进房、不评论、不送灯牌、不送礼，浏览器也关掉' },
    { key: 'schedule', label: '按时间段挂', type: 'switch', hint: '开着 = 只在下面那段时间才启动 / 继续挂着；关掉 = 任何时候都进（时段只是标记）' },
    { key: 'startTime', label: '开始时间', type: 'text', placeholder: '21:07', hint: '24 小时制，写成 21:07' },
    { key: 'endTime', label: '结束时间', type: 'text', placeholder: '23:00', hint: '可以跨午夜，比如 22:30 → 01:00' },
    // —— 挂谁 ——
    {
      key: 'target',
      label: '直播间或主页',
      type: 'text',
      placeholder: 'https://live.douyin.com/123456789',
      hint: '直播间链接最稳；给主播主页（douyin.com/user/…）会自己找「直播中」点进去',
    },
    { key: 'checkSec', label: '多久看一次（秒）', type: 'number', min: 30, max: 1800, step: 30, hint: '不在直播间就重新进；改完立刻生效，不用重载模块' },
    // —— 进房评论（默认关）——
    { key: 'liveCommentOn', label: '进房发评论', type: 'switch', hint: '默认关。打开后每天最多发一次，同一个直播间不重复发' },
    { key: 'liveComment', label: '评论内容', type: 'textarea', hint: '多行只发第一行；留空就不发' },
    { key: 'commentDelaySec', label: '等几秒再发（秒）', type: 'number', min: 0, max: 120, step: 1, hint: '等画面和评论框出来，默认 8 秒' },
    // —— 粉丝团灯牌：真的会去点左上角那一块，有误触风险 ——
    {
      key: 'renewBadge',
      label: '续粉丝团灯牌',
      type: 'switch',
      hint: '⚠ 真会去点左上角：可能点偏到顶栏 / 礼物栏 / 别人的头像，点完会回读「今日任务」确认。细节看下面「风险与现场」',
    },
    { key: 'badgeDelaySec', label: '等几秒再续（秒）', type: 'number', min: 5, max: 600, step: 5, hint: '默认 30 秒。越早越容易点偏，宁晚不早' },
    // —— 礼物：花抖币，只认主人私聊 + 这道开关 ——
    {
      key: 'giftByDm',
      label: 'QQ 私信送礼',
      type: 'switch',
      hint: '打开后你在私聊里说「送个小心心」她才会真的送；关着就没这个本事。群里永远不送。花的是你的抖币，送出去没有撤回',
    },
    // —— 怎么动手（半自动 / 自动）——
    {
      key: 'semiAuto',
      label: '动作前先问我',
      type: 'switch',
      hint: '开 = 半自动：续灯牌 / 送礼之前，先把要点的位置截图发你私聊，回「/看直播 确认」才点；关 = 自动，直接点（照样要过命中校验）。90 秒不回就撤',
    },
    { key: 'confirmSec', label: '等你多少秒', type: 'number', min: 10, max: 600, step: 5, hint: '半自动默认 90 秒；到点没收到「确认」就自动撤销，不点' },
    // —— 调试 ——
    { key: 'browserPath', label: '浏览器路径', type: 'text', hint: '留空 = 自动找 Edge（找不到再找 Chrome / Chromium）', placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { key: 'minuteReport', label: '进房时通知我', type: 'switch', hint: '进房后私聊说一声' },
  ],
  panel: 'panel.js',   // 自动表单下面再加一张「风险与现场」卡（只读状态 + 误触提示）

  setup(api) {
    let cdp = null
    let port = 0
    let lastNote = ''
    // 收工 / 关掉后的一段时间里不要自己再开：不然 tick 两分钟一轮又把浏览器打开了
    let quietUntil = 0
    let commentedUrl = ''
    let badgeUrl = ''
    let clicker = null
    let viewport = null

    const profileDir = () => join(api.dataDir(), 'live-profile')
    const stateFile = () => join(api.dataDir(), 'state.json')

    const loadState = () => {
      try { return JSON.parse(readFileSync(stateFile(), 'utf8')) || {} } catch { return {} }
    }
    const saveState = (patch) => {
      try { writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }, null, 2)) } catch {}
    }

    // 进房评论每天只发一次：记住发过的那天，跨天自动重来
    const dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    let commentedDay = String(loadState().commentedDay || '')
    let badgeDay = String(loadState().badgeDay || '')
    let badgeReportDay = String(loadState().badgeReportDay || '')
    // 灯牌连续失败计数：连挂 3 次就当天降级成「提醒主人自己点」
    let badgeRejectDay = String(loadState().badgeRejectDay || '')
    let badgeRejectStreak = Number(loadState().badgeRejectStreak || 0)
    let badgeGiveUpDay = String(loadState().badgeGiveUpDay || '')

    const note = (text, level = 'info') => {
      lastNote = new Date().toLocaleTimeString() + ' ' + text
      api.log[level] ? api.log[level](text) : api.log.info(text)
    }

    // 2026-11-09：checkSec 的钳制原来写散在 6 个地方，统一收进来（armTick / 自检 / 面板接口都用）。
    const clampCheckSec = () => Math.max(30, Math.min(1800, Number(api.settings().checkSec) || 120))

    // —— 半自动闸门：一次只放一个动作，90 秒不回就撤 ——
    const gate = createGate({ ttlMs: 90_000 })
    let gateLater = null

    const ownerChat = () => {
      const q = api.config().ownerQQ
      return q ? 'private:' + q : ''
    }

    // —— 2026-11-09 新功能：QQ 私信里直接命令发弹幕 ——
    // 「/看直播 说 主播加油」→ 她在当前挂着看的直播间把这句话原样发出去。
    // 弹幕是用主人的抖音号**公开发出去**的，所以权限跟送礼同级收紧：
    //   只认「主人本人的 QQ 私聊」——群里（哪怕主人在）发这条命令会被直接拒绝。
    // 但不另设面板开关：内容就是主人指定的原话，不像送礼那样花抖币，没有误触损失。

    // 连发冷却：弹幕发太快容易被抖音风控（轻则限流重则封弹幕），
    // 命令（/看直播 说）和工具（kanzhibo_say）两条路共用一个冷却。
    // 只在**真发出去了**才计时：没进直播间、没点成发送的失败尝试不占冷却，
    // 主人修好问题（比如先 /看直播 进）立刻就能再发。
    const SAY_GAP_MS = 10_000
    let lastSayAt = 0
    const sayWaitSec = () => {
      const left = SAY_GAP_MS - (Date.now() - lastSayAt)
      return left > 0 ? Math.ceil(left / 1000) : 0
    }

    // 私信弹幕长度上限：抖音评论框本身就短（长了页面会截断 / 拒发），
    // 50 个字够说一句完整的话，也能挡住误粘贴一大段。
    const SAY_MAX_CHARS = 50

    // 命令里给内容剥一层成对引号：「主播加油」/ “主播加油” → 主播加油（只剥最外层一层）
    const stripQuotes = (s) => {
      const t = String(s || '').trim()
      const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]]
      for (const [a, b] of pairs) {
        if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) return t.slice(1, -1).trim()
      }
      return t
    }

    // 这条命令是不是主人本人的私聊里发来的。
    //   框架的 api.command 本来就只认主人，但主人也可能在**群里**敲这条命令 ——
    //   那时候 msg.chatId 是 group:…，照拒；必须是 private:<主人QQ> 才放行。
    const fromOwnerDm = (msg) => {
      const dm = ownerChat()
      return Boolean(dm) && String((msg && msg.chatId) || '') === dm
    }

    /** 给主人私聊发一句话 + 可选一张图（发不出去也不影响主流程）。 */
    async function tellOwner(text, imagePath) {
      const chat = ownerChat()
      if (!chat) return false
      if (text) { try { await api.sendText(chat, text) } catch (e) { note('私聊没发出去：' + (e && e.message), 'debug') } }
      if (imagePath) {
        try { await api.sendImage(chat, imagePath) } catch (e) { note('截图没发出去：' + (e && e.message), 'warn') }
      }
      return true
    }

    const shotsDir = () => {
      const dir = join(api.dataDir(), 'shots')
      try { mkdirSync(dir, { recursive: true }) } catch {}
      return dir
    }

    /**
     * 删掉 N 天前的截图（2026-11-09 加）。每次 aim / result / probe 都存一张 PNG，
     *   模块长年挂着跑，shots/ 会无限堆积到几个 GB —— 没人回看一周前的截图。
     * 模块加载时和每次进房时各清一次，单张删除失败不影响别的。
     */
    function cleanShots(keepDays = 7) {
      try {
        const dir = shotsDir()
        const cutoff = Date.now() - keepDays * 86_400_000
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.png')) continue
          const p = join(dir, f)
          try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p) } catch {}
        }
      } catch {}
    }
    cleanShots()

    /** 截当前页面（整屏，或只截某块）。给「等确认」和失败复盘用。 */
    async function shot(name, rect) {
      if (!cdp) return ''
      try {
        let params = { format: 'png' }
        if (rect) {
          const sc = await clicker.scroll()
          const pad = 28
          params = {
            format: 'png',
            clip: {
              x: Math.max(0, rect.left + sc.x - pad),
              y: Math.max(0, rect.top + sc.y - pad),
              width: Math.max(16, rect.width + pad * 2),
              height: Math.max(16, rect.height + pad * 2),
              scale: 1,
            },
            captureBeyondViewport: true,
          }
        }
        const r = await cdp.send('Page.captureScreenshot', params)
        const file = join(shotsDir(), name + '-' + Date.now() + '.png')
        writeFileSync(file, Buffer.from(r.data, 'base64'))
        return file
      } catch (e) {
        note('截图失败：' + (e && e.message), 'debug')
        return ''
      }
    }

    /**
     * 半自动第一段：把「要点的位置」截图发给主人，开一个待确认。
     * 这里不点任何花钱的按钮；截图里红框就是它打算按下去的地方。
     */
    async function askOwner({ kind, label, prepared, extra, data }) {
      const live = gate.peek()
      if (live) return { ok: false, message: '还有一个在等你确认：' + live.label + '（先回 /看直播 确认 或 /看直播 取消）' }
      let full = ''
      try {
        // 2026-11-09：红框直接按候选的 rect 画 —— 以前 mark(0) 依赖「上一次 find 的 0 号标记」，
        //   灯牌按钮改成合并扫描后 0 号不一定是它，红框可能框到别的东西上。
        await clicker.markRect(prepared.cand ? prepared.cand.rect : null)
        full = await shot(kind + '-aim', prepared.cand.rect)
      } finally {
        await clicker.unmark()
      }
      const sec0 = Math.max(10, Math.min(600, Number(api.settings().confirmSec) || 90))
      gate.setTtl(sec0 * 1000)
      const opened = gate.open({ kind, label, prepared, data: data || {}, shot: full })
      if (!opened.ok) return { ok: false, message: opened.reason }
      armGate()
      const sec = Math.round(gate.ttlMs / 1000)
      const lines = [
        '【等你点头】' + label,
        '要按的是：' + (prepared.cand ? prepared.cand.text : '') + '（' + prepared.desc + '）',
        '坐标：' + prepared.point.x + ',' + prepared.point.y + (viewport ? '　视口 ' + viewport.w + '×' + viewport.h : ''),
        extra || '',
        '红框那张图就是要点的位置。回 /看直播 确认 我就点；/看直播 取消 就撤；' + sec + ' 秒不回我自己撤。',
      ].filter(Boolean)
      await tellOwner(lines.join('\n'), full)
      note('等你确认：' + label + '（' + (prepared.cand ? prepared.cand.text : '') + '）', 'info')
      return { ok: false, pending: true, message: '要点的位置已经截图发你私聊了，等你回 /看直播 确认（' + sec + ' 秒）' }
    }

    /** 闸门过期扫描：到点了就撤，并告诉主人一声。 */
    const armGate = () => {
      if (gateLater) { try { gateLater() } catch {} }
      gateLater = api.later(gate.ttlMs + 5_000, async () => {
        gateLater = null
        const gone = gate.sweep()
        if (!gone) return
        note('待确认超时作废：' + gone.label, 'warn')
        await tellOwner('【已撤销】' + gone.label + '：等了 ' + Math.round(gate.ttlMs / 1000) + ' 秒没收到你的确认，这次不点了。')
        // 2026-11-09：等确认期间面板特意留着没关，超时作废了就顺手收掉。
        try { await closeTaskPanel() } catch {}
      })
    }

    /** 主人回「确认」：取走闸门 → 重新校验 → 真点 → 回报。只能用一次。 */
    async function confirmPending() {
      const live = gate.peek()
      if (!live) return '现在没有等你确认的动作（可能已经过期了）'
      // 2026-11-09 加：和 tick 互斥 —— 定时那轮还在跑（比如灯牌 delay 的 sleep 里）时回「确认」，
      //   commitBadge 会和 tick 并发操作同一个页面。这里不消费闸门，稍后再回一次就行。
      if (busy) return '上一轮还没结束，过几秒再回一次「确认」（这次还给你留着）'
      busy = true
      try {
        const action = gate.take()
        if (!action) return '这个确认已经过期了，这次不点。'
        if (action.kind === 'badge') {
          const pb = action.progressBefore === undefined ? (action.data && action.data.progressBefore) : action.progressBefore
          const pl = action.plusBefore === undefined ? (action.data && action.data.plusBefore) : action.plusBefore
          const r = await commitBadge(action.prepared, pb, pl)
          // 文字结论由命令/工具的返回值带走（会回到对应聊天），这里只补一张结果截图，不重复打字。
          if (r.shot) { try { await tellOwner('', r.shot) } catch {} }
          return (r.ok ? '✅ 灯牌：' : '⚠️ 灯牌：') + r.message
        }
        if (action.kind === 'gift') {
          const r = await commitGift(action.prepared, action.data.name, action.data.balance, action.data.directSend)
          return (r.ok ? '✅ 礼物：' : '⚠️ 礼物：') + r.message
        }
        return '这个确认没认出来，先不点。'
      } catch (e) {
        return '执行出错：' + ((e && e.message) || e)
      } finally {
        busy = false
      }
    }

    /** 主人回「取消」：把待确认撤掉；面板顺手按 Esc 收起来。 */
    async function cancelPending() {
      const live = gate.peek()
      if (!live) return '现在没有等你确认的事'
      gate.take()
      try {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      } catch {}
      note('主人取消了：' + live.label, 'info')
      return '撤了，这次不点。'
    }

    /** 收工 / 关掉时把待确认一起撤掉：截图已经过期，别让它在 90 秒后还能点一下。 */
    async function dropPending(reason) {
      const live = gate.peek()
      if (!live) return false
      gate.take()
      note('撤销待确认（' + reason + '）：' + live.label, 'info')
      return true
    }

    /** 灯牌连续失败 3 次：当天降级成提醒（一天只提一次）。 */
    async function badgeReject(why) {
      const today = dayKey()
      if (badgeRejectDay !== today) { badgeRejectDay = today; badgeRejectStreak = 0 }
      badgeRejectStreak++
      saveState({ badgeRejectDay: today, badgeRejectStreak })
      note('灯牌这轮没成：' + why, 'warn')
      if (badgeRejectStreak >= 3 && badgeGiveUpDay !== today) {
        badgeGiveUpDay = today
        saveState({ badgeGiveUpDay: today })
        await tellOwner('灯牌连着 3 次没点上（' + why + '）。今天先不自动试了，你顺手点一下？想让我再试就发 /看直播 灯牌')
      }
    }

    /**
     * 把直播间浏览器挪进屏幕 / 挪回屏幕外（参照「刷抖音」的显示窗口 / 收起窗口）。
     * 扫码登录、过短信验证、处理验证码都要看到窗口，所以得能把它拽到面前。
     */
    async function showWindow(visible) {
      if (!cdp) {
        if (!visible) return { ok: true, message: '浏览器没开' }
        await ensureBrowser()
      }
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      // 2026-11-09：默认就是最大化可见（准确性优先）。别先设 normal 再设 maximized ——
      //   那样窗口会「弹一下」，中间那一帧尺寸不对。
      if (visible) {
        await ensureMaximized()
      } else {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400, width: 1280, height: 900 } })
      }
      if (visible) await cdp.send('Page.bringToFront').catch(() => {})
      note(visible ? '把直播浏览器挪到屏幕上了' : '把直播浏览器挪回屏幕外', 'info')
      return { ok: true, message: visible ? '窗口已经在屏幕上了（扫码 / 验证都在里面做）' : '窗口收起来了' }
    }

    /**
     * 看这个专用 profile 登录了没有。
     * 判据：直播间页面右上角有没有头像 / 昵称，或者页面上有没有「登录」按钮。
     * 不调用接口、不改任何东西，纯读页面。
     */
    async function loginState() {
      if (!cdp) {
        const p = await livePort()
        if (p) { try { await attach(p) } catch {} }
      }
      if (!cdp) return { ok: false, state: 'closed', message: '浏览器没开，先发 /看直播 进 或点「扫码登录」' }
      const r = await evalJs(`(() => {
        const t = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ')
        const hasLoginBtn = /立即登录|登录后|登录抖音|扫码登录/.test(t)
        const avatar = document.querySelector('img[src*="aweme-avatar"], [class*="avatar"] img, [data-e2e*="avatar"]')
        const nick = /([^ ]{1,24})\s*(已关注|关注)/.exec(t)
        return {
          url: location.href,
          hasLoginBtn: hasLoginBtn,
          hasAvatar: Boolean(avatar),
          nickname: nick ? nick[1].slice(0, 24) : '',
        }
      })()`).catch(() => null)
      if (!r) return { ok: false, state: 'unknown', message: '读不到页面状态' }
      const logged = Boolean(r.hasAvatar) && !r.hasLoginBtn
      return {
        ok: true,
        state: logged ? 'in' : (r.hasLoginBtn ? 'out' : 'unknown'),
        nickname: r.nickname || '',
        url: r.url || '',
        message: logged
          ? '已登录' + (r.nickname ? '：' + r.nickname : '')
          : (r.hasLoginBtn ? '没登录（页面上有登录按钮）' : '看不出来，点「显示浏览器窗口」自己看一眼'),
      }
    }

    /** 扫码登录：把窗口挪出来，打开抖音登录页，二维码就在窗口里扫。 */
    async function openLogin() {
      await ensureBrowser()
      await showWindow(true)
      await navigate('https://www.douyin.com/')
      await sleep(2500)
      const st = await loginState()
      return {
        ok: true,
        message: '窗口已经挪到屏幕上了，在里头扫码登录（已登录的话就不用再扫）。' + (st.message ? '现在：' + st.message : ''),
        state: st.state,
      }
    }

    /** 现在在不在设定时间段里。没开定时 = 永远在。支持跨午夜（22:30 → 01:00）。 */
    const inWindow = (date = new Date()) => {
      const s = api.settings()
      if (!s.schedule) return true
      const toMin = (text, fallback) => {
        const m = /^(\d{1,2})\s*[:：]\s*(\d{2})$/.exec(String(text || '').trim())
        if (!m) return fallback
        return Math.max(0, Math.min(23, Number(m[1]))) * 60 + Math.max(0, Math.min(59, Number(m[2])))
      }
      const a = toMin(s.startTime, 20 * 60)
      const b = toMin(s.endTime, 23 * 60 + 30)
      const now = date.getHours() * 60 + date.getMinutes()
      if (a === b) return true
      return a < b ? now >= a && now < b : now >= a || now < b
    }

    // 收工 / 关掉后的一段时间里不要自己再开（quietUntil 存在 state.json）
    {
      const st = loadState()
      quietUntil = Number(st.quietUntil || 0)
    }

    async function attach(p) {
      const list = await getJson('http://127.0.0.1:' + p + '/json/list', 5000)
      // 2026-11-09：优先挑抖音相关的页 —— 浏览器里多开过标签时，第一个 page
      //   可能是 about:blank 或别的站，挂错页后面的全白做。
      const page = list.find((t) => t.type === 'page' && /douyin\.com/.test(String(t.url || '')))
        || list.find((t) => t.type === 'page')
      if (!page) throw new Error('浏览器里没有可用页面')
      cdp = await Cdp.connect(page.webSocketDebuggerUrl)
      port = p
      // 2026-11-09：凡是连上（新建 or 复用已有的）都确保一次最大化。
      //   之前只在 launch() 的 spawn 分支里做，所以「第二次开总开关」复用旧窗口时不会最大化。
      await ensureMaximized()
    }

    /**
     * 把 profile 里「上次窗口位置」改成最大化。
     * Chrome 和 Edge 都在 <profile>/Default/Preferences 的 browser.window_placement 里记窗口状态，
     * 启动时会优先恢复它 —— 这也是为什么光给 --start-maximized 没用。
     *
     * 2026-11-09 修：**不要写死 work_area / right / bottom**。
     *   之前写了 2560x1400，换一台机器或换分辨率就按错误尺寸铺，等于没最大化。
     *   现在只置 maximized: true，并删掉旧的具体边界 —— 让浏览器自己按**当前**工作区算。
     */
    function forceMaximizedInProfile(dir) {
      try {
        const prefFile = join(dir, 'Default', 'Preferences')
        if (!existsSync(prefFile)) return false
        const j = JSON.parse(readFileSync(prefFile, 'utf8'))
        if (!j.browser) j.browser = {}
        const cur = j.browser.window_placement || {}
        // 只保留工作区四个值（浏览器自己会更新），去掉写死的窗口边界
        j.browser.window_placement = {
          work_area_left: cur.work_area_left ?? 0,
          work_area_top: cur.work_area_top ?? 0,
          work_area_right: cur.work_area_right ?? 0,
          work_area_bottom: cur.work_area_bottom ?? 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          maximized: true,
        }
        delete j.browser.last_window_state
        writeFileSync(prefFile, JSON.stringify(j), 'utf8')
        note('已把 profile 的窗口状态标成最大化', 'debug')
        return true
      } catch (e) {
        note('改 profile 窗口状态失败（不影响启动）：' + ((e && e.message) || e), 'debug')
        return false
      }
    }

    /**
     * 确保窗口是最大化的（可重复调用，随便多少次）。
     * 2026-11-09：这是「换分辨率 / 第二次开」也生效的关键 ——
     *   不再只依赖启动参数和 profile，而是每次连上浏览器之后主动请求一次 maximized，
     *   并用 CDP 回读校验；不是最大化就再请求一次。
     */
    async function ensureMaximized() {
      if (!cdp) return false
      try {
        const w = await cdp.send('Browser.getWindowForTarget')
        const windowId = w && w.windowId
        if (!windowId) return false
        const b = await cdp.send('Browser.getWindowBounds', { windowId })
        if (b && b.bounds && b.bounds.windowState === 'maximized') return true
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }).catch(() => {})
        await sleep(600)
        const b2 = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null)
        const ok = Boolean(b2 && b2.bounds && b2.bounds.windowState === 'maximized')
        if (ok) note('窗口已最大化', 'debug')
        else note('窗口没能最大化（浏览器拒绝了这个请求）', 'warn')
        return ok
      } catch (e) {
        note('确认最大化失败：' + ((e && e.message) || e), 'debug')
        return false
      }
    }

    async function launch() {
      const custom = api.settings().browserPath
      const bin = findBrowser(custom)
      if (!bin) {
        throw new Error(String(custom || '').trim()
          ? '面板里填的浏览器路径不对：' + custom
          : '找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径')
      }
      const dir = profileDir()
      mkdirSync(dir, { recursive: true })

      try {
        const saved = Number(String(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
        if (saved && (await getJson('http://127.0.0.1:' + saved + '/json/version', 1200).catch(() => null))) {
          await attach(saved)
          return saved
        }
      } catch {}

      // 2026-11-09 关键修复：Chrome / Edge 会用 profile 里保存的窗口位置覆盖 --start-maximized。
      //   实测 Preferences 里 browser.window_placement.maximized = false、bottom/right = 1280x860，
      //   于是不管命令行怎么给，窗口一出来永远是那个小窗。
      //   所以启动前先把这段改成「最大化 + 铺满工作区」，两种浏览器都吃这一套。
      forceMaximizedInProfile(dir)

      const p = 9300 + Math.floor(Math.random() * 400)
      note('启动看直播专用浏览器')
      const child = spawn(bin, [
        '--user-data-dir=' + dir,
        '--remote-debugging-port=' + p,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
        // 2026-11-09：启动就最大化。
        // 关键：**不能同时给 --window-size** —— Chromium 里 window-size 会覆盖
        // --start-maximized，结果就是「先开一个小窗，再被 ensureViewport 改成大窗」。
        // 所以这里只给 --start-maximized（+ 起始位置），窗口一出来就是最大化。
        '--window-position=0,0',
        '--start-maximized',
        'about:blank',
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true })
      child.unref()

      for (let i = 0; i < 60; i++) {
        await sleep(250)
        if (await getJson('http://127.0.0.1:' + p + '/json/version', 900).catch(() => null)) {
          try { writeFileSync(join(dir, 'DevToolsActivePort'), p + '\n/devtools/browser/kanzhibo\n') } catch {}
          await attach(p)
          return p
        }
      }
      throw new Error('浏览器没起来')
    }

    async function ensureBrowser() {
      if (!cdp) await launch()
    }

    /** 从 DevToolsActivePort 拿端口，并确认它还活着；拿不到返回 0。 */
    async function livePort() {
      try {
        const saved = Number(String(readFileSync(join(profileDir(), 'DevToolsActivePort'), 'utf8')).split('\n')[0])
        if (!saved) return 0
        const ok = await getJson('http://127.0.0.1:' + saved + '/json/version', 1200).catch(() => null)
        return ok ? saved : 0
      } catch { return 0 }
    }

    /**
     * 按 profile 路径把残留的浏览器进程杀掉。
     * 只杀命令行里带我们 live-profile 目录的那些 —— 不碰你平时用的 Edge / Chrome。
     */
    function killBrowserProcess() {
      const dir = profileDir()
      try {
        if (process.platform === 'win32') {
          // 2026-11-09：不再按进程名过滤成 msedge/chrome 两种 —— 面板里 browserPath 可以填
          //   任意 Chromium 系浏览器（Brave / Vivaldi / 改名的便携版），写死会杀不掉残留进程。
          //   双保险：进程名得像 Chromium 系 + 命令行里带着 live-profile 目录。
          const script = [
            '-NoProfile', '-Command',
            "Get-CimInstance Win32_Process | " +
            "Where-Object { $_.Name -match '^(msedge|chrome|chromium|brave|vivaldi|opera)\\.exe$' -and $_.CommandLine -like '*" + dir.replace(/'/g, "''") + "*' } | " +
            'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
          ]
          execFileSync('powershell', script, { timeout: 20000, windowsHide: true })
        } else {
          execFileSync('pkill', ['-f', dir], { timeout: 10000 })
        }
        return true
      } catch (e) {
        note('按进程关浏览器失败：' + ((e && e.message) || e), 'warn')
        return false
      }
    }

    /**
     * 真的把浏览器关掉。三条路依次试，因为「cdp 连接」和「浏览器进程」不是一回事：
     *   ① 还有 cdp 连接 → Browser.close
     *   ② 连接断了但端口还活着（模块重载过、cdp 丢了）→ 自己连上去发 Browser.close
     *   ③ 还不退 → 按 live-profile 路径杀进程
     * 2026-11-08 修：原来第一行就是 if (!cdp) return —— 模块一重载 cdp 变 null，
     *   关总开关时这里直接空转，浏览器一直挂着（主人实测踩到）。
     */
    async function closeBrowser() {
      let asked = false
      if (cdp) {
        try { await cdp.send('Browser.close'); asked = true } catch {}
        try { cdp.close() } catch {}
        cdp = null
      }
      if (!asked) {
        const p = await livePort()
        if (p) {
          try {
            const v = await getJson('http://127.0.0.1:' + p + '/json/version', 1500)
            const ws = new WebSocket(v.webSocketDebuggerUrl)
            await new Promise((resolve) => {
              const done = () => { try { clearTimeout(timer) } catch {} resolve() }
              const timer = setTimeout(done, 2500)
              ws.addEventListener('open', () => {
                try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} })) } catch {}
                setTimeout(done, 300)
              })
              ws.addEventListener('error', done)
            })
            try { ws.close() } catch {}
          } catch {}
        }
      }
      await sleep(1200)
      const still = await livePort()
      if (still) {
        note('浏览器没自己退（端口 ' + still + ' 还在），改成按进程关掉', 'warn')
        killBrowserProcess()
        await sleep(1200)
      }
      const after = await livePort()
      if (after) {
        note('浏览器还活着（端口 ' + after + '），这次没关掉', 'warn')
        return false
      }
      // 关干净了就同步清掉内存里的端口 / 视口，别让状态显示成还连着
      port = 0
      viewport = null
      return true
    }

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      return r.result ? r.result.value : undefined
    }

    clicker = createClicker({
      evalJs: (expr) => evalJs(expr),
      send: (method, params) => cdp.send(method, params),
      sleep,
      note: (t, l) => note(t, l),
    })

    /**
     * 无障碍树（AX）通道。
     * 2026-11-10 真机实测：抖音的粉丝团面板是 Lynx canvas 渲染的 —— DOM 里、innerText 里
     * 一个字都读不到，只有 Chrome 的无障碍树里有（而且坐标就是页面坐标）。
     * 详细实测记录见 lib/ax.mjs 开头。
     */
    const ax = createAxReader({
      send: (method, params) => cdp.send(method, params),
      evalJs: (expr) => evalJs(expr),
      note: (t, l) => note(t, l),
    })

    /** 面板文字：DOM 读不到的那部分（canvas 画的）只能走这里。 */
    const axText = async () => {
      try { return await ax.text({ limit: 2000 }) } catch (e) { return '' }
    }

    /**
     * 主播下播了没有。
     * 抖音下播后 URL 仍然是 /live/<房间号>，光看地址会一直以为在直播间，
     * 于是 tick 每轮都「在房间里」，评论/灯牌的逻辑继续跑。页面出现这几句就是下播了。
     */
    const endedSignals = async () => endedFromText(await pageText(8000))

    /** 直接读聊天列表容器里的消息行（结构化，不依赖整页快照 / 滚动位置）。 */
    const chatLines = async (max = 60) => {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await evalJs('(' + CHAT_LINES_SRC + ')(' + max + ')')
          if (r) return r
        } catch (e) { if (i === 1) note('读聊天区失败：' + ((e && e.message) || e), 'debug') }
        if (i === 0) await sleep(400)
      }
      return { found: false, lines: [], total: 0 }
    }

    /**
     * 整页文字（跨同源 iframe / 影子树）：充值提示、今日任务、余额都从这儿找。
     * 2026-11-09 加：微缓存。一轮 tick 里整页文字要读 4~6 次，每次都遍历主文档 + iframe +
     *   影子树的全部节点，太贵。400ms 内的读共享一次扫描（每次动手之间都有 >400ms 的间隔，
     *   不会读到点了东西之前的旧状态）。内部统一按 20000 扫，按 max 切尾返回。
     */
    let _pageText = { at: 0, text: '' }
    const pageText = async (max = 20000) => {
      if (Date.now() - _pageText.at > 400) {
        try {
          const r = await evalJs('(' + PAGE_TEXT_SRC + ')(20000)')
          _pageText = { at: Date.now(), text: String((r && r.text) || '') }
        } catch {
          _pageText = { at: Date.now(), text: '' }
        }
      }
      const t = _pageText.text
      return t.length > max ? t.slice(t.length - max) : t
    }

    /**
     * 读整页 + 面板的文字（DOM 那一份 + 无障碍树那一份）。
     *
     * 2026-11-10 真机实测：抖音的粉丝团面板是 **Lynx canvas** 渲染的，
     * 面板里的「送1个基础灯牌 / +100 / 今日任务 1/3 / 点亮粉丝团」这些字
     * 在 document.body.innerText 里**一个字都读不到**，只有 Chrome 的无障碍树里有。
     * 所以两个都得读，缺一个就等于瞎。
     *
     * 窗口统一成 TEXT_WINDOW：算「点之前有几个 +100」和「点之后有几个 +100」必须同一个窗口，
     * 否则会把面板里本来就有的 +100 算成这次的（2026-11-10 修的口径不一致）。
     */
    const TEXT_WINDOW = 20000
    let _panelText = { at: 0, text: '' }
    const panelText = async () => {
      if (Date.now() - _panelText.at > 400) {
        const dom = await pageText(TEXT_WINDOW)
        let ax = ''
        try { ax = await axText() } catch {}
        _panelText = { at: Date.now(), text: dom + (ax ? '\n' + ax : '') }
      }
      return _panelText.text
    }

    /**
     * 坐标系契约（第③条）：固定窗口 / 视口 / 缩放，别让同一套判断今天对明天错。
     * 每次动手前调一次；拉不回来只记日志，不硬点。
     */
    async function ensureViewport() {
      // 2026-11-09：窗口一律确保最大化（不再是「先试最大化、失败退 1600x1000」——
      //   那个固定尺寸换分辨率就不对了）。ensureMaximized 内部会回读校验。
      await ensureMaximized()
      try { await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }) } catch {}
      try { await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }) } catch {}
      const vp = await evalJs('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scale: (visualViewport && visualViewport.scale) || 1 })').catch(() => null)
      if (vp) viewport = vp
      return viewport
    }

    async function currentUrl() {
      try { return String((await evalJs('location.href')) || '') } catch { return '' }
    }

    async function navigate(url) {
      await cdp.send('Page.enable').catch(() => {})
      await cdp.send('Page.navigate', { url })
      await sleep(3500)
    }

    /** 页面真的加载出来了没有：直播间有评论框才算渲染完。 */
    async function waitRoomReady(ms = 30000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        const ok = await evalJs(`(() => {
          const boxes = [...document.querySelectorAll('textarea, div[contenteditable="true"]')]
            .filter((el) => el.getClientRects().length)
          if (boxes.length) return true
          return /直播|直播间/.test(document.title || '')
        })()`).catch(() => false)
        if (ok) return true
        await sleep(1500)
      }
      return false
    }

    async function enterFromProfile(url) {
      await navigate(url)
      for (let i = 0; i < 6; i++) {
        const r = await evalJs(`(() => {
          const alive = [...document.querySelectorAll('a[href*="live.douyin.com"]')]
            .find((el) => /直播中|正在直播|LIVE/i.test(el.innerText || ''))
          if (alive) return { kind: 'link', url: alive.href }
          const btn = [...document.querySelectorAll('div,button,span')]
            .find((el) => /^直播中$/.test((el.innerText || '').trim()) && el.getClientRects().length)
          if (btn) { btn.click(); return { kind: 'click' } }
          return { kind: '' }
        })()`).catch(() => null)
        if (r && r.kind === 'link' && r.url) { await navigate(r.url); return 'link' }
        if (r && r.kind === 'click') { await sleep(3000); return 'click' }
        await sleep(2500)
      }
      return ''
    }

    /** 在直播间发一条评论。真实鼠标点框 → 输入 → 点发送/回车。 */
    async function sendComment(text) {
      const content = String(text || '').trim()
      if (!content) return { ok: false, message: '没说要发什么' }
      if (!cdp) return { ok: false, message: '现在不在直播间里' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }

      const box = await clickBy(
        `[...document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]')]
           .filter((el) => el.getClientRects().length && !el.disabled)
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '评论框',
      )
      if (!box) return { ok: false, message: '没找到评论输入框（页面可能还没加载完）' }
      if (box.blocked) return { ok: false, message: '评论框被挡住 / 命中校验没过（' + ((box.hit && box.hit.good) || 0) + '/9 点命中），这次不发' }
      await sleep(400)

      await cdp.send('Input.insertText', { text: content })
      await sleep(700)
      const typed = await evalJs(`(() => {
        const el = document.activeElement
        return el ? String(el.value || el.innerText || '').trim() : ''
      })()`).catch(() => '')
      if (!typed) return { ok: false, message: '字没进到评论框里' }

      const clickedBtn = await clickBy(
        `[...document.querySelectorAll('button,div,span')]
           .filter((el) => el.getClientRects().length && /^(发送|送出)$/.test((el.innerText || '').trim()))
           .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
        '发送按钮',
      )
      if (!clickedBtn || clickedBtn.blocked) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      }
      await sleep(1600)

      const left = await evalJs(`(() => {
        const el = document.activeElement
        return el ? String(el.value || el.innerText || '').trim() : ''
      })()`).catch(() => '')
      if (left && left.includes(content.slice(0, 3))) return { ok: false, message: '点了发送但框里还有字，可能没成功' }
      return { ok: true, message: '在直播间说了：' + content }
    }

    /**
     * 判定「今天的粉丝团灯牌送了没」。
     * 🔴 2026-11-03（主人指的位置）：看「今日任务」面板里那一行
     *   「粉丝团灯牌 … 已完成」——带「已完成 / 已送出 / 已领取」就算今天送过了。
     *   面板开着就直接读，关着就点开读一下再收起来；读不到一律当「没送」。
     */
    // 左上角「今日任务」入口（点它是开关：面板关着时点开、开着时点关）。提到这层是因为
    // badgeSent / prepareBadge / closeTaskPanel 都要用，别再各存一份。
    const TASK_ENTRY_EXPR = `(() => {
        const nodes = [...document.querySelectorAll('div,span,button,a')].filter((el) => {
          const r = el.getBoundingClientRect()
          if (!(r.width > 8 && r.height > 8 && r.top < innerHeight * 0.75 && r.left < innerWidth * 0.7)) return false
          const t = (el.innerText || '').trim()
          return t && t.length < 30 && /今日任务/.test(t)
        })
        if (!nodes.length) return null
        nodes.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
        return nodes[0]
      })()`

    async function badgeSent() {
      const readDomTask = () => evalJs(`(() => {
        // 只认「任务行」：灯牌 + （亲密度 / 已完成 / 送1个）这类字样；
        // 聊天区的「送出了 粉丝团灯牌 × 1」不算，别把它当任务面板。
        const rows = [...document.querySelectorAll('div,span,p,li')].filter((el) => {
          const t = (el.innerText || '').trim()
          if (!t || t.length > 160) return false
          if (!/灯牌/.test(t)) return false
          return /亲密度|已完成|送1个|粉丝团任务/.test(t)
        })
        if (!rows.length) return 'none'
        const texts = rows.map((el) => (el.innerText || '').trim())
        if (texts.some((t) => /已完成|已送出|已领取|已点亮/.test(t))) return 'sent'
        return 'todo'
      })()`).catch(() => 'none')

      // 面板可能整个在 iframe / 影子树里，上面那段查不到 —— 用整页文字兜底。
      const readTask = async () => {
        const dom = await readDomTask()
        if (dom === 'sent') return 'sent'
        // 2026-11-10：改用 panelText（DOM + 无障碍树）—— 面板是 Lynx canvas，
        //   「今日任务 X/3」在 innerText 里读不到，只有无障碍树里有。
        const t = await panelText()
        // 2026-11-08：新版左上角直接写「今日任务 X/3」，X>=1 就说明今天动过了，
        //   不用再靠「已完成 / 已点亮」那套文案（新版界面上已经看不到了）。
        if (taskProgressFromText(t) >= 1) return 'sent'
        if (!/灯牌|点亮粉丝团/.test(t)) return dom
        if (/灯牌[^\n]{0,30}(已完成|已领取|已点亮)/.test(t)) return 'sent'
        return dom
      }

      const taskEntry = TASK_ENTRY_EXPR

      const first = await readTask()
      if (first === 'sent') return true
      // 2026-11-09 优化：面板开着且显示「没送」就别点开关了 —— 原来这里点一下收起、
      //   紧接着 prepareBadge 又点一下打开，一轮对同一个入口最多点 3 次（慢，还多两次点偏的机会）。
      //   面板留给 prepareBadge 直接用；收不收由 closeTaskPanel 在流程收尾时统一管。
      if (first === 'todo') return false
      const opened = await clickBy(taskEntry, '今日任务')
      if (!opened || opened.blocked) return false
      await sleep(1800)
      const st = await readTask()
      return st === 'sent'
    }

    /**
     * 把「今日任务 / 粉丝团」面板收起来（如果还开着）。
     * 先读页面文字确认面板真的开着才点 —— 入口是开关，面板本来关着时点一下反而把它打开。
     * 判据只用「面板独有」的文案（送1个基础灯牌 / 100亲密度 / 恢复勋章 / 已暂存），
     * 「1钻」不算：礼物栏里也可能有带钻的价格。
     */
    async function closeTaskPanel() {
      try {
        const t = await panelText()
        const h = badgeHintsFromText(t)
        const open = badgeTaskRowFromText(t) || h.hasIntimacy || h.hasRestoreMedal || h.hasStash
        if (!open) return false
        const c = await clickBy(TASK_ENTRY_EXPR, '今日任务')
        if (c && !c.blocked) {
          await sleep(400)
          return true
        }
        // 2026-11-10 加：新版面板是 Lynx canvas，左上角根本没有「今日任务」这个入口，
        //   面板右上角倒是有个叉（#__living_right_panel_id 里那个 svg）。没有入口就点叉收掉。
        const x = await evalJs(`(() => {
          const panel = document.querySelector('#__living_right_panel_id')
          if (!panel) return null
          const svgs = [...panel.querySelectorAll('svg')].filter((s) => {
            const r = s.getBoundingClientRect()
            return r.width >= 12 && r.width <= 60 && r.height >= 12 && r.height <= 60 && r.top < 120
          })
          if (!svgs.length) return null
          const r = svgs[0].getBoundingClientRect()
          return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
        })()`).catch(() => null)
        if (!x) return false
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x[0], y: x[1], button: 'none', buttons: 0 }).catch(() => {})
        await sleep(120)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x[0], y: x[1], button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
        await sleep(60)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x[0], y: x[1], button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
        await sleep(400)
        return true
      } catch { return false }
    }

    /**
     * 灯牌：拆成「准备」和「确认后执行」两段。
     *   准备 = 点开左上角粉丝团入口（不花钱）+ 找出面板里的「赠送/点亮」按钮（只找不点）；
     *   执行 = 重新校验一次，签名没变、命中校验过了，才真按下去。
     * 2026-11-06：这套替换了原来的 el.click() —— 那版只要选错元素就直接点到别处去了。
     */
    const BADGE_ENTRY_SPEC = {
      text: '粉丝团|灯牌|加入粉丝团|点亮灯牌|续灯牌|今日任务',
      region: { top: 0, left: 0, right: 0.42, bottom: 0.78 },
      maxTextLen: 24,
      maxWidth: 220,
      maxHeight: 90,
    }
    // 抖音的按钮常把价格写在文字里：「点亮（1钻）」「赠送 10 钻」。所以价格括号要允许，
    // 但别的字一律不许跟 —— 「点亮粉丝团恢复勋章」这种标题就不会被当成按钮。
    //
    // 2026-11-09：同一块面板里可能同时出现「赠送」和「送灯牌」两个按钮（一个是恢复勋章、
    //   一个是续灯牌），文字不同 → 合并不到一起 → 候选唯一性直接拒绝，主人收到
    //   「⚠️ 灯牌：候选不唯一（2 个）」。改成**按优先级逐个试**，不是要求全局面板只有一个按钮。
    const BADGE_CONFIRM_TEXTS = [
      '^送灯牌$',                                  // 正常续灯牌
      '^送\\s*1\\s*个?$',
      '^赠送$',
      '^点亮\\s*[（(]\\s*\\d+\\s*钻\\s*[）)]$',   // 点亮（1钻）
      '^点亮$',
      '^续费$',
      '^送出$',
      '^一键点亮$',
      '^立即续费$',
    ]
    const BADGE_CONFIRM_SPEC = {
      text: '^(赠送|点亮|续费|送出|一键点亮|立即续费|送1个|送灯牌|点亮灯牌)(\\s*[（(][^）)]{0,8}[）)])?$',
      region: { top: 0.02, left: 0.2, right: 0.8, bottom: 0.9 },
      maxTextLen: 14,
      maxWidth: 260,
      maxHeight: 100,
      // 观众列表里也有「点亮」，靠祖先里那句「点亮粉丝团恢复勋章」把面板认出来
      ancestorText: '点亮粉丝团|恢复勋章|粉丝团灯牌|灯牌',
    }
    // 2026-11-09 优化：一次全页扫描用这个合并模式（原来 9 个文字逐个 prepare，
    //   每个最多 10 次 find，最坏 90 次全 DOM 扫描找一个按钮）。
    //   扫完再按优先级文字分组、逐组判唯一 —— 行为等价（同一文字内仍然要求唯一）。
    const BADGE_CONFIRM_SCAN = '^(?:' + BADGE_CONFIRM_TEXTS.map((t) => t.replace(/^\^/, '').replace(/\$$/, '')).join('|') + ')(?:\\s*[（(][^）)]{0,8}[）)])?$'

    /**
     * 无障碍树里的按钮名（Lynx canvas 面板专用）。
     * 实测抖音的文案是「点亮粉丝团」「送灯牌」「加入粉丝团」这些。
     * 注意「点亮粉丝团」在聊天区的播报里也会出现 —— 但聊天区在根 frame 里，
     * 而 AX 的命中校验要求目标**落在某个 iframe（面板）上**，所以聊天区那条会被自动挡掉。
     */
    const BADGE_AX_NAMES = /^(送灯牌|点亮粉丝团|点亮粉丝团灯牌|点亮灯牌|送1个基础灯牌|一键点亮|点亮|赠送|续费|送出|立即续费)$/

    /**
     * AX 通道找「要按的那个按钮」（Lynx canvas 面板）。
     *   名字 → 页面坐标 → 命中校验（这块位置得真的露在面板上）→ 连续两帧签名一样才收。
     * 找不到 / 校验不过就返回 ok:false，让上层继续走别的路。
     */
    async function findBadgeConfirmAx() {
      const cands = await ax.find(BADGE_AX_NAMES, { limit: 20 })
      if (!cands.length) return { ok: false, reason: '无障碍树里没有「送灯牌 / 点亮」这类按钮' }
      // 同一个名字、位置几乎重合的算一个
      const groups = new Map()
      for (const c of cands) {
        const key = c.name + '|' + Math.round(c.x / 8) + '|' + Math.round(c.y / 8)
        if (!groups.has(key)) groups.set(key, c)
      }
      const list = Array.from(groups.values())
      if (list.length > 1) {
        const names = list.slice(0, 3).map((x) => x.name).join(' / ')
        return { ok: false, reason: '面板里同时找到 ' + list.length + ' 个可能的按钮（' + names + '），分不清该点哪个' }
      }
      const cand = list[0]
      const h = await ax.hit(cand)
      if (!h.ok) return { ok: false, reason: describeHit(h) }
      const pt = choosePoint(h.points)
      if (!pt) return { ok: false, reason: '没有可点位置' }
      return {
        ok: true,
        label: '灯牌按钮（无障碍树）/ ' + cand.name + ' /',
        spec: normalizeSpec({ ...BADGE_CONFIRM_SPEC, text: BADGE_CONFIRM_SCAN }),
        allowMultiple: false,
        cand: { text: cand.name, sig: axSig(cand), rect: { left: cand.x, top: cand.y, width: cand.w, height: cand.h }, area: cand.w * cand.h, tag: 'ax', clickable: true, where: 'ax' },
        hit: h,
        point: pt,
        desc: describeHit(h),
        channel: 'ax',
        axSig: axSig(cand),
      }
    }

    /** 按优先级找「要按的那个按钮」：一次扫描 → 按文字分组判唯一 → 连续两帧同一签名才收。 */
    async function findBadgeConfirm(tries) {
      const rounds = Math.max(2, Math.min(6, Number(tries) || 2))
      let prev = null // 上一帧选中的（文字 + 签名 + 位置），用于「两帧一致才动手」
      const reasons = []
      for (let round = 0; round < rounds; round++) {
        const found = await clicker.find({ ...BADGE_CONFIRM_SPEC, text: BADGE_CONFIRM_SCAN })
        if (found.error) { reasons.push(found.error); if (round + 1 < rounds) await sleep(250); continue }
        const list = found.list || []
        for (const text of BADGE_CONFIRM_TEXTS) {
          let re
          try { re = new RegExp(text, 'u') } catch { continue }
          const group = collapseNested(list.filter((c) => re.test(String(c.text || '').trim())))
          if (!group.length) continue
          const u = pickUnique(group)
          if (!u.ok) { reasons.push(u.reason); continue }
          const stable = prev && prev.text === text && sameSig(prev.cand.sig, u.cand.sig) &&
            prev.cand.rect.left === u.cand.rect.left && prev.cand.rect.top === u.cand.rect.top
          prev = { text, cand: u.cand }
          if (!stable) break // 和 stableFind 一个规矩：等连续两帧一致
          const idx = Math.max(0, list.indexOf(u.cand)) // find 给候选编的 data-ab-pick 序号
          const h = await clicker.hit(idx)
          if (!h.ok) { reasons.push(describeHit(h)); prev = null; continue }
          const pt = choosePoint(h.points)
          if (!pt) { reasons.push('没有可点位置'); prev = null; continue }
          return { ok: true, label: '灯牌按钮 /' + text + '/', spec: normalizeSpec({ ...BADGE_CONFIRM_SPEC, text }), allowMultiple: false, cand: u.cand, hit: h, point: pt, desc: describeHit(h), channel: 'dom' }
        }
        // 2026-11-10 加：DOM 里找不到就问无障碍树 —— 现在的粉丝团面板是 Lynx canvas，
        //   按钮的文字压根不在 DOM 里，只在无障碍树里。
        const axr = await findBadgeConfirmAx()
        if (axr.ok) {
          // 连续两帧签名一样才收（和 DOM 通道一个规矩：别按一个正在动的按钮）
          if (prev && prev.channel === 'ax' && prev.axSig === axr.axSig) return axr
          prev = { channel: 'ax', axSig: axr.axSig }
          if (round + 1 < rounds) { await sleep(250); continue }
          return axr
        }
        reasons.push(axr.reason)
        if (round + 1 < rounds) await sleep(250)
      }
      return { ok: false, reason: '几个可能的按钮都没找到或不稳定（' + reasons.filter(Boolean).slice(0, 3).join('；') + '）' }
    }

    /**
     * 打开粉丝团面板。
     *
     * 2026-11-10 真机实测（现在的抖音 PC 版）：
     *   · 左上角的入口**没有文字** —— 是主播头像上的一个图片徽章，
     *     DOM 里 class 是哈希（.PvcS0FNI 这种），每版都变，不能写死；
     *   · **悬停**头像会弹出一张「主播资料卡」（这张卡是普通 DOM，能读到「粉丝团 / 团成员：11.0万」）；
     *   · 点卡里的「粉丝团」才会打开**粉丝团面板**（面板是 Lynx canvas，只有无障碍树读得到）。
     * 所以顺序是：头像 → 资料卡 → 粉丝团 → 面板。
     *
     * 老的「入口上带文字（今日任务 / 粉丝团）」那种版式也还留着 —— 先试它，找不到再走上面的路。
     */
    async function openBadgePanel() {
      // ① 老版式：入口本身带文字，直接按文字找（region 还是左上角那块）
      const entry = await clicker.clickOnce({
        label: '粉丝团/灯牌入口',
        spec: BADGE_ENTRY_SPEC,
        allowMultiple: true,
        settleMs: 2600,
      })
      if (entry.ok) {
        return { ok: true, entry: (entry.cand && entry.cand.text) || '', justOpened: true }
      }

      // ② 新版式：头像 → 资料卡 → 粉丝团
      const badge = await evalJs(`(() => {
        const nick = document.querySelector('[data-e2e="live-room-nickname"]')
        if (!nick) return []
        const nr = nick.getBoundingClientRect()
        const out = []
        for (const el of document.querySelectorAll('div,span,img,a,button')) {
          const r = el.getBoundingClientRect()
          if (!(r.width >= 18 && r.width <= 100 && r.height >= 18 && r.height <= 100)) continue
          if (r.top > nr.top + 40 || r.bottom < nr.top - 10) continue
          const gap = nr.left - r.right
          if (gap < -6 || gap > 160) continue
          let cs = null
          try { cs = getComputedStyle(el) } catch (e) {}
          // 越靠昵称、越像按钮的排前面
          const score = Math.max(0, gap) + (cs && cs.cursor === 'pointer' ? 0 : 60) + r.width * r.height / 1500
          out.push({ score, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) })
        }
        out.sort((a, b) => a.score - b.score)
        return out.slice(0, 5)
      })()`).catch(() => [])
      if (!badge || !badge.length) {
        return { ok: false, message: '入口没点成（粉丝团 / 今日任务都没找到），左上角也认不出头像：' + entry.reason }
      }
      for (const b of badge) {
        // 悬停 → 资料卡会冒出来
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 }).catch(() => {})
        await sleep(1400)
        const fan = await evalJs(`(() => {
          const nodes = [...document.querySelectorAll('div,span,a,button')].filter((el) => {
            const r = el.getBoundingClientRect()
            if (!(r.width > 20 && r.height > 10 && r.width < 320 && r.height < 140)) return false
            if (r.left > innerWidth * 0.35 || r.top > innerHeight * 0.55) return false
            const t = (el.innerText || '').trim()
            return /^粉丝团/.test(t)
          })
          if (!nodes.length) return null
          nodes.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)
          const el = nodes[0]
          const sp = el.querySelector('span') || el
          const r = sp.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: String(el.innerText || '').trim().slice(0, 24) }
        })()`).catch(() => null)
        if (!fan) continue
        // 点资料卡里的「粉丝团」→ 粉丝团面板
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fan.x, y: fan.y, button: 'none', buttons: 0 }).catch(() => {})
        await sleep(200)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fan.x, y: fan.y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {})
        await sleep(60)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fan.x, y: fan.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {})
        await sleep(3200)
        const opened = await fanPanelOpen()
        if (opened) return { ok: true, entry: '头像 → 资料卡 → ' + (fan.text || '粉丝团'), justOpened: true }
      }
      return { ok: false, message: '点了左上角头像也没打开粉丝团面板（资料卡里的「粉丝团」没找到）' }
    }

    /**
     * 粉丝团面板开没开。
     * 2026-11-10：不能只看文字 —— 聊天区的播报里也有「点亮粉丝团」，
     *   光看文字会把「聊天里有人送了灯牌」当成「面板开着」。
     *   所以先看 DOM 里那个面板容器（#__living_right_panel_id，里面有 iframe）在不在，
     *   再看无障碍树里的文字对不对得上。
     */
    async function fanPanelOpen() {
      const dom = await evalJs(`(() => {
        const p = document.querySelector('#__living_right_panel_id')
        if (!p) return false
        return !!p.querySelector('iframe')
      })()`).catch(() => false)
      if (!dom) return false
      const t = await panelText()
      return /粉丝团|送灯牌|点亮粉丝团|加入粉丝团|粉丝团专属|级团|点亮成员/.test(t)
    }

    /**
     * 点之前的三道确认（2026-11-10 按真机实测改）：
     *   ① 入口：左上角头像 / 资料卡里的「粉丝团」，或已经是「今日任务 0/3」；
     *   ② 等面板出来后：要看到「1钻」和「可得 100 亲密度」这类字，才算真的开对了面板；
     *   ③ 然后才去找「送灯牌 / 点亮」那个按钮（只找不点）。
     * 任何一条对不上就返回失败，绝不默认「大概是吧」。
     *
     * 2026-11-10 关键改动：面板文字要**同时**读 DOM 和无障碍树 ——
     *   现在的粉丝团面板是 Lynx canvas 渲染的，DOM 里一个字都没有，只有无障碍树里有。
     */
    async function prepareBadge() {
      await ensureViewport()

      // ① 先读进度：DOM 和无障碍树都要读。
      //    实测当前抖音版「今日任务 X/3」不在 innerText 里（它画在 canvas 上），
      //    读不到就当 null（不当成 0），后面靠「面板状态」和聊天播报去判断。
      const beforeText = await panelText()
      const progressBefore = taskProgressFromText(beforeText)
      const hasFanclub = /粉丝团/.test(beforeText)
      if (progressBefore !== null && progressBefore >= 1) {
        return { ok: false, message: '今日任务已经是 ' + progressBefore + '/3，今天动过了，不再送' }
      }
      if (progressBefore === null && !hasFanclub) {
        return { ok: false, message: '左上角既没有「今日任务 X/3」也没有「粉丝团」，现在不像能送灯牌的直播间' }
      }

      // 面板可能已经开着：先看按钮在不在，在就直接用（再点入口会把它关掉）
      let prep = await findBadgeConfirm(2)
      let entryText = ''
      let panelJustOpened = false
      if (!prep.ok) {
        // 2026-11-09 优化：面板开着（badgeSent 读完后特意留着 / 主人手动开过）就别点入口了 ——
        //   入口是开关，点一下反而把面板关掉，然后「找不到按钮」白忙一轮。
        //   用面板独有的文案判断开没开，和 closeTaskPanel 同一套判据。
        const t2 = await panelText()
        const h2 = badgeHintsFromText(t2)
        const panelOpen = badgeTaskRowFromText(t2) || h2.hasIntimacy || h2.hasRestoreMedal || h2.hasStash
        if (panelOpen) {
          prep = await findBadgeConfirm(6)
        } else {
          const opened = await openBadgePanel()
          if (!opened.ok) return { ok: false, message: opened.message }
          entryText = opened.entry
          panelJustOpened = opened.justOpened
          prep = await findBadgeConfirm(10)
        }
      }
      if (!prep.ok) {
        // 2026-11-10：面板上只有「加入粉丝团（1钻石）」时，先把话说清楚 ——
        //   那是**开通**按钮，不是「续灯牌」，点错就白花 1 钻。
        const ptext2 = await panelText()
        if (/加入粉丝团/.test(ptext2)) {
          return { ok: false, message: '这个直播间还没加入粉丝团（面板上是「加入粉丝团（1钻石）」），要先加入才能点亮，这次不点' }
        }
        return { ok: false, message: '面板里没找到可点的「送灯牌 / 点亮」：' + prep.reason }
      }

      // ② 面板内容确认。两种面板都认（2026-11-08 主人要求把恢复勋章也纳入）：
      //    A 续灯牌：「送1个基础灯牌 … +100」，按钮「送灯牌」
      //    B 恢复勋章：「点亮粉丝团恢复勋章 / 今日已暂存50亲密度」，按钮「点亮 (1钻)」
      const ptext = await panelText()
      const hints = badgeHintsFromText(ptext)
      const isRestore = hints.hasRestoreMedal || hints.hasStash
      const isRenew = hints.hasIntimacy || hints.hasOneCoin || badgeTaskRowFromText(ptext)
      // 2026-11-10 加：没加入粉丝团的面板长这样 —— 底下是「加入粉丝团（1钻石）」。
      //   那是**开通**按钮，不是「续灯牌」，点错就白花 1 钻 → 直接停手并说清楚。
      if (/加入粉丝团/.test(ptext) && !isRenew) {
        return { ok: false, message: '这个直播间还没加入粉丝团（面板上是「加入粉丝团（1钻石）」），要先加入才能点亮，这次不点' }
      }
      if (!isRestore && !isRenew) {
        return {
          ok: false,
          message: '面板里既没有「送1个基础灯牌 / +100」，也没有「点亮粉丝团恢复勋章」，不像粉丝团面板，这次不点（入口：' + (entryText || '面板本来就开着') + '）',
        }
      }

      return {
        ok: true,
        prepared: prep,
        entry: entryText || (hasFanclub ? '粉丝团' : '今日任务'),
        panelJustOpened,
        progressBefore,
        plusBefore: plus100FromText(ptext).count,
        hints,
        // B 类面板：勋章熄了，点「点亮 (1钻)」恢复；A 类：正常续灯牌
        kind: isRestore ? 'restore' : 'renew',
        buttonText: (prep.prepared && prep.prepared.cand && prep.prepared.cand.text) || '',
      }
    }

    /**
     * 点之后的验证（2026-11-08 主人明确了判据）：
     *   **只有在面板里出现「+100」才算送出成功。**
     * 进度从 0/3 变成 1/3 只是旁证，不能单独算成功 —— 页面可能还没刷新完、
     * 也可能读到的是别的任务行的数字。所以：
     *   · 出现 +100 → 成功，how 里带上当时看到的进度
     *   · 12 秒内没出现 +100 → 失败（哪怕进度涨了，也只写进备注，不算成）
     * 计数方式是「点之前页面上有几个 +100」→「点之后有没有多出来」，
     * 避免把面板里本来就有的 +100 当成这次的。
     */
    async function badgeEvidence(beforeProgress, plusBefore, nick) {
      const from = beforeProgress
      const base = Number.isFinite(plusBefore) ? plusBefore : 0
      // 点之前聊天区已有的「送出了 XX」条数（别人的也算，靠差值区分）
      const preChat = await chatLines(80)
      const chatBefore = (preChat.lines || []).filter((l) => BADGE_CHAT_RE.test(l)).length
      const seenLines = new Set(preChat.lines || [])
      const deadline = Date.now() + EVIDENCE_WAIT_MS
      let lastProgress = null
      let lastCount = 0
      let lastChat = chatBefore
      let round = 0
      while (Date.now() < deadline) {
        // 聊天区每轮都读（轻量：只查 ~15 个 item 节点）
        const c = await chatLines(80)
        for (const l of c.lines || []) seenLines.add(l)
        const hits = Array.from(seenLines).filter((l) => BADGE_CHAT_RE.test(l))
        lastChat = hits.length
        if (hits.length > chatBefore) {
          const own = nick ? hits.find((l) => l.includes(nick)) : hits[hits.length - 1]
          const p0 = lastProgress
          const prog0 = p0 === null ? '' : '，今日任务 ' + (from === null ? '?' : from) + '/3 → ' + p0 + '/3'
          return { ok: true, how: '聊天区播报了「' + String(own || hits[0]).slice(0, 40) + '」' + prog0, chat: hits.length, progress: p0 }
        }
        // 整页文字比较重（要扫 50+ 个 root），每两轮读一次就够判断进度/余额
        if (round % 2 === 0) {
          // 2026-11-10 修：面板里的字（+100 / 今日任务 / 亲密度）是 Lynx 画在 canvas 上的，
          //   DOM 文字里读不到 → 必须把无障碍树的文字也算进来。
          //   窗口统一用 TEXT_WINDOW（prepareBadge 算 plusBefore 时用的是同一个窗口），
          //   否则「点之前」和「点之后」口径不一致，会把面板里本来就有的 +100 算成这次的。
          const t = await panelText()
          const p = taskProgressFromText(t)
          if (p !== null) lastProgress = p
          const plus = plus100FromText(t)
          lastCount = plus.count
          const prog = p === null ? '' : '，今日任务 ' + (from === null ? '?' : from) + '/3 → ' + p + '/3'
          if (plus.count > base) {
            return { ok: true, how: '面板里出现了 +100' + prog, plus: plus.count, progress: p }
          }
          if (p !== null && (from === null || p > from) && p >= 1) {
            return { ok: true, how: '今日任务 ' + (from === null ? '?' : from) + '/3 → ' + p + '/3' + prog, plus: plus.count, progress: p }
          }
        }
        round++
        await sleep(700)
      }
      const tail = lastProgress === null ? '读不到今日任务进度' : '今日任务 ' + lastProgress + '/3'
      return {
        ok: false,
        how: Math.round(EVIDENCE_WAIT_MS / 1000) + ' 秒内没看到 +100 / 聊天播报 / 进度变化（' + tail + '，+100 ' + base + ' → ' + lastCount + '，聊天播报 ' + chatBefore + ' → ' + lastChat + '）',
        plus: lastCount,
        progress: lastProgress,
      }
    }

    /**
     * AX 通道的执行段（Lynx canvas 面板专用）。
     * 和 DOM 通道一个规矩：重新找一遍 → 签名必须一样 → 再验一次命中 → 才真点。
     */
    async function commitAx(prepared) {
      const cands = await ax.find(BADGE_AX_NAMES, { limit: 20 })
      const same = cands.find((c) => axSig(c) === prepared.axSig)
      if (!same) {
        return { ok: false, reason: '等你确认这会，目标不见了（' + ((prepared.cand && prepared.cand.text) || '那个按钮') + '），这次不点' }
      }
      const h = await ax.hit(same)
      if (!h.ok) return { ok: false, reason: describeHit(h), hit: h }
      const pt = choosePoint(h.points)
      if (!pt) return { ok: false, reason: '找不到可点位置' }
      await clicker.clickAt(pt.x, pt.y)
      note('确认后点了' + (prepared.label || '灯牌按钮') + ' @' + pt.x + ',' + pt.y, 'info')
      await sleep(1600)
      return { ok: true, point: pt, cand: prepared.cand, hit: h }
    }

    /** 执行：重新找 → 比对签名 → 再验命中 → 真点 → 查证据（只认 +100）。 */
    async function commitBadge(prepared, progressBefore, plusBefore) {
      await ensureViewport()
      // 点之前要记住「今日任务 X/3」和页面上已有的 +100 个数。
      // 2026-11-09：实参基本都会传（prepareBadge 已经算过），只有没传时才现读一次全页
      //   —— 全页扫描要遍历 50+ 个 root，能省就省。
      let beforeProgress = progressBefore
      let basePlus = plusBefore
      if (beforeProgress === undefined || basePlus === undefined) {
        const textBefore = await panelText()
        if (beforeProgress === undefined) beforeProgress = taskProgressFromText(textBefore)
        if (basePlus === undefined) basePlus = plus100FromText(textBefore).count
      }
      // 2026-11-10：面板是 Lynx canvas 时按钮只存在于无障碍树里，DOM 通道的 commit 找不到它，
      //   所以要按通道分开走。
      const r = prepared && prepared.channel === 'ax'
        ? await commitAx(prepared)
        : await clicker.commit(prepared, { settleMs: 1600 })
      if (!r.ok) return { ok: false, message: r.reason }
      await sleep(1500)
      const file = await shot('badge-result')
      // 2026-11-09 修 BUG：这里原来调 myNickname()，但那个函数在 0.9.1 清死代码时被删了 ——
      //   ReferenceError 炸在「真点已经按下去之后、badgeDay 写盘之前」，下一轮 tick 会再点一次，
      //   重复花钻。昵称本来就认不出哪条是自己发的（botQQ 对不上昵称），干脆不读：
      //   badgeEvidence 的判据不靠昵称 —— 「点之前没有、点之后多出来的那条播报」就是自己的。
      const nick = ''
      const ev = await badgeEvidence(beforeProgress, basePlus, nick)
      const today = dayKey()
      // 2026-11-06（真机跑出来的教训）：这一下已经按下去了，不管证据到没到，
      //   今天都必须记成「动过」——否则 2 分钟一轮的 tick 会再点一次，重复花钱。
      badgeDay = today
      badgeUrl = (await currentUrl()) || badgeUrl
      saveState({ badgeDay, badgeUrl, badgeEvidence: (ev.ok ? ev.how : '未确认：' + ev.how) })
      // 2026-11-09：送灯牌这轮的面板用完了，顺手收掉（best-effort，不影响结论）。
      //   半自动等确认期间面板特意开着（页面别动，签名才对得上），收的动作放在点了之后。
      try { await closeTaskPanel() } catch {}
      // 2026-11-09 修「一条结果被发三遍」：
      //   原来 commitBadge 自己 tellOwner 一次、命令/工具返回值又被主流程发一次、tick 再发一次。
      //   现在 commitBadge **只返回结论，不发私聊**；要发的地方只有两个：
      //   ① confirmPending（半自动确认后，本来就在私聊里对话）② tick（自动模式下需要通知）
      if (ev.ok) {
        // 2026-11-09 修：连续失败计数原来只在跨天时清零 —— 同一天「失败×2、成功、再失败」
        //   也会凑满 3 次触发「今天放弃」。送成一轮就归零，失败必须是连续的才算 streak。
        if (badgeRejectStreak !== 0) {
          badgeRejectStreak = 0
          saveState({ badgeRejectStreak: 0 })
        }
        if (badgeReportDay !== today) {
          badgeReportDay = today
          saveState({ badgeReportDay })
        }
        return { ok: true, message: '灯牌送出去了（' + ev.how + '）', shot: file, progress: beforeProgress, evidence: ev.how }
      }
      return { ok: false, message: '点了，但没确认到送出（' + ev.how + '）', shot: file, evidence: ev.how }
    }

    /** 灯牌一轮：半自动就先问主人，自动就直接点。 */
    async function doBadge() {
      const prep = await prepareBadge()
      if (!prep.ok) return prep
      if (api.settings().semiAuto) {
        return await askOwner({
          kind: 'badge',
          label: '续粉丝团灯牌',
          prepared: prep.prepared,
          // 把「点之前几/3」和面板里看到的两条特征一起带过去，确认之后照这个基准判成败
          progressBefore: prep.progressBefore,
          plusBefore: prep.plusBefore,
          data: { entry: prep.entry, hints: prep.hints, progressBefore: prep.progressBefore, plusBefore: prep.plusBefore, kind: prep.kind, buttonText: prep.buttonText },
          extra: (prep.kind === 'restore'
            ? '面板显示「点亮粉丝团恢复勋章 / 今日已暂存亲密度」，要按的是「' + (prep.buttonText || '点亮') + '」——勋章熄灭，点亮后恢复。'
            : '点了就是给「' + (prep.entry || '这个主播') + '」续一次灯牌（今日任务 ' +
              (prep.progressBefore === null ? '?' : prep.progressBefore) + '/3，面板里能看到 1钻 + 可得100亲密度）。') +
            '点完我会盯着面板等 +100，出现才算成功。',
        })
      }
      return await commitBadge(prep.prepared, prep.progressBefore, prep.plusBefore)
    }

    /**
     * 点一个「返回元素的表达式」（老的 finder 全部走这里）。
     * 现在补了三件事：先标出来 → 命中校验（9 点采样，被挡住就不点）→ 真坐标按下。
     * 返回 null = 没找到；{ blocked: true } = 找到了但不让点。
     */
    async function clickBy(finderExpr, label, opts) {
      return await clicker.clickExpr(finderExpr, label, opts)
    }

    const hasRecharge = async () => {
      const t = await pageText(20000)
      // 2026-11-09 修：不再认「充值」两个字 —— 抖音礼物面板里常驻一个「充值」入口字样，
      //   原判据在面板打开后（commitGift 的检查都在开面板之后跑）会永远误判成「要充值」，
      //   轻则误报失败，重则整个送礼链路被堵死。只认「结果性」文案。
      return /抖币不足|余额不足|不够抖币|余额不够/.test(t)
    }

    /** 右下角那一带的元素文字，找不到东西时打出来方便排查。 */
    async function dumpCorner() {
      const list = await evalJs(`(() => {
        const out = []
        for (const el of document.querySelectorAll('div,button,span,[aria-label]')) {
          const r = el.getBoundingClientRect()
          if (!el.getClientRects().length) continue
          if (r.top < innerHeight * 0.55 || r.left < innerWidth * 0.55) continue
          if (r.width > 300 || r.height > 300) continue
          const t = ((el.innerText || '') + '|' + (el.getAttribute('aria-label') || '')).trim()
          if (t && t.length <= 40) out.push(t)
        }
        return [...new Set(out)].slice(0, 30)
      })()`).catch(() => [])
      if (list && list.length) note('右下角能看到的元素：' + list.join(' / '), 'debug')
    }

    /** 礼物面板开没开：面板里有「赠送 / 背包 / 全部礼物」这类字样。 */
    async function giftPanelOpen() {
      const t = await pageText(12000)
      return /赠送|送出|背包|全部礼物|热门礼物|推荐\s*发现/.test(t)
    }

    /** 试着打开礼物面板：把像礼物按钮的元素按「越靠右下越优先」一个个点，点完检查面板有没有出来。
     *  2026-11-09 修：面板打开后**绝不再点礼物按钮 / 更多** —— 那是开关，再点一下就把面板关了。
     */
    async function openGiftPanel() {
      if (await giftPanelOpen()) return true
      const sel = `[...document.querySelectorAll('[data-e2e*="gift" i], [aria-label*="礼物"], [title*="礼物"], [class*="gift" i], [class*="Gift"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return el.getClientRects().length && r.width > 8 && r.height > 8 && r.bottom > innerHeight * 0.4
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right || b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)`
      for (let i = 0; i < 6; i++) {
        const hit = await clickBy(`${sel}[${i}]`, '礼物按钮#' + (i + 1))
        if (!hit || hit.blocked) break
        await sleep(1600)
        if (await giftPanelOpen()) return true
      }
      // 再退一步：找文字里有「礼物」的小元素
      const txt = await clickBy(
        `[...document.querySelectorAll('div,span,button')]
           .filter((el) => { const t = ((el.innerText || '') + (el.getAttribute('aria-label') || '')).trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /礼物/.test(t) && t.length <= 20 && r.width < 200 && r.height < 120 })
           [0]`,
        '礼物按钮（文字）',
      )
      if (txt) {
        await sleep(1600)
        if (await giftPanelOpen()) return true
      }
      return false
    }

    /**
     * 送礼：也拆两段。
     *   准备 = 打开礼物面板、按名字选中礼物（这一步不花钱）；
     *   执行 = 重新校验「赠送」按钮，签名没变才按。
     * 礼物名里的正则元字符先转义，别让「(新)」这种名字变成模式。
     */
    const escapeRe = (s) => String(s || '').replace(/[\\\^\$.*+?()\[\]{}|]/g, '\\$&')

    // 礼物格子：把底部那条常驻礼物栏排除掉 —— 那一条点下去也会直接送，而且不是「面板里的选择」。
    const GIFT_CELL_SPEC = (name) => ({
      text: escapeRe(name),
      region: { top: 0.08, left: 0.33, right: 0.86, bottom: 0.86 },
      maxTextLen: 26,
      maxWidth: 300,
      maxHeight: 170,
    })
    // 有些版式是「选中礼物 → 再点赠送」；赠送按钮的文字偶尔带价格（赠送 10钻）。
    const GIFT_CONFIRM_SPEC = {
      text: '^(赠送|发送|送出|立即赠送|赠送一个|送\\s*1)(\\s*[（(][^）)]{0,8}[）)])?$',
      region: { top: 0.08, left: 0.3, right: 0.92, bottom: 0.88 },
      maxTextLen: 12,
      maxWidth: 260,
      maxHeight: 120,
      ancestorText: '礼物|赠送|背包',
    }

    async function prepareGift(giftName) {
      const name = String(giftName || '').trim()
      if (!name) return { ok: false, message: '没说送什么礼物' }
      if (!cdp) return { ok: false, message: '现在不在直播间里' }
      if (!LIVE_RE.test(await currentUrl())) return { ok: false, message: '现在不在直播间里' }
      await ensureViewport()
      if (await hasRecharge()) return { ok: false, message: '页面显示抖币不足 / 余额不足，这次不送了' }

      const opened = await openGiftPanel()
      if (!opened) {
        await dumpCorner()
        return { ok: false, message: '礼物面板打不开（点了几次都没弹出来），日志里记了右下角能看到的东西' }
      }
      await sleep(2600)

      // ① 先看有没有独立的「赠送」按钮（选中 → 再送的版式）。有的话，花钱的就是它。
      const confirmFirst = await clicker.prepare({ label: '赠送按钮', spec: GIFT_CONFIRM_SPEC, tries: 2 })
      if (confirmFirst.ok) {
        return { ok: true, prepared: confirmFirst, name, balance: await readBalance(), directSend: false }
      }

      // ② 没有独立按钮：这个版式是「点礼物就直接送」。只定位，一下都不点。
      let cell = await clicker.prepare({ label: '礼物「' + name + '」', spec: GIFT_CELL_SPEC(name), tries: 6, allowMultiple: true })
      // ③ 面板里没有目标礼物：礼物面板常收在「更多」里，点一次「更多」展开全部再找
      if (!cell.ok) {
        const moreBtn = await clickBy(
          `[...document.querySelectorAll('div,span,button')]
             .filter((el) => { const t = (el.innerText || '').trim(); const r = el.getBoundingClientRect(); return el.getClientRects().length && /^更多$/.test(t) && r.width < 180 && r.height < 70 })
             .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]`,
          '更多',
        )
        if (moreBtn && !moreBtn.blocked) {
          await sleep(1500)
          cell = await clicker.prepare({ label: '礼物「' + name + '」（更多里）', spec: GIFT_CELL_SPEC(name), tries: 6, allowMultiple: true })
        }
      }
      if (!cell.ok) {
        await dumpCorner()
        return { ok: false, message: '礼物面板里找不到「' + name + '」：' + cell.reason }
      }
      return { ok: true, prepared: cell, name, balance: await readBalance(), directSend: true }
    }

    async function commitGift(prepared, name, beforeBalance, directSend) {
      await ensureViewport()
      if (await hasRecharge()) return { ok: false, message: '页面显示抖币不足 / 余额不足，停下来没送' }
      // 2026-11-10 修 BUG：原来余额基准是在 clicker.commit **之后**才补读的
      //   （beforeBalance == null ? await readBalance() : beforeBalance）—— 那时钱已经扣了，
      //   after < before 永远不成立，「余额变少」这条证据整个是死的。
      //   现在：基准一律在点之前读；读不到就当没有余额证据（后面还有成功提示 / 飘屏两条路）。
      const base = beforeBalance == null ? await readBalance() : beforeBalance
      const r = await clicker.commit(prepared, { settleMs: directSend ? 1400 : 900 })
      if (!r.ok) return { ok: false, message: r.reason }
      const proof = await verifyGiftSent(name, base)
      if (await hasRecharge()) return { ok: false, message: '送完弹出了余额不足提示，去手机上看一眼，别重复送' }
      if (proof.ok) return { ok: true, message: '送了「' + name + '」×1（已确认：' + proof.how + '）' }
      return { ok: false, message: '按了，但读了 8 秒没找到送出的证据（' + proof.how + '），你去直播间看一眼，别重复送' }
    }

    /** 送礼一轮：半自动先问主人，自动直接点。 */
    async function sendGift(giftName) {
      const prep = await prepareGift(giftName)
      if (!prep.ok) return prep
      if (api.settings().semiAuto) {
        return await askOwner({
          kind: 'gift',
          label: '送礼物「' + prep.name + '」',
          prepared: prep.prepared,
          extra: prep.directSend
            ? '⚠ 这个版式是「点礼物就直接送」，按下去就花抖币、没有撤回。'
            : '点的是「赠送」按钮，按下去就花抖币、没有撤回。',
          data: { name: prep.name, balance: prep.balance, directSend: prep.directSend },
        })
      }
      return await commitGift(prep.prepared, prep.name, prep.balance, prep.directSend)
    }

    /**
     * 读页面上的抖币余额；读不到返回 null。
     * 先在右下角礼物条那一带找「纯数字」的叶子节点（余额就在那儿），再退回整页文字里的「N 抖币」。
     * 不能直接拿「N 钻」匹配：礼物价格也都是「1钻 / 99钻」，会把价格当余额。
     */
    async function readBalance() {
      // 2026-11-09 修 BUG：原来把「右下角所有纯数字取最大值」当余额，
      //   一旦页面上还有「在线观众 132」「热度 999」这类数字，就会读错，
      //   于是 verifyGiftSent 的「余额变少」判据整个失效（甚至误判成成功/失败）。
      //   现在：只认「礼物栏那一行、且紧挨着钻石图标/礼物按钮的那一个数字」；
      //   有多个候选时**放弃**（返回 null），宁可不判也不读错。
      const dom = await evalJs(`(() => {
        const cands = []
        for (const el of document.querySelectorAll('div,span,p')) {
          if (el.children.length) continue
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) continue
          // 礼物栏那一行：底部 12% 内、水平在 45%~95%（左边是礼物格，右边是余额）
          if (r.top < innerHeight * 0.88) continue
          if (r.left < innerWidth * 0.45 || r.left > innerWidth * 0.95) continue
          const t = (el.textContent || '').trim()
          if (!/^\\d{1,7}$/.test(t)) continue
          cands.push({ v: Number(t), left: Math.round(r.left), top: Math.round(r.top) })
        }
        if (!cands.length) return null
        // 余额是这一行里**最靠右**的那个数字
        cands.sort((a, b) => b.left - a.left)
        // 最靠右的两个如果数值相同，说明读到的是同一处；不同则只信最右那个
        return cands[0].v
      })()`).catch(() => null)
      if (typeof dom === 'number' && Number.isFinite(dom) && dom >= 0) return dom
      const t = await pageText(20000)
      // 2026-11-10 修 BUG：原来写的是 /(\\d[\\d,]{0,6})\\s*(?:抖币|余额)/ —— 普通 JS 正则字面量里
      //   反斜杠只转义一次，`\\d` 会被当成「字面的反斜杠 + d」，所以这条兜底**永远匹配不到**。
      //   实测：'剩余抖币 1234 抖币 余额充足' 用老写法匹配结果是 null，用新写法才匹配到 '1234 抖币'。
      const m = /(\d[\d,]{0,6})\s*(?:抖币|余额)/.exec(t)
      return m ? Number(m[1].replace(/,/g, '')) : null
    }

    /** 送礼后的回读：余额变少 / 出现送出成功提示 / 礼物飘屏里有这个名字，三者算一个就算成了。 */
    async function verifyGiftSent(name, beforeBalance) {
      const deadline = Date.now() + 8000
      let how = '余额没变、也没看到成功提示'
      while (Date.now() < deadline) {
        await sleep(1200)
        const after = await readBalance()
        if (beforeBalance != null && after != null && after < beforeBalance) {
          return { ok: true, how: '抖币 ' + beforeBalance + ' → ' + after }
        }
        const hit = await (async () => {
          const t = await pageText(20000)
          if (/赠送成功|送出成功|已送出|送礼成功|再送一个/.test(t)) return 'success-toast'
          const n = String(name || '')
          // 2026-11-09 修：礼物名里可能带正则元字符（「玫瑰(新)」），直接拼 RegExp 会抛错 —— 用 escapeRe。
          if (n && new RegExp(escapeRe(n) + '\\s*[x×]\\s*\\d').test(t)) return 'gift-banner'
          return ''
        })()
        if (hit === 'success-toast') return { ok: true, how: '页面出现赠送成功提示' }
        if (hit === 'gift-banner') return { ok: true, how: '礼物飘屏里出现了它' }
        if (after == null && beforeBalance == null) how = '页面上读不到抖币余额'
      }
      return { ok: false, how }
    }

    async function ensureInRoom(overrideTarget) {
      const s = api.settings()
      const target = String(overrideTarget || s.target || '').trim()
      if (!target) return { ok: false, message: '还没填直播间地址或主播主页' }

      await ensureBrowser()
      let url = await currentUrl()
      if (!url) {
        try { cdp?.close() } catch {}
        cdp = null
        await ensureBrowser()
        url = await currentUrl()
      }

      // 已经在直播间里就留着，别刷新 —— 刷新会把播放和评论都打断。
      // 只有明确指定了另一个直播间（id 不同）才换房。
      //
      // 2026-11-10 修 BUG：原来只比房间号（wantId）。目标是**主播主页**时 wantId 取不到，
      //   于是 `!wantId` 直接当成「同一个房间」返回 —— 主人换了主播，模块还挂在老主播的房间里，
      //   灯牌也送给老主播去了。现在多比一个「上次是用哪个目标进的」（记在 state 里），
      //   目标变了就换房；目标是房间号时仍然按房间号比。
      const lastTarget = String((loadState() || {}).lastTarget || '')
      const sameTarget = !lastTarget || lastTarget === target
      if (isLiveUrl(url)) {
        const curId = liveRoomId(url)
        const wantId = liveRoomId(target) || (/^\d{6,}$/.test(String(target).trim()) ? String(target).trim() : '')
        if (wantId && curId) {
          if (wantId === curId && sameTarget) return { ok: true, url, joined: false }
        } else if (sameTarget) {
          return { ok: true, url, joined: false }
        }
        note('目标变了（' + (target || '?') + '），换房', 'debug')
      }

      if (isLiveUrl(target)) {
        const want = target.trim()
        await navigate(want)
        saveState({ lastTarget: target })
        note('进了直播间：' + want)
        return { ok: true, url: want, joined: true, roomId: liveRoomId(want) }
      }
      // 只给了房间号的情况
      if (/^\d{6,}$/.test(String(target).trim())) {
        const one = 'https://live.douyin.com/' + String(target).trim()
        await navigate(one)
        saveState({ lastTarget: target })
        note('进了直播间：' + one)
        return { ok: true, url: one, joined: true, roomId: liveRoomId(one) }
      }
      if (/douyin\.com\/user\//.test(target)) {
        const how = await enterFromProfile(target)
        const now = await currentUrl()
        if (how && LIVE_RE.test(now)) {
          saveState({ lastTarget: target })
          note('主播在播，已经进去了：' + now)
          return { ok: true, url: now, joined: true }
        }
        note('主播现在没在播（页面停在主页）', 'debug')
        return { ok: true, url: now, joined: false, message: '现在没在播' }
      }
      if (/^https?:\/\//.test(target)) {
        await navigate(target)
        saveState({ lastTarget: target })
        return { ok: true, url: target, joined: true }
      }
      throw new Error('地址看不懂，填 https://live.douyin.com/... 或 https://www.douyin.com/user/...')
    }

    let busy = false
    async function tick(force = false) {
      if (!api.settings().enabled) return { ok: false, message: '总开关关着' }
      if (!force && quietUntil && Date.now() < quietUntil) {
        return { ok: false, message: '刚收工，先歇到 ' + new Date(quietUntil).toLocaleTimeString() + '；想立刻回来发 /看直播 进' }
      }
      if (busy) return { ok: false, message: '上一轮还没结束' }
      // 2026-11-09：「按时间段挂」开着时才管时段；关着就任何时候都进。
      if (!inWindow()) {
        if (api.settings().schedule) {
          if (cdp) {
            await closeBrowser()
            note('不在时段内，把直播间浏览器关了（要一直挂就把「按时间段挂」关掉）')
          }
          return { ok: false, message: '不在设定时段（' + (api.settings().startTime || '?') + '-' + (api.settings().endTime || '?') + '），已关浏览器' }
        }
        note('不在设定的时段（' + (api.settings().startTime || '?') + '-' + (api.settings().endTime || '?') + '），但「按时间段挂」关着，照常进房', 'debug')
      }
      busy = true
      try {
        const r = await ensureInRoom()
        const url = await currentUrl()
        const inLive = LIVE_RE.test(url)
        if (!inLive) return { ...r, ok: r.ok, url }

        // 地址还在 /live/ 里不代表主播还在播：下播后 URL 不变，页面会写「直播已结束」。
        if (!force) {
          const why = await endedSignals()
          if (why) {
            await dropPending('主播下播')
            if (cdp) {
              await closeBrowser()
              note('主播下播了（' + why + '），把直播间浏览器关了', 'info')
            }
            return { ok: false, message: '主播下播了：' + why + '（浏览器已关，等下一轮再看）', url, ended: true }
          }
        }

        // 进房后发评论：等页面真的渲染完，同一个房间只发一次
        const text = String(api.settings().liveComment || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
        const today = dayKey()
        if (api.settings().liveCommentOn && text && commentedDay !== today) {
          const ready = await waitRoomReady(30000)
          if (ready) {
            const wait = Math.max(0, Math.min(120, Number(api.settings().commentDelaySec) || 0)) * 1000
            if (wait) await sleep(wait)
            const sent = await sendComment(text)
            if (sent.ok) {
              commentedUrl = url
              commentedDay = today
              saveState({ commentedUrl: url, commentedDay: today })
              note('进房评论：' + text + '（今天不再发了）')
            } else {
              note('评论没发成：' + sent.message, 'warn')
            }
          } else {
            note('页面 30 秒还没加载出评论框，这次没发评论', 'warn')
          }
        }

        /**
         * 送灯牌（2026-11-03 改）：**先判定，没送才送，送完再判定**。
         *   判定看「今日任务」面板里那一行「粉丝团灯牌 … 已完成」——已完成就说明今天已经送出过。
         *   判定成功就走人（并且给主人回一句「今天的灯牌已经送出了」，每天只说一次）。
         */
        if (api.settings().renewBadge) {
          const today = dayKey()
          // 2026-11-04：今天这个直播间已经确认送出过就别再判一遍了。
          // （之前每 2 分钟都打一条「今天已经送出了」，日志被刷满。）
          // 2026-11-06：连着挂 3 次 → 当天降级成提醒；有动作在等确认就别抢。
          if (badgeDay === today && badgeUrl === url) {
            // 已经办完，静默跳过
          } else if (badgeGiveUpDay === today) {
            // 今天已经放弃自动，不再点（放弃时已经提醒过一次）
          } else if (gate.peek()) {
            note('灯牌：还有个动作在等你确认，这轮先不送', 'debug')
          } else {
            let sent = await badgeSent()
            // 2026-11-09 修 BUG：r2 原来用 const 声明在下面 else 块里，而外层这两段（if (sent) / else if (!r2…)）
            //   还要用它 —— 块级作用域出不去，半自动等确认的每一轮都会在这里炸 ReferenceError，
            //   把 tick 带进 catch（顺手 cdp.close() 断开连接，主人回「确认」时目标已经找不到了）。
            let r2 = null
            if (sent) {
              note('灯牌：今天已经送出了（判定命中）')
            } else {
              const waitMs = Math.max(5, Math.min(600, Number(api.settings().badgeDelaySec) || 30)) * 1000
              await sleep(waitMs)
              r2 = await doBadge()
              if (r2.pending) note('灯牌：' + r2.message, 'info')
              else if (r2.ok) note('灯牌：' + r2.message, 'info')
              else await badgeReject(r2.message || '没点成')
              await sleep(1500)
              // 2026-11-08 修：原来这里又用 badgeSent() 覆盖结论，而它只认「今日任务」那一行；
              //   commitBadge 认的是「今日任务 / 飘屏 / 余额」三者之一，于是会出现
              //   「commitBadge 说送出去了，tick 转头打一条『送完还是没判到』」的自相矛盾日志
              //   （2026-11-07 21:18 实测）。commitBadge 已经写好 badgeDay，这里直接采信它的结论。
              // 2026-11-10 再修一刀：失败分支原来还会再跑一遍 badgeSent() ——
              //   它真的会去点「今日任务」开合面板（等主人确认之前不该再动页面），
              //   而且只认「今日任务」那一行，会把 commitBadge 的结论覆盖掉。
              //   现在：完全采信 doBadge/commitBadge 的结论，不重复动页面。
              sent = r2.pending ? false : Boolean(r2.ok)
            }
            if (sent) {
              if (badgeDay !== today || badgeUrl !== url) {
                badgeDay = today
                badgeUrl = url
                saveState({ badgeDay: today, badgeUrl: url })
              }
              if (badgeReportDay !== today) {
                badgeReportDay = today
                saveState({ badgeReportDay: today })
                // 只有自动模式才在这里通知；半自动是主人在私聊里点的，confirmPending 的回复就够了。
                const owner = api.config().ownerQQ
                if (owner && !api.settings().semiAuto) {
                  api.sendText('private:' + owner, '今天的灯牌已经送出了（' + ((r2 && r2.evidence) || '已确认') + '）').catch(() => {})
                }
              }
            } else if (!r2 || !r2.pending) {
              note('灯牌：这轮没成 —— ' + ((r2 && r2.message) || '没读到证据'), 'warn')
              // 自动模式下失败也要告诉主人一次（半自动时他本来就在私聊里等结果）
              if (!api.settings().semiAuto) {
                const owner = api.config().ownerQQ
                if (owner) api.sendText('private:' + owner, '⚠️ 灯牌这轮没成：' + ((r2 && r2.message) || '没读到证据')).catch(() => {})
              }
            }
          }
          // 2026-11-09：灯牌流程走完且没有动作在等确认，把任务面板收掉（best-effort）；
          //   面板本来关着时只读页面文字、不点任何东西。等确认期间特意不收。
          if (!gate.peek()) { try { await closeTaskPanel() } catch {} }
        }

        if (r.joined) {
          cleanShots() // 顺手把过期截图清了（进房一天顶多几次，开销可忽略）
          if (api.settings().minuteReport) {
            const owner = api.config().ownerQQ
            if (owner) api.sendText('private:' + owner, '我去看直播了：' + url).catch(() => {})
          }
        }
        return { ...r, url }
      } catch (error) {
        // 2026-11-10 修 BUG：原来这里无条件 cdp.close() + cdp = null —— 任何一点小异常
        //   （一次 eval 超时、一个空指针）都把 CDP 连接掐断。后果很严重：
        //   · 半自动模式下「等你确认」的闸门里存着已经准备好的动作，连接一断，
        //     主人回「确认」时目标已经找不到了（这也是 0.9.7 那个 r2 作用域 bug 的帮凶）；
        //   · 下一轮 tick 要重新连浏览器，又慢又可能连错标签页。
        //   现在：只有「连接本身坏了」才断开；普通异常记日志就行，连接留着。
        const msg = (error && error.message) ? error.message : String(error)
        note('挂直播出错：' + msg, 'warn')
        if (cdp && /websocket|not connected|socket|ECONN|连接断开|已关闭/i.test(msg)) {
          try { cdp.close() } catch {}
          cdp = null
        }
        return { ok: false, message: msg }
      } finally {
        busy = false
      }
    }

    /** 立刻进房一次（给她用工具时走这条，不要求面板里的「挂直播」开着）。 */
    async function enterNow(targetText) {
      const target = String(targetText || api.settings().target || '').trim()
      if (!target) return { ok: false, message: '没说看谁的直播，面板里也没设默认主播' }
      if (busy) return { ok: false, message: '正在弄，等一下下' }
      busy = true
      try {
        const r = await ensureInRoom(target)
        const url = await currentUrl()
        if (LIVE_RE.test(url)) {
          note('进了直播间：' + url)
          return { ok: true, url, message: '进直播间了：' + url }
        }
        return { ok: true, url, message: r.message || '打开了页面：' + (url || target) }
      } catch (error) {
        note('手动进直播间失败：' + error.message, 'warn')
        return { ok: false, message: error.message }
      } finally {
        busy = false
      }
    }

    /** 停下来：真的关掉浏览器、撤掉待确认、再把总开关关掉。 */
    async function stopNow() {
      await dropPending('收工')
      await closeBrowser()
      quietUntil = Date.now() + 30 * 60_000
      saveState({ quietUntil })
      api.saveSettings({ enabled: false })
      return { ok: true, message: '直播看完了，浏览器关了（半小时内不会自己再进）' }
    }

    /** 状态一句话，工具和命令共用。showDetail=false 时只说「开没开、在不在时段」，不暴露目标主播和当前地址。 */
    const statusLine = async (showDetail = true) => {
      const s = api.settings()
      const url = cdp ? (await currentUrl()).slice(0, 70) : '没开浏览器'
      const window = s.schedule ? `${s.startTime}-${s.endTime}（${inWindow() ? '在时段内' : '不在时段内'}）` : '不限时段'
      const head = '挂直播：' + (s.enabled ? '开' : '关') +
        '｜时段：' + window + '｜模式：' + (s.semiAuto ? '半自动' : '自动')
      if (!showDetail) return head
      const wait = gate.peek()
      return head +
        '｜目标：' + (s.target || '没填') +
        '｜进房评论：' + (s.liveCommentOn ? (commentedDay === dayKey() ? '开·今天发过（不再发）' : '开·今天还没发') : '已关闭') +
        '｜私信送礼：' + (s.giftByDm ? '开' : '关') +
        '｜现在：' + url +
        (wait ? '\n待确认：' + wait.label + '（回 /看直播 确认 或 /看直播 取消）' : '') +
        (lastNote ? '\n最近：' + lastNote : '')
    }

    /**
     * 这一轮说话的人是不是**全是**主人。
     * API 文档明确：别用 turnHasOwner —— 它只表示「本轮有人是主人」，
     * 主人和群友同一轮开口时，别人能借这个身份让她动真格。
     */
    const allOwnerTurn = (sessionId) => {
      const hub = api.core && api.core.hub
      try {
        if (hub && typeof hub.turnSendersAllOwner === 'function') return Boolean(hub.turnSendersAllOwner(sessionId))
        if (hub && typeof hub.turnHasOwner === 'function') return Boolean(hub.turnHasOwner(sessionId))
      } catch {}
      return false
    }

    // —— 给她用的工具：这样她在 QQ 里才认得「去看直播」 ——
    api.tool(({ chat, sessionId }) => {
      if (!chat || chat.kind === 'system') return []
      // 2026-11-05 修：进房 / 停止不是「只是看一眼」，它们会真的开浏览器。
      //   原来这些工具在群聊里也挂着、不看主人身份，群里任何人喊一句「去看直播」她都会真开。
      //   现在只在「这一轮有主人说话」时给操作类工具；别人只能问状态，而且状态里不露在看谁。
      const owner = allOwnerTurn(sessionId)
      // 总开关关着：连状态查询都不给（这个模块整个停摆），只留一句「关着」
      if (!api.settings().enabled) {
        return [api.defineTool({
          name: 'kanzhibo_status',
          description: '看直播模块现在关着。主人问「你在看什么直播」时用。',
          properties: {},
          execute: async () => ({ ok: true, message: '看直播模块关着（面板「抖音看直播」里的总开关关着），什么都没在做' }),
        })]
      }
      // 2026-11-06：送礼是花抖币的真动作，单独一道开关，而且只认「主人的 QQ 私聊」。
      //   开关关着、或者在群里，连工具都不挂给她（省得她嘴上答应、手上没本事）；
      //   工具清单是会话级缓存的，所以 execute 里再按当前设置判一次 —— 面板改完不用重载模块。
      const giftOn = () => Boolean(api.settings().giftByDm) && chat.kind === 'private' && allOwnerTurn(sessionId)
      const statusTool = api.defineTool({
        name: 'kanzhibo_status',
        description: '看现在挂没挂直播。主人问「你在看什么直播」时用。',
        properties: {},
        execute: async () => ({ ok: true, message: await statusLine(owner) }),
      })
      if (!owner) return [statusTool]

      const enterTool = api.defineTool({
        name: 'kanzhibo_enter',
        description:
          '进一个人的抖音直播间挂着看。主人说「去看直播」「去XX的直播间」「帮我挂着」「看着她播」这类话时用。' +
          '不填 target 就用面板里设好的那个主播。',
        properties: {
          target: { type: 'string', description: '直播间地址或主播主页链接；不填就用默认那个' },
        },
        execute: async ({ target }) => enterNow(target),
      })
      const stopTool = api.defineTool({
        name: 'kanzhibo_stop',
        description: '不看了：退出直播间、关掉浏览器窗口。主人说「别看了」「关掉」「回来吧」时用。',
        properties: {},
        execute: async () => stopNow(),
      })
      const giftTool = api.defineTool({
        name: 'kanzhibo_gift',
        description:
          '在正在看的直播间送一个礼物给主播（灯牌不算礼物，别走这个）。花的是主人的抖币，送出去没有撤回。' +
          '只有主人在这条私聊里明说要送、还说了送什么的时候才用；主人没提就绝对不要送。一次一个。' +
          '如果页面出现充值/抖币不足的提示，立刻停止并如实告诉主人。' +
          '开了「动作前先问我」时，她会把要点的位置截图发给主人等他回确认；这时候你只要说一句「等主人确认」就行，别自己改口说已经送好了。',
        properties: {
          gift: { type: 'string', description: '礼物名字，比如 小心心、玫瑰、粉丝团' },
        },
        required: ['gift'],
        execute: async ({ gift }) => {
          if (chat.kind !== 'private') return { ok: false, message: '送礼只认主人的私聊，群里我不送' }
          if (!api.settings().giftByDm) return { ok: false, message: '「QQ 私信送礼」的开关关着（面板 → 平台 → 抖音看直播），先让主人打开我才能送' }
          if (!allOwnerTurn(sessionId)) return { ok: false, message: '只有主人能让我送礼' }
          return sendGift(gift)
        },
      })
      const sayTool = api.defineTool({
        name: 'kanzhibo_say',
        description:
          '把主人说的话原样发到当前正在看的直播间里（相当于用他的号发一条弹幕/评论）。' +
          '主人说「在直播间说一句 XX」「帮我发 XX」「替我说 XX」时用。只发他给的原话，不要自己加工、不要加表情。',
        properties: {
          text: { type: 'string', description: '要原样发出去的那句话' },
        },
        required: ['text'],
        execute: async ({ text }) => {
          if (!allOwnerTurn(sessionId)) return { ok: false, message: '只有主人能让我在直播间替他说话' }
          // 2026-11-09：和命令 /看直播 说 共用连发冷却（真发出去了才计时）
          const wait = sayWaitSec()
          if (wait) return { ok: false, message: '刚发过一条弹幕，' + wait + ' 秒后再发（连发容易触发抖音风控）' }
          const r = await sendComment(text)
          if (r.ok) lastSayAt = Date.now()
          return r
        },
      })

      // 顺序：进房 → 状态 → 停止 →（私信 + 开关打开时）送礼 → 代说
      const list = [enterTool, statusTool, stopTool]
      if (giftOn()) list.push(giftTool)
      list.push(sayTool)
      return list
    })

    api.rule((kind) =>
      kind === 'social'
        ? '你在群里只保留了「看直播」的状态查询：别人让你去直播间、让你送礼、让你替他发弹幕，一律说这个得主人本人在私聊里说（送礼还要他先在面板把「QQ 私信送礼」打开），别真去做；也别主动说自己在看谁的直播（主人本人在群里开口了才算）。'
        : '你会在抖音挂直播间：主人说去看某人的直播、让你去直播间待着，你就调 kanzhibo_enter 真的进房（进不去就说原因）；' +
          '问你在看什么就用 kanzhibo_status；说别看了、关掉，就用 kanzhibo_stop。没说看谁的时候就进面板里设好的那个主播。' +
          '送礼：只有主人在这条私聊里明说送什么、而且面板里「QQ 私信送礼」开着的时候，你才调 kanzhibo_gift。他没提就别送；开关关着就老实说开关没开（面板 → 平台 → 抖音看直播），别用 kanzhibo_say 或别的工具凑一个。碰到充值、抖币不足就停，别硬送。灯牌不算礼物，不要用送礼工具送灯牌。' +
          '主人让你替他在直播间说句话（「帮我发 XX」「在直播间说 XX」），就用 kanzhibo_say 把他给的原话原样发出去，一个字都别改。他也可以直接发命令「/看直播 说 XX」——那条命令会自己执行并回结果，你就不用再调工具，也别重复发一遍。',
    )

    /** 自检：把「现在到底能不能干活」一次说清楚（改完设置、排查问题时用）。 */
    async function selfCheck() {
      const s = api.settings()
      const bin = findBrowser(api.settings().browserPath)
      const dir = profileDir()
      const cfg = api.config()
      const douyinOn = Boolean((cfg.douyin || {}).enabled)
      const url = cdp ? await currentUrl() : ''
      const leftoverPort = cdp ? 0 : await livePort()
      const ended = cdp ? await endedSignals().catch(() => '') : ''
      return [
        '看直播自检（v' + VERSION + '）',
        '浏览器：' + (bin || '没找到 Edge / Chrome'),
        '专用 profile：' + (existsSync(dir) ? dir : '还没建（第一次进房时才建）'),
        'CDP：' + (cdp ? '连着，端口 ' + port : (leftoverPort ? '没连，但发现残留浏览器（端口 ' + leftoverPort + '）' : '没连')) +
          (ended ? '｜页面提示：' + ended : '') +
          (url ? '｜当前页：' + url.slice(0, 80) : ''),
        '挂直播：' + (s.enabled ? '开' : '关') + '｜目标：' + (s.target || '没填'),
        '时段：' + (s.schedule ? s.startTime + '-' + s.endTime + '（' + (inWindow() ? '在时段内' : '不在时段内，不进房（到点浏览器也会关）') + '）' : '不限'),
        '检查间隔：' + clampCheckSec() + ' 秒' +
          (tickAnchor ? '（从 ' + new Date(tickAnchor).toLocaleTimeString() + ' 开始算，下次约 ' +
            new Date(tickAnchor + Math.ceil((Date.now() - tickAnchor + 1) / (clampCheckSec() * 1000)) * clampCheckSec() * 1000).toLocaleTimeString() + '）' : ''),
        '刷抖音：' + (douyinOn ? '照常（不归这个模块管）' : '关着（不归这个模块管）'),
        '今日评论：' + (s.liveCommentOn ? (commentedDay === dayKey() ? '开·今天发过' : '开·今天还没发') : '关'),
        '今日灯牌：' + (s.renewBadge ? (badgeDay === dayKey() ? '今天送过' : '今天还没送') : '关') +
          (badgeGiveUpDay === dayKey() ? '（今天已放弃自动，改成提醒你）' : ''),
        '私信送礼：' + (s.giftByDm ? '开（只认主人的私聊）' : '关（她不会送）'),
        '打法：' + (s.semiAuto ? '半自动（点之前截图发你，等你回 /看直播 确认）' : '自动（直接点，仍然过命中校验）'),
        '视口：' + (viewport ? viewport.w + '×' + viewport.h + ' · DPR ' + viewport.dpr + ' · 缩放 ' + viewport.scale : '还没读（进房后才有）') +
          (viewport && viewport.w >= 1500 ? '（已最大化）' : ''),
        '待确认：' + (gate.peek() ? gate.peek().label + '（' + Math.round((gate.peek().deadline - Date.now()) / 1000) + ' 秒后作废）' : '没有'),
        '状态文件：' + stateFile(),
        '最近一条：' + (lastNote || '（还没有）'),
      ].join('\n')
    }

    // 检查间隔改成能热改：面板里改完 checkSec 不用重载模块，下一轮就按新间隔走。
    let tickTimer = null
    let tickSec = 0
    // 计时锚点：从**打开总开关那一刻**算起，之后每 checkSec 检查一次（不是从进房成功开始）
    let tickAnchor = Number(loadState().tickAnchor || 0)
    const armTick = (anchor) => {
      const sec = clampCheckSec()
      if (anchor) tickAnchor = anchor
      if (!tickAnchor) tickAnchor = Date.now()
      if (tickTimer && sec === tickSec) return
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
      tickSec = sec
      const step = sec * 1000
      const schedule = () => {
        tickTimer = null
        if (!api.settings().enabled) return
        tick(false).catch((e) => note('定时检查出错：' + (e && e.message), 'warn'))
        // 对齐到锚点：anchor + n*step，避免每轮重新计时把间隔越拖越久
        const now = Date.now()
        const next = tickAnchor + Math.ceil((now - tickAnchor + 1) / step) * step
        tickTimer = setTimeout(() => { if (api.settings().enabled) schedule() }, Math.max(1000, next - now))
        try { tickTimer.unref?.() } catch {}
      }
      const now = Date.now()
      const next = tickAnchor + Math.ceil((now - tickAnchor + 1) / step) * step
      tickTimer = setTimeout(() => { if (api.settings().enabled) schedule() }, Math.max(1000, next - now))
      try { tickTimer.unref?.() } catch {}
    }
    const disarmTick = () => {
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
      tickSec = 0
      tickAnchor = 0
      saveState({ tickAnchor: 0 })
    }
    /**
     * 总开关。关掉 = 这个模块什么都不做：
     *   · 停定时器（不再进房）；· 撤掉待确认（截图过期，不能再点）
     *   · 关掉那台专用浏览器
     * 只读的状态 / 自检 / 面板仍然能用，方便你看它为什么停。
     */
    const stopAll = async (why) => {
      disarmTick()
      await dropPending(why || '总开关关闭')
      await closeBrowser()
      // 2026-11-09：把跟「浏览器在不在」绑定的内存状态一起清掉，
      //   否则下次开开关时自检/状态会显示上一次的端口和视口（假的「已连上」）。
      port = 0
      viewport = null
      note('总开关关了：定时器、浏览器、待确认都停了' + (why ? '（' + why + '）' : ''), 'info')
    }
    /**
     * 按当前开关状态把运行态调成对应的样子。
     * 2026-11-08 修：原来靠「上一个值 vs 现在值」判断，模块一重载 lastEnabled 就重新初始化，
     *   只要那一刻恰好是 false，之后再也触发不了关闭（prev===now 直接 return），
     *   浏览器就留着了。现在改成**幂等**：每次事件都按 now 收敛，
     *   关着就保证「没定时器 + 没浏览器 + 没待确认」。
     */
    let lastEnabled = Boolean(api.settings().enabled)
    const syncEnabled = async () => {
      const now = Boolean(api.settings().enabled)
      if (!now) {
        const hadWork = Boolean(tickTimer) || Boolean(cdp) || Boolean(gate.peek())
        const leftover = cdp ? 0 : await livePort()
        if (hadWork || leftover) await stopAll('总开关关闭')
        else if (tickTimer) disarmTick()
      } else {
        const turnedOn = !lastEnabled
        if (turnedOn) {
          // 一开就进：不等一个检查周期，直接开浏览器/进房；锚点也从这一刻开始
          tickAnchor = Date.now()
          saveState({ tickAnchor })
          quietUntil = 0
          saveState({ quietUntil: 0 })
          armTick(tickAnchor)
          note('总开关开了，立刻进房', 'info')
          tick(true).catch((e) => note('开开关后第一轮出错：' + ((e && e.message) || e), 'warn'))
        } else {
          // 2026-11-09 修 BUG：原来写成 else if (!tickTimer) —— 挂着的时候改 checkSec
          //   根本不会生效（schedule 闭包里的 step 是老值），和设置里写的「改完立刻生效」矛盾。
          //   armTick 本身幂等：间隔没变就原样返回，变了就按新间隔对齐锚点重排。
          armTick(tickAnchor || Date.now())
        }
      }
      lastEnabled = now
    }
    // 只有总开关开着才装定时器
    if (lastEnabled) armTick()
    api.on('config', () => { syncEnabled().catch(() => {}) })

    api.command({
      name: '看直播',
      aliases: ['kanzhibo'],
      desc: '挂直播间：/看直播 开、关、状态、进、收工、灯牌、说 <内容>（私聊发弹幕）、确认、取消、自检',
      run: async (arg, msg) => {
        const cmd = String(arg || '').trim()
        if (!cmd || cmd === '状态') {
          return await statusLine()
        }
        if (cmd === '自检' || cmd === 'check') {
          return await selfCheck()
        }
        if (cmd === '确认' || cmd === 'ok' || cmd === '好') return await confirmPending()
        if (cmd === '取消' || cmd === '算了' || cmd === '不用了') return await cancelPending()
        if (cmd === '待确认' || cmd === 'pending') {
          const w = gate.peek()
          return w ? '等你确认：' + w.label + '（' + Math.round((w.deadline - Date.now()) / 1000) + ' 秒后作废）' : '现在没有等你确认的事'
        }
        if (cmd === '灯牌') {
          if (!cdp) return '直播间浏览器没开，先发 /看直播 进'
          badgeGiveUpDay = ''
          saveState({ badgeGiveUpDay: '' })
          const r = await doBadge()
          return r.pending ? r.message : (r.ok ? r.message : '没点成：' + r.message)
        }
        // —— 私信发弹幕（0.9.9）：/看直播 说 <内容>（评论 / 弹幕 / 发 是同义词） ——
        //   空格可以省（/看直播 说主播加油），成对引号会剥掉一层。
        {
          const m = /^(说|评论|弹幕|发)([\s\S]*)$/.exec(cmd)
          if (m) {
            if (!fromOwnerDm(msg)) {
              return '在直播间发弹幕只认主人本人的 QQ 私聊（这条是从' +
                (String((msg && msg.chatId) || '').startsWith('group:') ? '群' : '别的聊天') +
                '里来的），群里不发；到我私聊里发 /看直播 说 要说的话'
            }
            const content = stripQuotes(m[2])
            if (!content) return '用法：/看直播 说 要发的话 —— 我就在正在看的直播间把这句原样发出去（只认你的私聊；最多 ' + SAY_MAX_CHARS + ' 个字）'
            const chars = Array.from(content)
            if (chars.length > SAY_MAX_CHARS) return '太长了：弹幕最多 ' + SAY_MAX_CHARS + ' 个字（这句 ' + chars.length + ' 个），缩短一点再发'
            const wait = sayWaitSec()
            if (wait) return '刚发过一条弹幕，' + wait + ' 秒后再发（连发容易触发抖音风控）'
            const r = await sendComment(content)
            if (r.ok) lastSayAt = Date.now()
            return r.ok ? r.message : '没发出去：' + r.message
          }
        }
        if (cmd === '开') {
          quietUntil = 0
          saveState({ quietUntil: 0 })
          api.saveSettings({ enabled: true })
          const r = await tick(true)
          return r.ok ? '开了，在 ' + r.url : '开了，但没进去：' + r.message
        }
        if (cmd === '关') {
          // 总开关关闭：停定时器、撤待确认、关浏览器
          api.saveSettings({ enabled: false })
          await stopAll('命令 /看直播 关')
          quietUntil = Date.now() + 30 * 60_000
          saveState({ quietUntil })
          return '总开关关了：不再进房，浏览器关了（要用再说 /看直播 开）'
        }
        if (cmd === '进') {
          quietUntil = 0
          saveState({ quietUntil: 0 })
          const r = await tick(true)
          return r.ok ? '进了：' + r.url : '没进去：' + r.message
        }
        if (cmd === '收工') {
          await dropPending('收工')
          await closeBrowser()
          quietUntil = Date.now() + 30 * 60_000
          saveState({ quietUntil })
          return '浏览器关了；半小时内不会自己再进（要立刻回来说 /看直播 进）'
        }
        return '能用的有：开 / 关 / 状态 / 进 / 收工 / 灯牌 / 说 <内容>（私聊发弹幕） / 确认 / 取消 / 自检'
      },
    })

    // —— 面板用的三个接口：登录、窗口、体检 ——
    api.route('/login/state', async () => {
      const r = await loginState()
      // 接口本身一定成功（ok:true），登录与否看 state
      return { ...r, ok: true }
    })
    api.route('/login', async () => {
      try { return await openLogin() } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    })
    api.route('/window', async (req) => {
      const q = api.core.http.query(req) || {}
      const show = String(q.show == null ? '1' : q.show) !== '0'
      try { return await showWindow(show) } catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    })

    /** 面板用：现在有没有在等确认。 */
    api.route('/pending', async () => ({
      ok: true,
      semiAuto: Boolean(api.settings().semiAuto),
      pending: gate.state(),
    }))

    /**
     * 排查用（只读优先）：把「界面里到底有哪些候选」摊开，不花钱的点击要 ?open=1 才做。
     *   /aurabot/api/ext/kanzhibo/probe?what=badge&open=1&shot=1&target=https://live.douyin.com/xxx
     *   /aurabot/api/ext/kanzhibo/probe?what=gift&name=小心心&open=1&shot=1
     */
    api.route('/probe', async (req) => {
      const q = api.core.http.query(req)
      const what = String(q.what || 'badge')
      const target = String(q.target || '').trim()
      try {
        if (what === 'expiry') {
          // 只测「到点自动撤销」：开一个假动作（confirm 也点不出东西），不发 QQ 请求、不碰浏览器。
          gate.setTtl(8000)
          const g = gate.open({ kind: 'test', label: '超时测试（不会点任何东西）', prepared: { ok: false }, data: {} })
          if (g.ok) armGate()
          return { ok: true, what, opened: g.ok, pending: gate.state(), ttlMs: gate.ttlMs, serverNow: Date.now() }
        }
        if (target) {
          const r = await enterNow(target)
          if (!r.ok) return { ok: false, message: r.message }
        }
        // 模块重载后 cdp 会丢，但浏览器进程还在 —— 先尝试接回来，别直接报「没开」
        if (!cdp) {
          const p = await livePort()
          if (p) { try { await attach(p) } catch {} }
        }
        if (!cdp) return { ok: false, message: '浏览器没开：带上 ?target=直播间地址，或者先发 /看直播 进' }
        await ensureViewport()
        await waitRoomReady(20000)
        const out = { ok: true, what, url: await currentUrl(), title: await evalJs('document.title'), viewport }
        if (String(q.reload || '') === '1') {
          try {
            await cdp.send('Page.enable').catch(() => {})
            await cdp.send('Page.reload', { ignoreCache: false })
            await sleep(4000)
            await waitRoomReady(25000)
          } catch {}
        }
        if (what === 'badge') {
          if (String(q.esc || '') === '1') {
            try {
              await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
              await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
              await sleep(700)
            } catch {}
          }
          if (String(q.open || '') === '1') {
            out.entry = await clicker.clickOnce({ label: '粉丝团/灯牌入口', spec: BADGE_ENTRY_SPEC, allowMultiple: true, settleMs: 1500 })
            await sleep(1200)
          }
          out.entryCandidates = await clicker.find(BADGE_ENTRY_SPEC)
          out.confirmCandidates = await clicker.find(BADGE_CONFIRM_SPEC)
          if (String(q.shot || '') === '1') out.shot = await shot('probe-badge')
        }
        if (what === 'gift') {
          const name = String(q.name || '小心心')
          if (String(q.open || '') === '1') {
            out.opened = await openGiftPanel()
            await sleep(2600)
          }
          out.giftCandidates = await clicker.find(GIFT_CELL_SPEC(name))
          out.confirmCandidates = await clicker.find(GIFT_CONFIRM_SPEC)
          if (String(q.shot || '') === '1') out.shot = await shot('probe-gift')
        }
        if (what === 'prep') {
          const prep = await prepareBadge()
          out.badgePrep = prep.ok
            ? {
                ok: true,
                text: prep.prepared.cand.text,
                sig: prep.prepared.cand.sig,
                desc: prep.prepared.desc,
                point: prep.prepared.point,
                entry: prep.entry,
                progressBefore: prep.progressBefore,
                hints: prep.hints,
                panelJustOpened: prep.panelJustOpened,
              }
            : prep
          if (String(q.shot || '') === '1') out.shot = await shot('probe-prep')
        }
        if (what === 'mark') {
          const found = await clicker.find(BADGE_CONFIRM_SPEC)
          out.candidates = found
          const marked = await clicker.mark(0)
          out.marked = marked
          out.shotFull = await shot('probe-mark-full')
          out.shotZoom = marked ? await shot('probe-mark-zoom', marked) : ''
          await clicker.unmark()
        }
        // 2026-11-10 修：这几个分支会**真的点下去**（可能花钱），原来不受 ?open=1 约束 ——
        //   文档写着「不花钱的点击要 ?open=1 才做」，但 what=ok 会走 confirmPending() 真点灯牌、
        //   what=ask 在自动模式下会直接送、what=click 能点任意坐标。排查接口不能变成扣款接口。
        const openOk = String(q.open || '') === '1'
        if (what === 'ask' || what === 'ok' || what === 'no' || what === 'click') {
          if (!openOk) {
            return { ok: false, what, needOpen: true, message: '这一步会真的点下去（可能花钱），确认要动就加上 &open=1' }
          }
        }
        if (what === 'ask' || what === 'ok' || what === 'no') {
          if (what === 'ask') out.result = await doBadge()
          else if (what === 'ok') out.result = { message: await confirmPending() }
          else out.result = { message: await cancelPending() }
          out.pending = gate.state()
          if (String(q.shot || '') === '1') out.shot = await shot('probe-' + what)
        }
        if (what === 'prepgift') {
          const prep = await prepareGift(String(q.name || '小心心'))
          out.giftPrep = prep.ok
            ? { ok: true, name: prep.name, text: prep.prepared.cand.text, desc: prep.prepared.desc, point: prep.prepared.point, balance: prep.balance, directSend: prep.directSend }
            : prep
          if (String(q.shot || '') === '1') out.shot = await shot('probe-giftprep')
        }
        if (what === 'hit') {
          const x = Number(q.x)
          const y = Number(q.y)
          out.at = await evalJs(`(() => {
            const x = ${Number.isFinite(x) ? x : 0}, y = ${Number.isFinite(y) ? y : 0}
            const el = document.elementFromPoint(x, y)
            if (!el) return null
            const chain = []
            let cur = el
            for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
              const r = cur.getBoundingClientRect()
              chain.push({ tag: cur.tagName.toLowerCase(), cls: String(cur.className || '').slice(0, 40), text: ((cur.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 40), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], role: cur.getAttribute && cur.getAttribute('role'), tab: cur.getAttribute && cur.getAttribute('tabindex'), cursor: getComputedStyle(cur).cursor })
            }
            return chain
          })()`)
        }
        if (what === 'click') {
          const x = Number(q.x)
          const y = Number(q.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, message: '要给 x 和 y' }
          await clicker.clickAt(x, y)
          await sleep(1200)
          out.clicked = { x, y }
          out.hitAt = await evalJs(`(() => {
            const el = document.elementFromPoint(${x}, ${y})
            if (!el) return null
            return { tag: el.tagName.toLowerCase(), text: ((el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 40), rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })() }
          })()`)
          if (String(q.shot || '') === '1') out.shot = await shot('probe-click')
        }
        if (what === 'chat') {
          const c = await chatLines(60)
          out.chat = { found: c.found, total: c.total, hit: c.hit, rect: c.rect, lines: c.lines }
          out.hasBadgeSent = c.lines.some((l) => BADGE_CHAT_RE.test(l))
          const mine = c.lines.filter((l) => BADGE_CHAT_RE.test(l))
          out.badgeSentLines = mine.slice(-3)
        }
        // 2026-11-10 加：读无障碍树。粉丝团面板是 Lynx canvas，DOM 里读不到，
        //   全靠这条通道才能看清面板上有什么。
        if (what === 'ax') {
          const names = await ax.names({ limit: 2000 })
          const kw = String(q.kw || '')
          const hit = kw ? names.filter((n) => n.name.includes(kw)) : names
          out.axTotal = names.length
          out.axFrames = (await ax.frames()).length
          out.axHit = hit.slice(0, Number(q.limit || 40)).map((n) => n.name)
          out.axCandidates = await ax.find(new RegExp(String(q.re || '送灯牌|点亮|赠送|粉丝团')), { limit: 20 })
          if (String(q.shot || '') === '1') out.shot = await shot('probe-ax')
        }
        if (what === 'pagetext') {
          const t = await pageText(20000)
          out.length = t.length
          out.head = t.replace(/\s+/g, ' ').slice(0, 300)
          out.hasRecharge = /抖币不足|余额不足|不够抖币|余额不够/.test(t)
          out.hasBadge = /灯牌/.test(t)
          out.balance = await readBalance()
        }
        if (what === 'info') {
          out.info = await evalJs(`(() => ({
            href: location.href,
            title: document.title,
            bodyLen: (document.body && document.body.innerText || '').length,
            bodyHead: (document.body && document.body.innerText || '').slice(0, 300),
            iframes: [...document.querySelectorAll('iframe')].map((f) => {
              let info = { src: String(f.src || '').slice(0, 120), rect: [Math.round(f.getBoundingClientRect().left), Math.round(f.getBoundingClientRect().top), Math.round(f.getBoundingClientRect().width), Math.round(f.getBoundingClientRect().height)] }
              try {
                const doc = f.contentDocument
                info.sameOrigin = Boolean(doc)
                if (doc) {
                  info.bodyLen = (doc.body && doc.body.innerText || '').length
                  info.textLen = (doc.body && doc.body.textContent || '').length
                  info.head = (doc.body && doc.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120)
                  info.textHead = (doc.body && doc.body.textContent || '').replace(/\s+/g, ' ').slice(0, 160)
                  info.nodes = doc.querySelectorAll('*').length
                  info.shadows = [...doc.querySelectorAll('*')].filter((x) => x.shadowRoot).length
                  info.hasLight = (doc.body && doc.body.textContent || '').includes('点亮')
                }
              } catch (e) { info.err = String((e && e.message) || e) }
              return info
            }),
            frames: window.frames.length,
            nodes: document.querySelectorAll('*').length,
            dpr: devicePixelRatio,
            vw: innerWidth,
            vh: innerHeight,
          }))()`)
        }
        if (what === 'text') {
          const word = String(q.q || '点亮')
          out.matches = await evalJs(`(() => {
            const word = ${JSON.stringify(word)}
            const out = []
            for (const el of document.querySelectorAll('*')) {
              const t = (el.textContent || '').replace(/\\s+/g, ' ').trim()
              if (!t || t.length > 40 || !t.includes(word)) continue
              const r = el.getBoundingClientRect()
              if (!r.width || !r.height) continue
              out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 48), text: t, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })
            }
            return out.slice(0, 40)
          })()`)
        }
        if (what === 'room') {
          out.commentBoxes = await clicker.find({ text: '.', raw: true, maxTextLen: 999, region: { top: 0, left: 0, right: 1, bottom: 1 } })
          if (String(q.shot || '') === '1') out.shot = await shot('probe-room')
        }
        return out
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) }
      }
    })

    api.route('/status', async () => {
      const s = api.settings()
      return {
        ok: true, enabled: s.enabled, target: s.target, connected: Boolean(cdp), port,
        url: cdp ? await currentUrl() : '', commentedUrl, commentedDay, today: dayKey(), lastNote,
        semiAuto: Boolean(s.semiAuto), pending: gate.state(), viewport,
      }
    })

    api.route('/selfcheck', async () => {
      const s = api.settings()
      return {
        ok: true,
        browser: findBrowser(api.settings().browserPath),
        browserPath: api.settings().browserPath || '',
        profileDir: profileDir(),
        profileExists: existsSync(profileDir()),
        connected: Boolean(cdp),
        port,
        url: cdp ? await currentUrl() : '',
        enabled: Boolean(s.enabled),
        target: s.target || '',
        inWindow: inWindow(),
        schedule: Boolean(s.schedule),
        checkSec: clampCheckSec(),
        douyinEnabled: Boolean((api.config().douyin || {}).enabled),
        commentedDay,
        badgeDay,
        giftByDm: Boolean(s.giftByDm),
        semiAuto: Boolean(s.semiAuto),
        badgeGiveUpDay,
        pending: gate.state(),
        viewport,
        today: dayKey(),
        text: await selfCheck(),
      }
    })

    api.onDispose(() => {
      // 模块停下时不能再改配置；定时器一定要清掉，否则它会在模块停止后醒来，
      // 调用已经不能用的 api（浏览器也要带走 —— 它是 detached 启动的，不会自己退）。
      // 2026-11-10 修：这里原来用 clearInterval 清 tickTimer —— 但 tickTimer 是
      //   armTick 里 setTimeout 拿到的句柄（setInterval 和 setTimeout 在 Node 里
      //   返回的是不同类型的对象，混用根本清不掉）。定时器清不掉 = 模块停了它还会醒。
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
      if (gateLater) { try { gateLater() } catch {} gateLater = null }
      try { gate.dispose() } catch {}
      // 停模块时也要把那台浏览器带走 —— 它是 detached 启动的，不会自己退。
      // 这里不能 await（onDispose 是同步回调），但 closeBrowser 内部先把同步部分做完。
      try { closeBrowser().catch(() => {}) } catch {}
      try { if (cdp) cdp.close() } catch {}
      cdp = null
    })

    return {
      tick,
      selfCheck,
      status: () => ({ enabled: api.settings().enabled, target: api.settings().target, connected: Boolean(cdp) }),
      _debug: { inWindow, dayKey, findBrowser, sayState: () => ({ lastSayAt, gapMs: SAY_GAP_MS, maxChars: SAY_MAX_CHARS }) },
    }
  },
}
// touch 1793900150040
// touch 1793900198302
// touch 1793900591462
// touch 1793900665449
// touch 1793900727197
// touch 1793900743126
// touch 1793900757418
// touch 1793900843766
// touch 1793900857898
// touch 1793901412185
// touch 1794148779865
// touch 1794152147057
