/**
 * 星耀数智连接器（数据面-only）结构单测。
 *
 * 守卫四件事：
 *   1. 根入口重导出 name/inject/Config/apply（connector-playbook §4.2 护栏：unbundle 产物
 *      会丢掉「无模块引用的导出」；缺这些宿主启动即 load 失败）；
 *   2. 互斥激活：enabled=false 零注册；enabled=true 注册 5 个 cn_* 行情工具（无交易面）；
 *   3. 路由闸门：选中别家 provider 时让位；无路由（老部署）放行；
 *   4. 数据面行：注册表模式 register (cn, xysz)，老部署回退 provide。
 *
 * 零 mock 纪律：不使用通用 mock/stub 工具；工具面用形状合法的假 ctx（连接器对 router
 * 包零依赖，鸭式消费面），HTTP 面用注入的 fetchImpl 真实函数。
 */
import { describe, expect, it } from 'vitest'
import * as rootEntry from '../src/index.js'
import {
  Config,
  ROUTER_PROVIDER,
  TRADING_CN_MARKET_DATA_KEY,
  apply,
  routeAllows,
  type Config as ConfigType,
} from '../src/index.js'
import { apply as dataplaneApply } from '../src/dataplane.js'

const DEFAULTS: ConfigType = {
  enabled: false,
  apiUrl: 'http://127.0.0.1:8191',
  timeoutMs: 60_000,
}

/**
 * 形状合法的假 ctx（连接器对 router 包零依赖）：tools 用内存 Map 作真实注册面，
 * inject 同步回调（宿主语义的等价面），路由可选注入。
 */
function fakeCtx(options: { activeProvider?: string; withRouter?: boolean } = {}) {
  const registered = new Map<string, { name: string }>()
  const isolated: string[] = []
  const provided: Record<string, unknown> = {}
  const tools = {
    register: (definition: { name: string }) => { registered.set(definition.name, definition) },
    get: (toolName: string) => registered.get(toolName),
  }
  const ctx = {
    tools,
    logger: () => ({ info: () => {}, warn: () => {} }),
    reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    isolate: (name: string) => { isolated.push(name); return { reflect: { provide: () => {} } } },
    effect: (fn: () => () => void) => { fn() },
    get: (key: string) => {
      if (key === 'tradingMarketRouter' && options.withRouter === true) {
        return { activeProvider: () => options.activeProvider }
      }
      return undefined
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
  }
  return { ctx: ctx as never, registered, isolated, provided }
}

describe('星耀数智连接器根入口导出面', () => {
  it('用户环境按包名加载时 name/inject/Config/apply 四项都由根入口导出', () => {
    // Given: patch 行写包名 @dshtrading/connector-xysz → loader 只读 lib/index.js 的这四项
    // When: 检查根入口导出
    // Then: 四项齐备；命名符合全仓唯一约定
    expect(typeof rootEntry.apply).toBe('function')
    expect(rootEntry.name).toBe('dsh-trading-cn-connector-xysz')
    expect(rootEntry.inject).toEqual(['tools'])
    expect(rootEntry.Config).toBeDefined()
    expect(TRADING_CN_MARKET_DATA_KEY).toBe('tradingCnMarketData')
    expect(ROUTER_PROVIDER).toBe('xysz')
  })

  it('用户接入的数据面-only连接器包内不导出交易面服务与下单闸门', () => {
    // Given: 星耀数智是行情/资讯数据服务，无交易通道
    // When: 检查根入口导出面
    // Then: 无 TradeService、无 evaluateOrderGate、无凭证解析（本插件不持凭证）
    const exported = rootEntry as unknown as Record<string, unknown>
    expect(exported.XyszTradeService).toBeUndefined()
    expect(exported.evaluateOrderGate).toBeUndefined()
    expect(exported.resolveCredentials).toBeUndefined()
  })

  it('用户安装的 dataplane 子入口同样导出 apply 与 Config（子路径行的 loader 解析面）', async () => {
    // Given: patch 行写 @dshtrading/connector-xysz/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出
    // Then: apply 与 Config 都在（缺 Config 时行内不写 config 会按 undefined 传入并崩）
    const dataplane = await import('../src/dataplane.js')
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })
})

describe('星耀数智连接器配置默认面', () => {
  it('用户不配置时默认不激活，上游地址指向本机隧道端口', () => {
    // Given: 连接器默认关闭（互斥激活纪律：同一市场至多一个数据源激活）
    // When: 读取 Config 声明的默认值
    // Then: enabled=false、apiUrl=127.0.0.1:8191、超时 60s
    const resolved = (Config as unknown as (v: unknown) => ConfigType)({})
    expect(resolved.enabled).toBe(false)
    expect(resolved.apiUrl).toBe('http://127.0.0.1:8191')
    expect(resolved.timeoutMs).toBe(60_000)
  })
})

describe('星耀数智连接器互斥激活注册面', () => {
  it('用户未启用连接器时 apply 不注册任何工具', () => {
    // Given: enabled=false（默认）
    // When: 挂载插件
    // Then: 零注册
    const { ctx, registered } = fakeCtx()
    apply(ctx, DEFAULTS)
    expect(registered.size).toBe(0)
  })

  it('用户启用连接器时注册 5 个 A 股行情工具且不含任何交易工具', () => {
    // Given: enabled=true（无路由服务 → 老部署直接放行）
    // When: 挂载插件
    // Then: 5 个 cn_* 数据面工具；place/cancel order 必须缺席（数据面-only）
    const { ctx, registered } = fakeCtx()
    apply(ctx, { ...DEFAULTS, enabled: true })
    expect([...registered.keys()].sort()).toEqual([
      'cn_get_fundamentals',
      'cn_get_klines',
      'cn_get_orderbook',
      'cn_get_ticker',
      'cn_list_instruments',
    ])
    expect([...registered.keys()].some((n) => /place|cancel/.test(n))).toBe(false)
  })

  it('用户开两个会话共享同一工具面时重复工具名先到先得（不覆盖、不抛错）', () => {
    // Given: 同进程两个会话（各自 ctx）共享宿主 tools 注册面
    // When: 两个 ctx 都挂载 enabled=true
    // Then: 工具名各注册一次（第二次全部跳过）
    const { ctx, registered } = fakeCtx()
    apply(ctx, { ...DEFAULTS, enabled: true })
    apply(ctx, { ...DEFAULTS, enabled: true })
    expect(registered.size).toBe(5)
  })
})

describe('星耀数智连接器路由闸门', () => {
  const enabled: ConfigType = { ...DEFAULTS, enabled: true }

  it('用户把 cn 数据源切到别家时星耀数智让位', () => {
    // Given: router 的 cn 当前 provider 是 tencent
    // When: 评估路由闸门
    // Then: 让位（false）
    const { ctx } = fakeCtx({ withRouter: true, activeProvider: 'tencent' })
    expect(routeAllows(ctx, enabled, 'cn')).toBe(false)
  })

  it('用户把 cn 数据源切到星耀数智时放行', () => {
    // Given: router 的 cn 当前 provider 是 xysz
    // When: 评估路由闸门
    // Then: 放行（true）
    const { ctx } = fakeCtx({ withRouter: true, activeProvider: ROUTER_PROVIDER })
    expect(routeAllows(ctx, enabled, 'cn')).toBe(true)
  })

  it('用户环境没有路由服务时按老部署放行，但未启用一律拒绝', () => {
    // Given: 老部署无 tradingMarketRouter（get 返回 undefined）
    // When: 评估路由闸门
    // Then: 无路由放行；enabled=false 无论有无路由都拒绝
    const { ctx } = fakeCtx()
    expect(routeAllows(ctx, enabled, 'cn')).toBe(true)
    expect(routeAllows(ctx, DEFAULTS, 'cn')).toBe(false)
    const routed = fakeCtx({ withRouter: true, activeProvider: ROUTER_PROVIDER })
    expect(routeAllows(routed.ctx, DEFAULTS, 'cn')).toBe(false)
  })

  it('用户选中别家 provider 时 apply 不注册任何工具', () => {
    // Given: enabled=true 但路由选中 tencent
    // When: 挂载插件
    // Then: 零注册（互斥纪律靠路由而非报错）
    const { ctx, registered } = fakeCtx({ withRouter: true, activeProvider: 'tencent' })
    apply(ctx, enabled)
    expect(registered.size).toBe(0)
  })
})

describe('星耀数智连接器数据面行（注册表模式）', () => {
  interface Registered { market: string; provider: string; service: unknown }

  function registryCtx(withRegistry: boolean) {
    const registrations: Registered[] = []
    const provided: Record<string, unknown> = {}
    const isolated: string[] = []
    const registry = {
      register: (market: string, provider: string, service: unknown) => {
        registrations.push({ market, provider, service })
        return () => {}
      },
    }
    const ctx = {
      get: (key: string) => (key === 'tradingMarketDataRegistry' && withRegistry ? registry : undefined),
      isolate: (name: string) => { isolated.push(name); return { reflect: { provide: () => {} } } },
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    }
    return { ctx: ctx as never, registrations, provided, isolated }
  }

  it('用户宿主有注册表时数据行在 isolate realm 内注册 (cn, xysz)，不占根市场键', () => {
    // Given: 宿主提供 tradingMarketDataRegistry（注册表模式）
    // When: 挂载数据面行
    // Then: 注册 (cn, xysz)；根键 tradingCnMarketData 不被占用（多连接器并存无冲突）
    const { ctx, registrations, provided, isolated } = registryCtx(true)
    dataplaneApply(ctx, { enabled: true })
    expect(isolated).toEqual([TRADING_CN_MARKET_DATA_KEY])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.market).toBe('cn')
    expect(registrations[0]?.provider).toBe(ROUTER_PROVIDER)
    expect(registrations[0]?.service).toBeDefined()
    expect(provided[TRADING_CN_MARKET_DATA_KEY]).toBeUndefined()
  })

  it('用户未启用时数据行不注册、不 isolate', () => {
    // Given: enabled=false
    // When: 挂载数据面行
    // Then: 零注册、零 isolate
    const { ctx, registrations, provided, isolated } = registryCtx(true)
    dataplaneApply(ctx, { enabled: false })
    expect(isolated).toHaveLength(0)
    expect(registrations).toHaveLength(0)
    expect(Object.keys(provided)).toHaveLength(0)
  })

  it('用户环境无注册表（老部署）时数据行回退直接 provide 根市场键', () => {
    // Given: 宿主无 tradingMarketDataRegistry
    // When: 挂载数据面行
    // Then: 回退 provide tradingCnMarketData 供旧桥消费
    const { ctx, provided } = registryCtx(false)
    dataplaneApply(ctx, { enabled: true })
    expect(Object.keys(provided)).toEqual([TRADING_CN_MARKET_DATA_KEY])
  })

  it('用户宿主手工构造 ctx 且不传 config 时数据行按启用处理而不崩', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（loader 不参与）
    // When: 挂载数据面行（config 缺省）
    // Then: 按启用注册；不因 config.enabled 读取抛错
    const { ctx, registrations } = registryCtx(true)
    dataplaneApply(ctx, undefined)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.provider).toBe(ROUTER_PROVIDER)
  })
})
