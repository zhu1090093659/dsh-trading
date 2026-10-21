import { packageConfig } from '../../tsdown.package.config.ts'

// 四个入口：运行期（index，只读只验签）与签署期（sign，运营 CLI 与测试专用）、
// 测试夹具（testing）与订单意图台账（order-intents，Node-only，写 agent 自己的
// trading home，绝不写人工持有的授权平面）。
// 运行期包**不得** import ./sign —— 见 test/live-trading-authority.test.ts 的依赖方向断言。

export default packageConfig({
  entry: [
    'src/index.ts',
    'src/sign.ts',
    'src/testing.ts',
    'src/order-intents.ts',
  ],
})
