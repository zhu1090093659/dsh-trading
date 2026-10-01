/**
 * @dshtrading/bot — bot 平面 bundle（无图形界面的 Linux 服务器形态）。
 *
 * 设计依据：design/bot-and-auto-trading.md §2.2「bot 是一个 dsh surface，不是自建程序」——
 * bot 由官方 launcher 以 profile 启动，本包是那个 profile 的自建 bundle：
 *   · **不含** webserver / connection / modules 行（不踩 web 栈信任栅栏）；
 *   · 不自建 application bin、不自建 cordis app，profile 解析/peer 校验/必需项审计
 *     全部继承官方 launcher。
 *
 * 2026-10-01 P1：先落**骨架**——本包此刻只声明「bot 平面的依赖闭包」并且 patch 层为空
 * （`[]`），让 pnpm plane:check 从今天起就按真实 bot 平面（base + bot）量闭包，而不是
 * 拿 base 当代理。P2 往 cordis.patch.yml 里加 bot-startup provider 行与传输行，
 * 往 src/ 里加对应的启动装配。
 *
 * @module @dshtrading/bot
 */

export {}
