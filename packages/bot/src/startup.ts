/**
 * bot surface 的命令行 provider —— 照抄官方 @deepseek-ai/dsh-web-app/startup 的范式
 * （官方注释：no launcher metadata or special row kind is needed）：普通 Cordis 插件，
 * 解析本 surface 自己的 CLI 参数，并把不可变结果作为服务 botStartup 提供出去；
 * 由 flag 配置的行 inject 这个服务，于是 Loader 只在它存在后才解析那些表达式。
 *
 * 为什么不用官方 webserver / connection / modules 行（卡片 §2.2「不踩 web 栈」）：
 * 那三行进**全局必需集**——它们失败会让整个 app dispose 退出，而 bot 面的可用性要求
 * 与浏览器面完全不同（bot 要能在没有任何浏览器客户端时照常跑）。所以 bot 自带传输行，
 * 行 id 走 dsh-trading-* 命名空间，绝不叫 webserver。
 *
 * @module @dshtrading/bot/startup
 */
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'

/** 稳定 Cordis 插件名。 */
export const name = 'bot-startup'

/** 解析 flag 之前必须就位的服务。 */
export const inject: readonly string[] = ['cmdlineArgs']

/** 本插件提供、由 flag 配置的行注入的服务名。 */
export const BOT_STARTUP_SERVICE = 'botStartup'

/** bot 面的调用期取值（绑定后不再变）。 */
export interface BotStartup {
  /** 绑定地址。缺省回环——bot 面默认只对本机可见（内网暴露是 edge 的职责）。 */
  readonly host: string
  /** 监听端口。0 = 让 OS 选空闲端口（测试用）。 */
  readonly port: number
  /** 额外可信 authority（host 或 host:port，可重复）。 */
  readonly trustedHosts: readonly string[]
}

/** 本 surface 的命令：flag、描述与 help 文本。每次调用返回新 program（一进程可解析多次）。 */
export function botCommand(): Command {
  return new Command()
    .name('dsh --profile trading-bot')
    .description('Run the dsh-trading bot surface (agent host + /dshtrading/api) without a browser shell.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (default 127.0.0.1)')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the bot HTTP fence accepts (host or host:port; repeatable)')
    .addHelpText('after', [
      '',
      'Examples:',
      '  dsh --profile trading-bot                 serve on the composed host and port',
      '  dsh --profile trading-bot --port 8899     serve on another port',
      '',
    ].join(String.fromCharCode(10)))
}

/**
 * 解析并提供 bot 调用期取值。--host 0.0.0.0 与非法端口都是用法错误：前者会把 bot 面
 * （含 Agent 宿主）暴露到网络，与「仅内网 + edge 唯一入口」的裁决冲突，所以显式拒绝
 * 而不是交给使用者自己小心。拒绝（以及 --help）时不提供任何服务。
 * @param ctx - 携带命令行的插件上下文。
 */
export function apply(ctx: Context): void {
  const program = botCommand()
  program.action(() => {
    const options = program.opts()
    if (options.host === '0.0.0.0') {
      program.error('error: --host 0.0.0.0 is intentionally not supported: the bot surface must stay loopback-only; network exposure belongs to the edge gateway')
    }
    if (options.port !== undefined && !/^[0-9]+$/.test(String(options.port))) {
      program.error('error: --port must be a number, got ' + JSON.stringify(String(options.port)))
    }
    const startup: BotStartup = {
      host: options.host === undefined ? '127.0.0.1' : String(options.host),
      port: options.port === undefined ? 8899 : Number(options.port),
      trustedHosts: options.trustedHost === undefined ? [] : options.trustedHost,
    }
    ctx.provide(BOT_STARTUP_SERVICE, startup)
  })
  parseCmdline(ctx, program)
}
