/**
 * client-ui-settings client 词典（纯数据模块：零运行时依赖）。
 *
 * 单一来源：本包 client apply 注册 zh/en（typed register 编译期校验键位）；
 * packages/dsh-i18n 语言包构建期 import 本模块注册 zh-CN；scripts/i18n-audit.mjs
 * 静态加载本模块做 zh/en 键对齐与占位符对齐门禁。
 */
/**
 * dshtrading.settings locale keys（单一来源 = locales.ts zh 块；contract/locale-keys.ts
 * 据此 augment LocaleNamespaceMap，PropsLocale 落 t 座位）。
 */
export type SettingsLocaleKey =
  | 'nav'
  | 'lead'
  | 'tabs'
  | 'empty'
  | 'save'
  | 'discard'
  | 'saved'
  | 'saveFailed'
  | 'current'
  | 'default'
  | 'custom'
  | 'newsKeyLabel'
  | 'newsKeyPlaceholder'
  | 'newsSaved'
  | 'newsSaveFailed'
  | 'colorMode.label'
  | 'colorMode.redUp'
  | 'colorMode.greenUp'
  | 'market.crypto'
  | 'market.us'
  | 'market.cn'
  | 'market.hk'
  | 'credential.btn'
  | 'credential.btnFold'
  | 'credential.configured'
  | 'credential.notConfigured'
  | 'credential.save'
  | 'credential.delete'
  | 'credential.saved'
  | 'credential.deleted'
  | 'credential.saveFailed'
  | 'credential.deleteFailed'
  | 'type.public'
  | 'type.gateway'
  | 'type.commercial'
  | 'field.action.hide'
  | 'field.action.show'
  | 'provider.docsLink'
  | 'provider.envPrefix'
  | 'provider.binance'
  | 'provider.okx'
  | 'provider.bybit'
  | 'provider.ccxt'
  | 'provider.yahoo'
  | 'provider.alpaca'
  | 'provider.fmp'
  | 'provider.finnhub'
  | 'provider.polygon'
  | 'provider.ibkr'
  | 'provider.stooq'
  | 'provider.tencent'
  | 'provider.eastmoney'
  | 'provider.tushare'
  | 'provider.akshare'
  | 'provider.qmt'
  | 'provider.futu'
  | 'provider.longbridge'
  | 'provider.tiger'
  | 'field.label.apiKey'
  | 'field.label.apiSecret'
  | 'field.label.secretKey'
  | 'field.label.passphrase'
  | 'field.label.token'
  | 'field.label.apiUrl'
  | 'field.label.qmtUrl'
  | 'field.label.futuHost'
  | 'field.label.futuPort'
  | 'field.label.ibkrUrl'
  | 'field.label.appKey'
  | 'field.label.appSecret'
  | 'field.label.accessToken'
  | 'field.label.tigerId'
  | 'field.label.tigerPrivateKey'
  | 'field.placeholder.binanceKey'
  | 'field.placeholder.binanceSecret'
  | 'field.placeholder.okxKey'
  | 'field.placeholder.okxSecret'
  | 'field.placeholder.okxPassphrase'
  | 'field.placeholder.bybitKey'
  | 'field.placeholder.bybitSecret'
  | 'field.placeholder.ccxtKey'
  | 'field.placeholder.ccxtSecret'
  | 'field.placeholder.alpacaKey'
  | 'field.placeholder.alpacaSecret'
  | 'field.placeholder.fmpKey'
  | 'field.placeholder.finnhubKey'
  | 'field.placeholder.polygonKey'
  | 'field.placeholder.tushareToken'
  | 'field.placeholder.akshareUrl'
  | 'field.placeholder.qmtUrl'
  | 'field.placeholder.futuHost'
  | 'field.placeholder.futuPort'
  | 'field.placeholder.ibkrUrl'
  | 'field.placeholder.longbridgeAppKey'
  | 'field.placeholder.longbridgeAppSecret'
  | 'field.placeholder.longbridgeAccessToken'
  | 'field.placeholder.tigerId'
  | 'field.placeholder.tigerPrivateKey'

export const zh: Record<SettingsLocaleKey, string> = {
      'nav': '交易',
      'lead': '选择每个市场使用的数据/交易所提供方。行情面板保存即生效；Agent 会话于新建会话生效（切换不中断当前会话）。',
      'tabs': '市场',
      'empty': '没有可配置的市场。',
      'save': '保存',
      'discard': '放弃',
      'saved': '已保存',
      'saveFailed': '保存失败',
      'current': '当前：{provider}',
      'default': '默认',
      'custom': '自定义（{provider}，由第三方连接器提供）',
      'newsKeyLabel': 'CryptoPanic API Key（可选）——新闻工具 crypto_get_news 的 B 增强源；留空则用公共源。',
      'newsKeyPlaceholder': '粘贴 CryptoPanic free API token（私钥，仅本地存储）',
      'newsSaved': '已保存',
      'newsSaveFailed': '保存失败',
      'colorMode.label': '涨跌配色',
      'colorMode.redUp': '红涨绿跌（国内习惯）',
      'colorMode.greenUp': '绿涨红跌（国际习惯）',
      'market.crypto': '加密货币',
      'market.us': '美国股票',
      'market.cn': '中国 A 股',
      'market.hk': '香港股票',
      'credential.btn': '配置 API 凭证',
      'credential.btnFold': '收起配置',
      'credential.configured': '已配置凭证',
      'credential.notConfigured': '未配置',
      'credential.save': '保存凭证',
      'credential.delete': '清除/删除凭证',
      'credential.saved': 'API 凭证已保存',
      'credential.deleted': 'API 凭证已删除',
      'credential.saveFailed': '凭证保存失败',
      'credential.deleteFailed': '凭证清除失败',
      'type.public': '免密公共源',
      'type.gateway': '本地网关',
      'type.commercial': '商业 API',
      'field.action.hide': '隐藏',
      'field.action.show': '显示',
      'provider.docsLink': '官方指引与文档',
      'provider.envPrefix': '环境变量：',
      'provider.binance': 'Binance (币安)',
      'provider.okx': 'OKX (欧易)',
      'provider.bybit': 'Bybit',
      'provider.ccxt': 'CCXT (跨所聚合 100+)',
      'provider.yahoo': 'Yahoo Finance',
      'provider.alpaca': 'Alpaca',
      'provider.fmp': 'FMP (Financial Modeling Prep)',
      'provider.finnhub': 'Finnhub',
      'provider.polygon': 'Polygon.io (Massive)',
      'provider.ibkr': 'IBKR (盈透证券)',
      'provider.stooq': 'Stooq',
      'provider.tencent': '腾讯 (Tencent)',
      'provider.eastmoney': '东方财富 (Eastmoney)',
      'provider.tushare': 'Tushare Pro',
      'provider.akshare': 'AkShare (宏观/另类量化)',
      'provider.qmt': 'MiniQMT (迅投券商实盘)',
      'provider.futu': 'Futu (富途 OpenD)',
      'provider.longbridge': 'Longbridge (长桥)',
      'provider.tiger': 'Tiger Trade (老虎证券)',
      'field.label.apiKey': 'API Key',
      'field.label.apiSecret': 'API Secret',
      'field.label.secretKey': 'Secret Key',
      'field.label.passphrase': 'Passphrase',
      'field.label.token': 'Pro Token',
      'field.label.apiUrl': 'HTTP 服务地址',
      'field.label.qmtUrl': 'MiniQMT 服务地址',
      'field.label.futuHost': 'OpenD IP',
      'field.label.futuPort': 'OpenD 端口',
      'field.label.ibkrUrl': 'CP Gateway 地址',
      'field.label.appKey': 'App Key',
      'field.label.appSecret': 'App Secret',
      'field.label.accessToken': 'Access Token',
      'field.label.tigerId': 'Tiger ID',
      'field.label.tigerPrivateKey': 'RSA 私钥',
      'field.placeholder.binanceKey': 'BINANCE_API_KEY (留空走免密公共行情)',
      'field.placeholder.binanceSecret': 'BINANCE_API_SECRET',
      'field.placeholder.okxKey': 'OKX_API_KEY (留空走免密公共行情)',
      'field.placeholder.okxSecret': 'OKX_SECRET_KEY',
      'field.placeholder.okxPassphrase': 'OKX_PASSPHRASE',
      'field.placeholder.bybitKey': 'BYBIT_API_KEY (留空走免密公共行情)',
      'field.placeholder.bybitSecret': 'BYBIT_API_SECRET',
      'field.placeholder.ccxtKey': 'CCXT_API_KEY',
      'field.placeholder.ccxtSecret': 'CCXT_API_SECRET',
      'field.placeholder.alpacaKey': 'ALPACA_API_KEY',
      'field.placeholder.alpacaSecret': 'ALPACA_SECRET_KEY',
      'field.placeholder.fmpKey': 'FMP_API_KEY',
      'field.placeholder.finnhubKey': 'FINNHUB_API_KEY',
      'field.placeholder.polygonKey': 'POLYGON_API_KEY',
      'field.placeholder.tushareToken': 'TUSHARE_TOKEN',
      'field.placeholder.akshareUrl': 'http://127.0.0.1:8080 (默认内置)',
      'field.placeholder.qmtUrl': 'http://127.0.0.1:5800',
      'field.placeholder.futuHost': '127.0.0.1',
      'field.placeholder.futuPort': '11111',
      'field.placeholder.ibkrUrl': 'https://localhost:5000',
      'field.placeholder.longbridgeAppKey': 'LONGBRIDGE_APP_KEY',
      'field.placeholder.longbridgeAppSecret': 'LONGBRIDGE_APP_SECRET',
      'field.placeholder.longbridgeAccessToken': 'LONGBRIDGE_ACCESS_TOKEN',
      'field.placeholder.tigerId': 'TIGER_ID',
      'field.placeholder.tigerPrivateKey': 'TIGER_PRIVATE_KEY',
}

export const en: Record<SettingsLocaleKey, string> = {
      'nav': 'Trading',
      'lead': 'Choose the data/exchange provider for each market. Quote panels take effect immediately; agent sessions pick it up in new sessions (running sessions are not interrupted).',
      'tabs': 'Markets',
      'empty': 'No configurable markets.',
      'save': 'Save',
      'discard': 'Discard',
      'saved': 'Saved',
      'saveFailed': 'Save failed',
      'current': 'Current: {provider}',
      'default': 'default',
      'custom': 'Custom ({provider}, provided by a third-party connector)',
      'newsKeyLabel': 'CryptoPanic API key (optional) — B-source enrichment for the crypto_get_news tool; leave empty to use public sources.',
      'newsKeyPlaceholder': 'Paste a CryptoPanic free API token (stored locally only)',
      'newsSaved': 'Saved',
      'newsSaveFailed': 'Save failed',
      'colorMode.label': 'Price Color Scheme',
      'colorMode.redUp': 'Red Up / Green Down (Chinese)',
      'colorMode.greenUp': 'Green Up / Red Down (International)',
      'market.crypto': 'Crypto',
      'market.us': 'US Stocks',
      'market.cn': 'China A-shares',
      'market.hk': 'Hong Kong',
      'credential.btn': 'Configure API Credentials',
      'credential.btnFold': 'Hide Configuration',
      'credential.configured': 'Configured',
      'credential.notConfigured': 'Not Configured',
      'credential.save': 'Save Credentials',
      'credential.delete': 'Clear / Delete Credentials',
      'credential.saved': 'API Credentials saved',
      'credential.deleted': 'API Credentials cleared',
      'credential.saveFailed': 'Failed to save credentials',
      'credential.deleteFailed': 'Failed to clear credentials',
      'type.public': 'Public source',
      'type.gateway': 'Local gateway',
      'type.commercial': 'Commercial API',
      'field.action.hide': 'Hide',
      'field.action.show': 'Show',
      'provider.docsLink': 'Official docs & guides',
      'provider.envPrefix': 'Env var: ',
      'provider.binance': 'Binance',
      'provider.okx': 'OKX',
      'provider.bybit': 'Bybit',
      'provider.ccxt': 'CCXT (100+ exchanges)',
      'provider.yahoo': 'Yahoo Finance',
      'provider.alpaca': 'Alpaca',
      'provider.fmp': 'FMP (Financial Modeling Prep)',
      'provider.finnhub': 'Finnhub',
      'provider.polygon': 'Polygon.io (Massive)',
      'provider.ibkr': 'IBKR (Interactive Brokers)',
      'provider.stooq': 'Stooq',
      'provider.tencent': 'Tencent',
      'provider.eastmoney': 'Eastmoney',
      'provider.tushare': 'Tushare Pro',
      'provider.akshare': 'AkShare (macro / alt-data)',
      'provider.qmt': 'MiniQMT (broker gateway)',
      'provider.futu': 'Futu (OpenD)',
      'provider.longbridge': 'Longbridge',
      'provider.tiger': 'Tiger Trade',
      'field.label.apiKey': 'API Key',
      'field.label.apiSecret': 'API Secret',
      'field.label.secretKey': 'Secret Key',
      'field.label.passphrase': 'Passphrase',
      'field.label.token': 'Pro Token',
      'field.label.apiUrl': 'HTTP endpoint',
      'field.label.qmtUrl': 'MiniQMT endpoint',
      'field.label.futuHost': 'OpenD IP',
      'field.label.futuPort': 'OpenD port',
      'field.label.ibkrUrl': 'CP Gateway URL',
      'field.label.appKey': 'App Key',
      'field.label.appSecret': 'App Secret',
      'field.label.accessToken': 'Access Token',
      'field.label.tigerId': 'Tiger ID',
      'field.label.tigerPrivateKey': 'RSA private key',
      'field.placeholder.binanceKey': 'BINANCE_API_KEY (leave empty for public quotes)',
      'field.placeholder.binanceSecret': 'BINANCE_API_SECRET',
      'field.placeholder.okxKey': 'OKX_API_KEY (leave empty for public quotes)',
      'field.placeholder.okxSecret': 'OKX_SECRET_KEY',
      'field.placeholder.okxPassphrase': 'OKX_PASSPHRASE',
      'field.placeholder.bybitKey': 'BYBIT_API_KEY (leave empty for public quotes)',
      'field.placeholder.bybitSecret': 'BYBIT_API_SECRET',
      'field.placeholder.ccxtKey': 'CCXT_API_KEY',
      'field.placeholder.ccxtSecret': 'CCXT_API_SECRET',
      'field.placeholder.alpacaKey': 'ALPACA_API_KEY',
      'field.placeholder.alpacaSecret': 'ALPACA_SECRET_KEY',
      'field.placeholder.fmpKey': 'FMP_API_KEY',
      'field.placeholder.finnhubKey': 'FINNHUB_API_KEY',
      'field.placeholder.polygonKey': 'POLYGON_API_KEY',
      'field.placeholder.tushareToken': 'TUSHARE_TOKEN',
      'field.placeholder.akshareUrl': 'http://127.0.0.1:8080 (built-in default)',
      'field.placeholder.qmtUrl': 'http://127.0.0.1:5800',
      'field.placeholder.futuHost': '127.0.0.1',
      'field.placeholder.futuPort': '11111',
      'field.placeholder.ibkrUrl': 'https://localhost:5000',
      'field.placeholder.longbridgeAppKey': 'LONGBRIDGE_APP_KEY',
      'field.placeholder.longbridgeAppSecret': 'LONGBRIDGE_APP_SECRET',
      'field.placeholder.longbridgeAccessToken': 'LONGBRIDGE_ACCESS_TOKEN',
      'field.placeholder.tigerId': 'TIGER_ID',
      'field.placeholder.tigerPrivateKey': 'TIGER_PRIVATE_KEY',
}
