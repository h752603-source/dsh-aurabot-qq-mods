// panel.js —— 看直播的面板。
// 布局参照「刷抖音」页：卡片标题右侧放主开关，下面一行说明，接着是「左侧标签 + 下方灰色提示 + 右侧控件」的行，
// 实时状态直接嵌在对应行里（不再单开一张状态卡），省得来回对照。
// 字段值走 draftSettings / setSettings，底部「保存设置」照常可用。
// 面板的执行方式：插件把这份文件的内容当函数体、用 Function 构造器跑一遍 → return 一个组件。
const { useState, useEffect, useRef } = React

// —— 私信发弹幕（0.9.9）卡片：输入一句、点发送，她就在正在看的直播间里发出去 ——
// 和 QQ 命令 /看直播 说、工具 kanzhibo_say 走同一条链路（同一个 10 秒冷却、50 字上限）。
// 这里只是面板入口，权限口径不变：弹幕是用主人的号公开发出去的，所以只有主人会用面板。
function SayCard({ sc, busy, call, toast, load }) {
  const ok = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)' } }, t)
  const warn = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, t)
  const dim = (t) => h('span', { className: 'ab-small ab-muted' }, t)
  const [sayText, setSayText] = useState('')
  const [saying, setSaying] = useState(false)
  const [coolLeft, setCoolLeft] = useState(0)
  const timerRef = useRef(null)
  const say = sc && sc.say ? sc.say : null
  const maxChars = (say && say.maxChars) || 50
  const inRoom = say ? !!say.inRoom : !!(sc && sc.connected)

  useEffect(() => {
    if (say && say.waitSec > coolLeft) setCoolLeft(say.waitSec)
  }, [sc])

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  const startCool = (sec) => {
    if (!sec || sec <= 0) return
    setCoolLeft(sec)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setCoolLeft((x) => {
        if (x <= 1) { clearInterval(timerRef.current); timerRef.current = null; return 0 }
        return x - 1
      })
    }, 1000)
  }

  const send = async () => {
    const t = sayText.trim()
    if (!t) { toast && toast('先写要发的话', 'err'); return }
    if (Array.from(t).length > maxChars) { toast && toast('最多 ' + maxChars + ' 个字', 'err'); return }
    setSaying(true)
    try {
      const r = await call('/say', { text: t })
      if (r && r.ok) {
        setSayText('')
        toast && toast((r.message || '发出去了'), 'ok')
        startCool(10)
      } else {
        toast && toast((r && r.message) || '没发出去', 'err')
        if (r && r.message && /秒后再发/.test(r.message)) {
          const m = /(\d+)\s*秒/.exec(r.message)
          if (m) startCool(Number(m[1]))
        }
      }
      await load()
    } catch (e) {
      toast && toast(String((e && e.message) || e), 'err')
    } finally { setSaying(false) }
  }

  const disabled = saying || busy || coolLeft > 0 || !inRoom
  const reason = !inRoom ? '（还没进直播间）' : coolLeft > 0 ? '（冷却 ' + coolLeft + ' 秒）' : ''

  return h(ui.Card, {
    title: '私信发弹幕',
    desc: '在正在看的直播间里，用主人的抖音号把这句原样发出去。' +
      '和 QQ 里发「/看直播 说 …」是同一条路：50 个字上限、连发 10 秒冷却（真发出去了才计时）。' +
      '弹幕是公开发言，发之前自己看一眼内容。',
  },
    h(ui.Row, { label: '当前直播间', hint: 'P1：弹幕会发进这个房间' },
      inRoom
        ? ok(sc && sc.url ? sc.url.replace(/^https?:\/\//, '').slice(0, 60) : '已进房')
        : dim('不在直播间 —— 先用上面的总开关进房'),
      coolLeft > 0 ? warn('冷却中 ' + coolLeft + 's') : null),
    h(ui.Row, { label: '现在能不能发', hint: '进了直播间才能发；冷却和命令、工具三边共用' },
      inRoom ? ok('可以发') : dim('先进房'), Array.from(sayText).length ? dim('（已写 ' + Array.from(sayText).length + ' 字）') : null),
    h(ui.Row, { label: '要发的话', hint: '原样发出，一个字不改；最多 ' + maxChars + ' 个字' },
      h('input', {
        className: 'ab-input', style: { flex: '1 1 320px', minWidth: 0 },
        maxLength: maxChars, placeholder: '主播加油', value: sayText, disabled: saying || busy,
        onChange: (e) => setSayText(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && !disabled) send() },
      }),
      h('span', { className: 'ab-small ab-muted' }, Array.from(sayText).length + '/' + maxChars),
      h(ui.Btn, { small: true, kind: 'primary', disabled, onClick: send }, saying ? '发…' : '发送'),
      reason ? dim(reason) : null))
}

return function KanzhiboPanel({ settings, draftSettings, setSettings, toast }) {
  const base = settings || {}
  const draft = draftSettings || {}
  const v = (k) => (draft[k] !== undefined ? draft[k] : base[k])
  const set = (k, val) => { if (setSettings) setSettings({ [k]: val }) }

  const sw = (k) => h(ui.Switch, { on: !!v(k), onChange: (x) => set(k, x) })
  const text = (k, props) => h('input', { className: 'ab-input', ...(props || {}), value: v(k) == null ? '' : v(k), onChange: (e) => set(k, e.target.value) })
  const num = (k, props) => h('input', { className: 'ab-input sm', type: 'number', ...(props || {}), value: v(k) == null ? '' : v(k), onChange: (e) => set(k, e.target.value === '' ? '' : Number(e.target.value)) })
  const area = (k, props) => h('textarea', { className: 'ab-input', rows: 3, ...(props || {}), value: v(k) == null ? '' : v(k), onChange: (e) => set(k, e.target.value) })
  const unit = (t) => h('span', { className: 'ab-muted ab-small' }, t)
  const ok = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)' } }, t)
  const warn = (t) => h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, t)
  const dim = (t) => h('span', { className: 'ab-small ab-muted' }, t)

  const [sc, setSc] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [waiting, setWaiting] = useState(null)
  const [login, setLogin] = useState(null)

  const load = async () => {
    setBusy(true)
    try {
      const r = await call('/selfcheck')
      if (r && r.ok) { setSc(r); setErr('') } else setErr((r && r.message) || '读不到自检')
      const p = await call('/pending').catch(() => null)
      setWaiting(p && p.pending ? p.pending : null)
      const lg = await call('/login/state').catch(() => null)
      setLogin(lg || null)
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { load() }, [])

  const act = async (path, body) => {
    setBusy(true)
    try {
      const r = await call(path, body)
      toast && toast((r && r.message) || (r && r.result && r.result.message) || '好了', r && r.ok === false ? 'err' : 'ok')
      await load()
    } catch (e) {
      toast && toast(String((e && e.message) || e), 'err')
    } finally { setBusy(false) }
  }

  const reloadLogin = async () => {
    try { const lg = await call('/login/state'); setLogin(lg || null); toast && toast((lg && lg.message) || '看过了', lg && lg.state === 'in' ? 'ok' : 'err') } catch (e) { toast && toast(String((e && e.message) || e), 'err') }
  }
  const state = login && (login.state || login.ok === false && login.state) || ''
  const loginMsg = login ? (login.message || '') : ''
  const loginOk = state === 'in'

  const lastNote = sc && sc.text ? (String(sc.text).split('\n').filter((x) => x.indexOf('最近一条') === 0)[0] || '') : ''
  const today = sc ? sc.today : ''
  const badgeDone = sc && sc.badgeDay === today
  const commentDone = sc && sc.commentedDay === today

  return h('div', { className: 'ab-grid' },

    // ① 挂直播：主开关放标题右侧（同「刷抖音」）
    h(ui.Card, {
      title: '总开关',
      desc: (v('enabled') ? '' : '【已关闭】这个模块什么都不做：不进房、不评论、不送灯牌、不送礼，浏览器也会关掉。') +
        '打开后，用一台独立的 Edge / Chrome（自己的登录资料，不碰你平时用的浏览器）挂在抖音直播间：进房、进房后发一条评论、续粉丝团灯牌。',
      right: sw('enabled'),
    },
      h(ui.Row, { label: '直播间或主页', hint: '直播间链接最稳；给主播主页（douyin.com/user/…）会自己找「直播中」点进去' },
        text('target', { placeholder: 'https://live.douyin.com/123456789' })),
      h(ui.Row, { label: '按时间段挂', hint: '开着 = 只在这段时间里启动 / 继续挂着；到点自动关浏览器。关掉 = 任何时候都进' },
        sw('schedule'),
        v('schedule') ? ok('只在时段内') : dim('不限时段')),
      h(ui.Row, { label: '时间段', hint: '24 小时制，可以跨午夜（22:30 → 01:00）。上面开关关着时这里只是标记' },
        text('startTime', { placeholder: '21:07', style: { maxWidth: 100 } }),
        unit('→'),
        text('endTime', { placeholder: '23:00', style: { maxWidth: 100 } }),
        v('schedule') ? null : dim('（当前不生效）')),
      h(ui.Row, { label: '多久检查一次', hint: '不在直播间就重新进；改完立刻生效，不用重载模块' },
        num('checkSec', { min: 30, max: 1800, step: 30 }), unit('秒')),
      h(ui.Row, { label: '浏览器路径', hint: '留空 = 自动找 Edge（找不到再找 Chrome / Chromium）；填了就用它' },
        text('browserPath', { placeholder: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })),
      h(ui.Row, { label: '进房时通知我', hint: '进房后私聊说一声' }, sw('minuteReport'))
    ),

    // ② 抖音账号（同「刷抖音」页）
    h(ui.Card, {
      title: '抖音账号',
      desc: '这个专用浏览器第一次用要扫一次码，登录状态存在它自己的资料目录里，之后一直有效。' +
        (state === 'in' ? '' : ' 没登录也能看直播，但发评论 / 送灯牌 / 送礼会失败。'),
      right: null,
    },
      h(ui.Row, { label: '登录', hint: '建议用小号。扫码后要短信验证时，点「显示浏览器窗口」在窗口里完成' },
        h(ui.Btn, { kind: 'primary', small: true, disabled: busy, onClick: () => act('/login') }, '扫码登录'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => reloadLogin() }, '检查登录'),
        loginMsg ? h('span', { className: loginOk ? 'ab-small' : 'ab-small', style: { color: loginOk ? 'var(--ab-ok)' : 'var(--ab-warn)', marginLeft: 10 } }, loginMsg) : null)
    ),

    // ③ 浏览器窗口（同「刷抖音」页）
    h(ui.Card, {
      title: '浏览器窗口',
      desc: '窗口平时藏在屏幕外（不抢前台）。扫码、过短信验证、处理验证码时挪到屏幕上。',
    },
      h(ui.Row, { label: '窗口', hint: '和上面「扫码登录」是同一台浏览器' },
        h(ui.Btn, { small: true, disabled: busy, onClick: () => act('/window?show=1') }, '显示浏览器窗口'),
        h(ui.Btn, { small: true, disabled: busy, onClick: () => act('/window?show=0') }, '收起窗口'))
    ),

    // ② 运行状态：像「抖音账号」那一行，状态文字在左，按钮在右
    h(ui.Card, {
      title: '运行状态',
      desc: '只读。核对它到底在不在干活，出问题时先看这里。',
      right: h(ui.Btn, { small: true, onClick: load, disabled: busy }, busy ? '读…' : '刷新'),
    },
      err ? h('div', { className: 'ab-note err', style: { marginBottom: 8 } }, '读不到自检：' + err) : null,
      sc ? [
        h(ui.Row, { key: 'br', label: '浏览器', hint: sc.connected ? 'CDP 端口 ' + sc.port : '还没进房，或者已经收工' },
          sc.connected ? ok('已连上') : dim('未连接'),
          h('span', { style: { marginLeft: 10, flex: '1 1 320px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, className: 'ab-small ab-muted' }, sc.url || '—')),
        // P2：模块没连但浏览器进程还挂着 —— 提示残留，免得「明明开着却显示没连」排查半天
        (!sc.connected && sc.leftoverPort) ? h(ui.Row, { key: 'lp', label: '残留浏览器', hint: '模块没连上，但那台专用浏览器还开着（端口见右）' },
          warn('还开着（端口 ' + sc.leftoverPort + '）'),
          h('div', { style: { marginLeft: 8 } },
            h(ui.Btn, { small: true, disabled: busy, onClick: () => act('/window?show=1') }, '显示窗口'))) : null,
        h(ui.Row, { key: 'sch', label: '时段', hint: '「按时间段挂」开着 = 只在时段内挂，不在时段会关浏览器；关掉 = 不限时段' },
          sc.schedule ? (sc.inWindow ? ok('在时段内') : warn('不在时段内（不进房，浏览器会关）')) : dim('不限时段')),
        h(ui.Row, { key: 'cm', label: '今日评论', hint: '同一个直播间每天最多一条' },
          commentDone ? ok('今天发过了') : dim('今天还没发')),
        h(ui.Row, { key: 'bd', label: '今日灯牌', hint: '判据是面板里出现 +100；读不到就不算送过' },
          badgeDone ? ok('今天送过了') : dim('今天还没送')),
        waiting ? h(ui.Row, { key: 'wt', label: '等你确认', hint: '回 QQ 发 /看直播 确认 才动手，超时自动撤销' },
          warn(waiting.label + '（' + Math.round((waiting.leftMs || 0) / 1000) + ' 秒后作废）'),
          h('div', { style: { marginLeft: 8 } },
            h(ui.Btn, { small: true, kind: 'primary', disabled: busy, onClick: () => act('/probe?what=ok') }, '确认'),
            h(ui.Btn, { small: true, disabled: busy, onClick: () => act('/probe?what=no') }, '撤销'))) : null,
        lastNote ? h('div', { key: 'ln', className: 'ab-small ab-muted', style: { marginTop: 8 } }, lastNote) : null,
      ] : h(ui.Empty, { icon: '⏳', text: '正在读自检…' })
    ),

    // ③ 进房评论
    h(ui.Card, {
      title: '进房评论',
      desc: '进房后发一条固定的评论。同一个直播间每天最多一次，默认关着。',
      right: sw('liveCommentOn'),
    },
      h(ui.Row, { label: '评论内容', hint: '多行只发第一行；留空就不发' }, area('liveComment', { placeholder: 'h的大肥鱼进场了' })),
      h(ui.Row, { label: '等几秒再发', hint: '等画面和评论框都出来，默认 8 秒' },
        num('commentDelaySec', { min: 0, max: 120, step: 1 }), unit('秒'))
    ),

    // ④ 粉丝团灯牌
    h(ui.Card, {
      title: '粉丝团灯牌',
      desc: '会真的去点页面左上角那一块。两种面板都认：「送1个基础灯牌（+100）」和「点亮粉丝团恢复勋章（点亮 1钻）」。',
      right: sw('renewBadge'),
    },
      h(ui.Row, { label: '等几秒再续', hint: '越早越容易点偏，宁晚不早。默认 30 秒' },
        num('badgeDelaySec', { min: 5, max: 600, step: 5 }), unit('秒')),
      h(ui.Row, { label: '判定方式', hint: '点之前：今日任务 0/3 + 面板里看到 1钻 / 100亲密度；点之后：面板里出现 +100 才算成功' },
        dim('只认 +100'))
    ),

    // ⑤ 送礼
    h(ui.Card, {
      title: '送礼',
      desc: '花抖币、没有撤回。只认你的私聊，群里永远不送。',
      right: sw('giftByDm'),
    },
      h(ui.Row, { label: '动作前先问我', hint: '开＝把要按的位置截图发你，回 /看直播 确认 才点；关＝直接点（照样过命中校验）' },
        sw('semiAuto'),
        v('semiAuto') ? ok('半自动') : warn('自动')),
      h(ui.Row, { label: '等你多少秒', hint: '到点没收到「确认」就自动撤销，不点' },
        num('confirmSec', { min: 10, max: 600, step: 5 }), unit('秒'))
    ),

    // ⑤.5 私信发弹幕（0.9.9）：面板里直接发，和 QQ 命令 / 工具同一条链路、同一个冷却
    h(SayCard, { sc, busy, call, toast, load })
    ,

    // ⑥ 工作区记录（2026-11-21）：每步操作记到 DSH 侧栏的「看直播 · 工作间」会话
    h(ui.Card, {
      title: '工作区记录',
      desc: '把每步操作同时记进 Aurabot 工作区里的「QQ · 看直播 · 工作间」会话（DSH 侧栏能点开看）。关掉就只写本地日志。',
      right: sw('opsSession'),
    },
      h(ui.Row, { label: '记录到哪', hint: '挂在「Aurabot · QQ」工作区，和你的 QQ 会话挨着' },
        v('opsSession') ? ok('看直播 · 工作间') : dim('没开')),
      h(ui.Row, { label: '最近的步骤', hint: '完整记录在那个工作区会话里' },
        (sc && sc.ops && sc.ops.items && sc.ops.items.length)
          ? h('div', { style: { flex: '1 1 320px', minWidth: 0 } },
              sc.ops.items.map((e, i) => h('div', { key: i, className: 'ab-small ab-muted' },
                (String(e.at || '').slice(11, 19) || '') + ' ' + (e.ok === false ? '✗ ' : '· ') + String(e.step || '') + (e.detail ? '：' + e.detail : ''))))
          : dim('还没有记录'))
    ),

    // ⑦ 风险：用一条警示通栏，不再单独占一大卡
    h('div', { className: 'ab-note warn' },
      h('b', null, '这两件事没有撤销：'),
      '续灯牌可能点偏（页面没加载完 / 抖音改版 / 窗口被拉小时），所以先过「候选唯一 + 区域带 + 9 点命中」，点完只认 +100；' +
      '送礼花抖币、退不回来，出现「充值 / 抖币不足」立刻停手。真出问题就去「日志」页看它点了什么。')
  )
}
