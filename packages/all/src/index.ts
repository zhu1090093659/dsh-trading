/**
 * @dsh-trading/all — 元 bundle（TEMPLATES §5 形态）：无运行时 API，实质是
 * 「依赖清单 + patch 载体」。组合经 package.json dependencies（base + 全部市场
 * bundle），cordis.patch.yml 保持空 `[]` 层——insert-only 铁律 #1 下 all 不替任何
 * 市场包插行（详见 cordis.patch.yml 头注）。
 *
 * @module @dsh-trading/all
 */

export {}
