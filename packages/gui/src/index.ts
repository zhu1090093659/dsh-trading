/**
 * @dshtrading/gui — GUI 平面 bundle：无运行时 API，实质是「依赖清单 + patch 载体」。
 *
 * 2026-10-01 P1 拆包：11 行浏览器半 / 仅 web 宿主有意义的双半行从 @dshtrading/base
 * 原样搬来（行 id 与 name 一字不改）。base 只留 host 平面行，于是 bot 的安装闭包
 * 不再拖任何 @dshtrading/client-ui-*（design/bot-and-auto-trading.md §10）。
 *
 * @module @dshtrading/gui
 */

export {}
