/**
 * 内置标的字典（host 侧 SSOT，issue #33 / P4）：每市场常见标的的 symbol + 中文名
 * 静态种子。原为 client-ui-trading 内部常量（且无消费方），升位到 router 供
 * `instruments_search` 工具与桥共用；**静态快照**——新上市标的靠动态全集
 * （registry.active(market).listInstruments?()）与本表并集兜底。
 *
 * 词汇纪律：symbol 一律市场规范词汇（docs/symbol-vocabulary.md）。
 *
 * 纯数据模块（零依赖，浏览器/Node 双端安全）。
 * @module @dshtrading/router/catalog
 */

/** 市场词汇（与 api MarketId 同词汇；本地定义保持本模块零依赖）。 */
export type CatalogMarket = 'crypto' | 'us' | 'cn' | 'hk'

export interface CatalogEntry {
  symbol: string
  name: string
  pinyin?: string
}

export const SYMBOL_CATALOG: Record<CatalogMarket, CatalogEntry[]> = {
  crypto: [
    { symbol: 'BTCUSDT', name: '比特币', pinyin: 'BTC,BITCOIN,BITEBI' },
    { symbol: 'ETHUSDT', name: '以太坊', pinyin: 'ETH,ETHEREUM,YITAIFANG' },
    { symbol: 'SOLUSDT', name: 'Solana', pinyin: 'SOL' },
    { symbol: 'BNBUSDT', name: 'BNB', pinyin: 'BNB' },
    { symbol: 'XRPUSDT', name: 'XRP', pinyin: 'XRP,RIPPLE,RUIBO' },
    { symbol: 'DOGEUSDT', name: '狗狗币', pinyin: 'DOGE,GOUGOUBI' },
    { symbol: 'ADAUSDT', name: '艾达币', pinyin: 'ADA,AIDABI' },
    { symbol: 'TRXUSDT', name: '波场', pinyin: 'TRX,BOCHANG' },
    { symbol: 'AVAXUSDT', name: '雪崩', pinyin: 'AVAX,XUEBENG' },
    { symbol: 'LINKUSDT', name: '链link', pinyin: 'LINK' },
    { symbol: 'TONUSDT', name: 'Toncoin', pinyin: 'TON' },
    { symbol: 'SHIBUSDT', name: '屎币', pinyin: 'SHIB,SHIBI' },
    { symbol: 'SUIUSDT', name: 'Sui', pinyin: 'SUI' },
    { symbol: 'DOTUSDT', name: '波卡', pinyin: 'DOT,BOKA' },
    { symbol: 'LTCUSDT', name: '莱特币', pinyin: 'LTC,LAITEBI' },
    { symbol: 'BCHUSDT', name: '比特币现金', pinyin: 'BCH' },
    { symbol: 'NEARUSDT', name: 'NEAR', pinyin: 'NEAR' },
    { symbol: 'APTUSDT', name: 'Aptos', pinyin: 'APT' },
    { symbol: 'ARBUSDT', name: 'Arbitrum', pinyin: 'ARB' },
    { symbol: 'OPUSDT', name: 'Optimism', pinyin: 'OP' },
    { symbol: 'ATOMUSDT', name: 'Cosmos', pinyin: 'ATOM' },
    { symbol: 'XLMUSDT', name: '恒星币', pinyin: 'XLM' },
    { symbol: 'HBARUSDT', name: 'Hedera', pinyin: 'HBAR' },
    { symbol: 'INJUSDT', name: 'Injective', pinyin: 'INJ' },
    { symbol: 'SEIUSDT', name: 'Sei', pinyin: 'SEI' },
    { symbol: 'TIAUSDT', name: 'Celestia', pinyin: 'TIA' },
    { symbol: 'PEPEUSDT', name: 'Pepe', pinyin: 'PEPE' },
    { symbol: 'WIFUSDT', name: 'dogwifhat', pinyin: 'WIF' },
    { symbol: 'BONKUSDT', name: 'Bonk', pinyin: 'BONK' },
    { symbol: 'ORDIUSDT', name: 'ORDI', pinyin: 'ORDI' },
    { symbol: 'NOTUSDT', name: 'Notcoin', pinyin: 'NOT' },
    { symbol: 'UNIUSDT', name: 'Uniswap', pinyin: 'UNI' },
    { symbol: 'AAVEUSDT', name: 'Aave', pinyin: 'AAVE' },
    { symbol: 'RENDERUSDT', name: 'Render', pinyin: 'RENDER' },
    { symbol: 'FETUSDT', name: 'ASAI', pinyin: 'FET' },
    { symbol: 'WLDUSDT', name: '世界币', pinyin: 'WLD,SHIJIEBI' },
    { symbol: 'JUPUSDT', name: 'Jupiter', pinyin: 'JUP' },
    { symbol: 'PYTHUSDT', name: 'Pyth', pinyin: 'PYTH' },
    { symbol: 'STXUSDT', name: 'Stacks', pinyin: 'STX' },
    { symbol: 'IMXUSDT', name: 'Immutable', pinyin: 'IMX' },
    { symbol: 'GALAUSDT', name: 'Gala', pinyin: 'GALA' },
    { symbol: 'SANDUSDT', name: 'The Sandbox', pinyin: 'SAND' },
    { symbol: 'MANAUSDT', name: 'Decentraland', pinyin: 'MANA' },
    { symbol: 'AXSUSDT', name: 'Axie Infinity', pinyin: 'AXS' },
    { symbol: 'CRVUSDT', name: 'Curve', pinyin: 'CRV' },
    { symbol: 'LDOUSDT', name: 'Lido DAO', pinyin: 'LDO' },
    { symbol: 'ETCUSDT', name: '以太经典', pinyin: 'ETC' },
    { symbol: 'FILUSDT', name: 'Filecoin', pinyin: 'FIL' },
    { symbol: 'MATICUSDT', name: 'Polygon', pinyin: 'MATIC' },
    { symbol: 'ETHBTC', name: 'ETH/BTC', pinyin: 'ETHBTC' },
  ],
  us: [
    { symbol: 'AAPL', name: '苹果', pinyin: 'AAPL,APPLE,PG,PINGGUO' },
    { symbol: 'MSFT', name: '微软', pinyin: 'MSFT,MICROSOFT,WR,WEIRUAN' },
    { symbol: 'GOOGL', name: '谷歌', pinyin: 'GOOGL,GOOGLE,GG,GUGE' },
    { symbol: 'AMZN', name: '亚马逊', pinyin: 'AMZN,AMAZON,YMX,YAMAXUN' },
    { symbol: 'META', name: 'Meta', pinyin: 'META,FACEBOOK,FB' },
    { symbol: 'NVDA', name: '英伟达', pinyin: 'NVDA,NVIDIA,YWD,YINGWEIDA' },
    { symbol: 'TSLA', name: '特斯拉', pinyin: 'TSLA,TESLA,TSL,TESILA' },
    { symbol: 'AVGO', name: '博通', pinyin: 'AVGO,BROADCOM,BT,BOTONG' },
    { symbol: 'TSM', name: '台积电', pinyin: 'TSM,TSMC,TJD,TAIJIDIAN' },
    { symbol: 'LLY', name: '礼来', pinyin: 'LLY,LILLY,LL,LILAI' },
    { symbol: 'JPM', name: '摩根大通', pinyin: 'JPM,MGDT,MOGENDATONG' },
    { symbol: 'V', name: 'Visa', pinyin: 'V,VISA' },
    { symbol: 'MA', name: '万事达', pinyin: 'MA,MASTERCARD,WSD,WANSHIDA' },
    { symbol: 'UNH', name: '联合健康', pinyin: 'UNH,LHJK,LIANHEJIANKANG' },
    { symbol: 'JNJ', name: '强生', pinyin: 'JNJ,QS,QIANGSHENG' },
    { symbol: 'WMT', name: '沃尔玛', pinyin: 'WMT,WALMART,WEM,WOERMA' },
    { symbol: 'PG', name: '宝洁', pinyin: 'PG,BJ,BAOJIE' },
    { symbol: 'HD', name: '家得宝', pinyin: 'HD,HOMEDEPOT,JDB,JIADEBAO' },
    { symbol: 'ORCL', name: '甲骨文', pinyin: 'ORCL,ORACLE,JGW,JIAGUWEN' },
    { symbol: 'CRM', name: '赛富时', pinyin: 'CRM,SALESFORCE,SFS,SAIFUSHI' },
    { symbol: 'NFLX', name: '奈飞', pinyin: 'NFLX,NETFLIX,NF,NAIFEI' },
    { symbol: 'AMD', name: '超威半导体', pinyin: 'AMD,CWBDT,CHAOWEI' },
    { symbol: 'INTC', name: '英特尔', pinyin: 'INTC,INTEL,YTE,YINGTEER' },
    { symbol: 'QCOM', name: '高通', pinyin: 'QCOM,QUALCOMM,GT,GAOTONG' },
    { symbol: 'TXN', name: '德州仪器', pinyin: 'TXN,DZYQ,DEZHOUYIQI' },
    { symbol: 'ADBE', name: 'Adobe', pinyin: 'ADBE,ADOBE' },
    { symbol: 'PYPL', name: 'PayPal', pinyin: 'PYPL,PAYPAL' },
    { symbol: 'DIS', name: '迪士尼', pinyin: 'DIS,DISNEY,DSN,DISHINI' },
    { symbol: 'KO', name: '可口可乐', pinyin: 'KO,COCACOLA,KKKL,KEKOUKELE' },
    { symbol: 'PEP', name: '百事', pinyin: 'PEP,PEPSI,BS,BAISHI' },
    { symbol: 'MCD', name: '麦当劳', pinyin: 'MCD,MCDONALDS,MDL,MAIDANGLAO' },
    { symbol: 'NKE', name: '耐克', pinyin: 'NKE,NIKE,NK,NAIKE' },
    { symbol: 'BA', name: '波音', pinyin: 'BA,BOEING,BY,BOYIN' },
    { symbol: 'CAT', name: '卡特彼勒', pinyin: 'CAT,KTPL,KATEBILE' },
    { symbol: 'XOM', name: '埃克森美孚', pinyin: 'XOM,EXXON,AKSMF' },
    { symbol: 'CVX', name: '雪佛龙', pinyin: 'CVX,CHEVRON,XFL,XUEFOLONG' },
    { symbol: 'BAC', name: '美国银行', pinyin: 'BAC,MGYH,MEIGUOYINHANG' },
    { symbol: 'C', name: '花旗', pinyin: 'C,CITI,HQ,HUAQI' },
    { symbol: 'GS', name: '高盛', pinyin: 'GS,GOLDMAN,GS,GAOSHENG' },
    { symbol: 'MS', name: '摩根士丹利', pinyin: 'MS,MORGAN,MGSDL' },
    { symbol: 'BLK', name: '贝莱德', pinyin: 'BLK,BLACKROCK,BLD,BEILAIDE' },
    { symbol: 'UBER', name: '优步', pinyin: 'UBER,YB,YOUBU' },
    { symbol: 'ABNB', name: '爱彼迎', pinyin: 'ABNB,AIRBNB,ABY,AIBIYING' },
    { symbol: 'COIN', name: 'Coinbase', pinyin: 'COIN,COINBASE' },
    { symbol: 'MSTR', name: '微策略', pinyin: 'MSTR,MICROSTRATEGY,WCL,WEICELVE' },
    { symbol: 'PLTR', name: 'Palantir', pinyin: 'PLTR,PALANTIR' },
    { symbol: 'SMCI', name: '超微电脑', pinyin: 'SMCI,CWDN,CHAOWEIDIANNAO' },
    { symbol: 'BABA', name: '阿里巴巴', pinyin: 'BABA,ALIBABA,ALBB' },
    { symbol: 'GM', name: '通用汽车', pinyin: 'GM,TYQC,TONGYONGQICHE' },
    { symbol: 'F', name: '福特', pinyin: 'F,FORD,FT,FUTE' },
  ],
  cn: [
    { symbol: '600519.SH', name: '贵州茅台', pinyin: 'GZMT,MT,GUIZHOUMAOTAI,MAOTAI' },
    { symbol: '000001.SZ', name: '平安银行', pinyin: 'PAYH,PA,PINGANYINHANG,PINGAN' },
    { symbol: '600036.SH', name: '招商银行', pinyin: 'ZSYH,ZS,ZHAOSHANGYINHANG,ZHAOSHANG' },
    { symbol: '000333.SZ', name: '美的集团', pinyin: 'MDJT,MD,MEIDEJITUAN,MEIDE' },
    { symbol: '000651.SZ', name: '格力电器', pinyin: 'GLDQ,GL,GELIDIANQI,GELI' },
    { symbol: '601318.SH', name: '中国平安', pinyin: 'ZGPA,PA,ZHONGGUOPINGAN,PINGAN' },
    { symbol: '600900.SH', name: '长江电力', pinyin: 'CJDL,CHANGJIANGDIANLI' },
    { symbol: '601398.SH', name: '工商银行', pinyin: 'GSYH,GS,GONGSHANGYINHANG,GONGHANG' },
    { symbol: '601988.SH', name: '中国银行', pinyin: 'ZGYH,ZG,ZHONGGUOYINHANG,ZHONGHANG' },
    { symbol: '601939.SH', name: '建设银行', pinyin: 'JSYH,JS,JIANSHANG,JIANHANG' },
    { symbol: '600030.SH', name: '中信证券', pinyin: 'ZXZQ,ZX,ZHONGXINZHENGQUAN,ZHONGXIN' },
    { symbol: '601899.SH', name: '紫金矿业', pinyin: 'ZJKY,ZJ,ZIJINKUANGYE,ZIJIN' },
    { symbol: '000002.SZ', name: '万科A', pinyin: 'WKA,WK,WANKEA,WANKE' },
    { symbol: '002594.SZ', name: '比亚迪', pinyin: 'BYD,BIYADI' },
    { symbol: '300750.SZ', name: '宁德时代', pinyin: 'NDSD,ND,NINGDESHIDAI,NINGDE' },
    { symbol: '002475.SZ', name: '立讯精密', pinyin: 'LXJM,LX,LIXUNJINMI,LIXUN' },
    { symbol: '603259.SH', name: '药明康德', pinyin: 'YMKD,YM,YAOMINGKANGDE,YAOMING' },
    { symbol: '600276.SH', name: '恒瑞医药', pinyin: 'HRYY,HR,HENGRUIYIYAO,HENGRUI' },
    { symbol: '000858.SZ', name: '五粮液', pinyin: 'WLY,WULIANGYE' },
    { symbol: '002415.SZ', name: '海康威视', pinyin: 'HKWS,HK,HAIKANGWEISHI,HAIKANG' },
    { symbol: '688981.SH', name: '中芯国际', pinyin: 'ZXGJ,ZX,ZHONGXINGUOJI,ZHONGXIN' },
    { symbol: '601012.SH', name: '隆基绿能', pinyin: 'LJLN,LJ,LONGJILVNENG,LONGJI' },
    { symbol: '600887.SH', name: '伊利股份', pinyin: 'YLGF,YL,YILIGUFEN,YILI' },
    { symbol: '601888.SH', name: '中国中免', pinyin: 'ZGZM,ZM,ZHONGGUOZHONGMIAN,ZHONGMIAN' },
    { symbol: '600028.SH', name: '中国石化', pinyin: 'ZGSH,SH,ZHONGGUOSHIHUA,ZHONGSHIHUA' },
    { symbol: '601857.SH', name: '中国石油', pinyin: 'ZGSY,SY,ZHONGGUOSHIYOU,ZHONGSHIYOU' },
    { symbol: '601668.SH', name: '中国建筑', pinyin: 'ZGJZ,JZ,ZHONGGUOJIANZHU,ZHONGJIAN' },
    { symbol: '601728.SH', name: '中国电信', pinyin: 'ZGDX,DX,ZHONGGUODIANXIN,ZHONGDIANXIN' },
    { symbol: '600941.SH', name: '中国移动', pinyin: 'ZGYD,YD,ZHONGGUOYIDONG,ZHONGYIDONG' },
    { symbol: '600050.SH', name: '中国联通', pinyin: 'ZGLT,LT,ZHONGGUOLIANTONG,ZHONGLIANTONG' },
    { symbol: '300059.SZ', name: '东方财富', pinyin: 'DFCF,DC,DONGFANGCAIFU,DONGCAI' },
    { symbol: '300124.SZ', name: '汇川技术', pinyin: 'HCJS,HC,HUICHUANJISHU,HUICHUAN' },
    { symbol: '002230.SZ', name: '科大讯飞', pinyin: 'KDXF,XF,KEDAXUNFEI,XUNFEI' },
    { symbol: '688111.SH', name: '金山办公', pinyin: 'JSBG,WPS,JINSHANBANGONG,JINSHAN' },
    { symbol: '688041.SH', name: '海光信息', pinyin: 'HGXX,HG,HAIGUANGXINXI,HAIGUANG' },
    { symbol: '002371.SZ', name: '北方华创', pinyin: 'BFHC,HC,BEIFANGHUACHUANG,HUACHUANG' },
    { symbol: '603501.SH', name: '韦尔股份', pinyin: 'WEGF,WE,WEIERGUFEN,WEIER' },
    { symbol: '600584.SH', name: '长电科技', pinyin: 'CDKJ,CD,CHANGDIANKEJI,CHANGDIAN' },
    { symbol: '601127.SH', name: '赛力斯', pinyin: 'SLS,SAILISI' },
    { symbol: '002714.SZ', name: '牧原股份', pinyin: 'MYGF,MY,MUYUANGUFEN,MUYUAN' },
    { symbol: '002745.SZ', name: '木林森', pinyin: 'MLS,MULINSEN' },
    { symbol: '002240.SZ', name: '盛新锂能', pinyin: 'SXLN,SX,SHENGXINLINENG,SHENGXIN' },
    { symbol: '002466.SZ', name: '天齐锂业', pinyin: 'TQLY,TQ,TIANQILIYE,TIANQI' },
    { symbol: '002460.SZ', name: '赣锋锂业', pinyin: 'GFLY,GF,GANFENGLIYE,GANFENG' },
    { symbol: '600438.SH', name: '通威股份', pinyin: 'TWGF,TW,TONGWEIGUFEN,TONGWEI' },
    { symbol: '300274.SZ', name: '阳光电源', pinyin: 'YGDY,YG,YANGGUANGDIANYUAN,YANGGUANG' },
    { symbol: '600000.SH', name: '浦发银行', pinyin: 'PFYH,PF,PUFAYINHANG,PUFA' },
    { symbol: '002142.SZ', name: '宁波银行', pinyin: 'NBYH,NB,NINGBOYINHANG,NINGBO' },
    { symbol: '601166.SH', name: '兴业银行', pinyin: 'XYYH,XY,XINGYEYINHANG,XINGYE' },
    { symbol: '601919.SH', name: '中远海控', pinyin: 'ZYHK,ZY,ZHONGYUANHAIKONG,HAIKONG' },
    { symbol: '000063.SZ', name: '中兴通讯', pinyin: 'ZXTX,ZX,ZHONGXINGTONGXUN,ZHONGXIN' },
    { symbol: '002241.SZ', name: '歌尔股份', pinyin: 'GEGF,GE,GEERGUFEN,GEER' },
    { symbol: '300433.SZ', name: '蓝思科技', pinyin: 'LSKJ,LS,LANSIKEJI,LANSI' },
    { symbol: '603986.SH', name: '兆易创新', pinyin: 'ZYCX,ZY,ZHAOYICHUANGXIN,ZHAOYI' },
    { symbol: '002156.SZ', name: '通富微电', pinyin: 'TFMD,TF,TONGFUWEIDIAN,TONGFU' },
    { symbol: '600460.SH', name: '士兰微', pinyin: 'SLW,SL,SHILANWEI' },
    { symbol: '300014.SZ', name: '亿纬锂能', pinyin: 'YWLN,YW,YIWEILINENG,YIWEI' },
    { symbol: '300015.SZ', name: '爱尔眼科', pinyin: 'AEYK,AE,AERYANKE,AIER' },
  ],
  hk: [
    { symbol: '00700.HK', name: '腾讯控股', pinyin: 'TXKG,TX,TENGXUN,TENGXUNGUFEN' },
    { symbol: '09988.HK', name: '阿里巴巴-W', pinyin: 'ALBB,ALI,ALIBABA' },
    { symbol: '03690.HK', name: '美团-W', pinyin: 'MT,MEITUAN' },
    { symbol: '09618.HK', name: '京东集团-SW', pinyin: 'JDJT,JD,JINGDONG' },
    { symbol: '09999.HK', name: '网易-S', pinyin: 'WY,WANGYI,NTES' },
    { symbol: '09888.HK', name: '百度集团-SW', pinyin: 'BDJT,BD,BAIDU' },
    { symbol: '01024.HK', name: '快手-W', pinyin: 'KS,KUAISHOU' },
    { symbol: '09626.HK', name: '哔哩哔哩-W', pinyin: 'BLBL,BILI,BILIBILI' },
    { symbol: '01810.HK', name: '小米集团-W', pinyin: 'XMJT,XM,XIAOMI' },
    { symbol: '02015.HK', name: '理想汽车-W', pinyin: 'LXQC,LX,LIXIANG,LI' },
    { symbol: '09868.HK', name: '小鹏汽车-W', pinyin: 'XPQC,XP,XIAOPENG,XPEV' },
    { symbol: '09866.HK', name: '蔚来-SW', pinyin: 'WL,WEILAI,NIO' },
    { symbol: '09863.HK', name: '零跑汽车', pinyin: 'LPQC,LP,LINGPAO' },
    { symbol: '01211.HK', name: '比亚迪股份', pinyin: 'BYD,BIYADI' },
    { symbol: '02333.HK', name: '长城汽车', pinyin: 'CCQC,CC,CHANGCHENG' },
    { symbol: '00175.HK', name: '吉利汽车', pinyin: 'JLQC,JL,JILI' },
    { symbol: '00981.HK', name: '中芯国际', pinyin: 'ZXGJ,ZX,ZHONGXINGUOJI,SMIC' },
    { symbol: '00939.HK', name: '建设银行', pinyin: 'JSYH,JS,JIANSHANG' },
    { symbol: '01398.HK', name: '工商银行', pinyin: 'GSYH,GS,GONGSHANG' },
    { symbol: '01299.HK', name: '友邦保险', pinyin: 'YBBX,YB,YOUBANG' },
    { symbol: '02318.HK', name: '中国平安', pinyin: 'ZGPA,PA,PINGAN' },
    { symbol: '00388.HK', name: '香港交易所', pinyin: 'HKEX,XGJYS,GANGJIAOSUO' },
    { symbol: '00005.HK', name: '汇丰控股', pinyin: 'HSBC,HFKG,HUIFENG' },
    { symbol: '00941.HK', name: '中国移动', pinyin: 'ZGYD,YD,YIDONG' },
    { symbol: '00857.HK', name: '中国石油股份', pinyin: 'ZGSY,SY,SHIYOU' },
    { symbol: '00883.HK', name: '中国海洋石油', pinyin: 'ZGHY,CNOOC,HAIYOU' },
    { symbol: '03888.HK', name: '金山软件', pinyin: 'JSRJ,JS,JINSHAN' },
    { symbol: '02628.HK', name: '中国人寿', pinyin: 'ZGRS,RS,RENSHOU' },
    { symbol: '00322.HK', name: '康师傅控股', pinyin: 'KSF,KANGSHIFU' },
    { symbol: '02319.HK', name: '蒙牛乳业', pinyin: 'MNRY,MN,MENGNIU' },
    { symbol: '01876.HK', name: '百威亚太', pinyin: 'BWYT,BW,BAIWEI' },
    { symbol: '00316.HK', name: '东方海外国际', pinyin: 'DFHW,DONGFA' },
    { symbol: '00669.HK', name: '创科实业', pinyin: 'CKSY,CHUANGKE' },
  ],
}

const dynamicCatalogs = new Map<CatalogMarket, CatalogEntry[]>()

/** 注入某市场的动态标的全集（由桥端点拉取并入）。 */
export function setDynamicCatalog(market: CatalogMarket, entries: Array<{ symbol: string; name?: string; pinyin?: string }>): void {
  const normalized: CatalogEntry[] = entries.map((e) => ({
    symbol: e.symbol,
    name: e.name ?? e.symbol,
    pinyin: e.pinyin,
  }))
  dynamicCatalogs.set(market, normalized)
}

/** 累加/增量更新某市场的动态标的名称（由实时行情查询或联想补齐触发）。 */
export function updateDynamicCatalog(market: CatalogMarket, entries: Array<{ symbol: string; name?: string; pinyin?: string }>): void {
  const existing = dynamicCatalogs.get(market) ?? []
  const map = new Map<string, CatalogEntry>()
  for (const e of existing) {
    map.set(e.symbol.toUpperCase(), e)
  }
  for (const e of entries) {
    if (!e.symbol || !e.name) continue
    const sym = e.symbol.toUpperCase()
    // 忽略占位符名字，如 "000938" 或 "000938 (A股)"
    if (e.name === e.symbol || /\(A股\)|\(港股\)/.test(e.name)) continue
    const old = map.get(sym)
    map.set(sym, {
      symbol: e.symbol,
      name: e.name,
      pinyin: e.pinyin ?? old?.pinyin,
    })
  }
  dynamicCatalogs.set(market, Array.from(map.values()))
}

/** 获取静态快照 ∪ 动态全集融合后的标的列表（静态优先保留中文名，动态补充新标的）。 */
export function getMergedCatalog(market: CatalogMarket): CatalogEntry[] {
  const staticList = SYMBOL_CATALOG[market] ?? []
  const dynamicList = dynamicCatalogs.get(market) ?? []
  if (dynamicList.length === 0) return staticList
  const seen = new Set<string>()
  const merged: CatalogEntry[] = []
  for (const entry of staticList) {
    seen.add(entry.symbol.toUpperCase())
    merged.push(entry)
  }
  for (const entry of dynamicList) {
    const sym = entry.symbol.toUpperCase()
    if (!seen.has(sym)) {
      seen.add(sym)
      merged.push(entry)
    }
  }
  return merged
}

/**
 * 联想搜索：静态 ∪ 动态全集融合，symbol 前缀/包含（大小写不敏感）或中文名包含，返回前 limit 条。
 * 空查询返回空（不打扰）。
 */
export function searchSymbols(market: CatalogMarket, query: string, limit = 8): CatalogEntry[] {
  const q = query.trim().toUpperCase()
  if (q === '') return []
  const catalog = getMergedCatalog(market)
  const scored: Array<{ entry: CatalogEntry; score: number }> = []
  for (const entry of catalog) {
    const symbol = entry.symbol.toUpperCase()
    const name = entry.name ? entry.name.toUpperCase() : ''
    const pinyinList = entry.pinyin ? entry.pinyin.toUpperCase().split(',') : []
    let score = -1
    if (symbol === q || pinyinList.includes(q)) score = 0
    else if (symbol.startsWith(q) || pinyinList.some(p => p.startsWith(q))) score = 1
    else if (name && name.includes(q)) score = 2
    else if (symbol.includes(q) || pinyinList.some(p => p.includes(q))) score = 3
    if (score >= 0) scored.push({ entry, score })
  }

  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.entry)
}

/** 跨市场联想：全部市场字典合并搜索（自选页签的添加是跨市场的）。 */
export interface Suggestion extends CatalogEntry {
  market: CatalogMarket
}

export function searchAllMarkets(query: string, limit = 8): Suggestion[] {
  const q = query.trim().toUpperCase()
  if (q === '') return []
  const markets: CatalogMarket[] = ['crypto', 'us', 'cn', 'hk']
  const all: Array<{ entry: Suggestion; score: number }> = []
  for (const market of markets) {
    const catalog = getMergedCatalog(market)
    for (const entry of catalog) {
      const symbol = entry.symbol.toUpperCase()
      const name = entry.name ? entry.name.toUpperCase() : ''
      const pinyinList = entry.pinyin ? entry.pinyin.toUpperCase().split(',') : []
      let score = -1
      if (symbol === q || pinyinList.includes(q)) score = 0
      else if (symbol.startsWith(q) || pinyinList.some(p => p.startsWith(q))) score = 1
      else if (name && name.includes(q)) score = 2
      else if (symbol.includes(q) || pinyinList.some(p => p.includes(q))) score = 3
      if (score >= 0) all.push({ entry: { ...entry, market }, score })
    }
  }
  return all.sort((a, b) => a.score - b.score).slice(0, limit).map(s => s.entry)
}
