/**
 * 公告类数据源统一判别（2026-09-02 评审 M2）：QuoteStage 知识图钉、NewsFeedPane
 * 公告 Tab 过滤、bridge 智能回退判定三处共用，避免谓词漂移——此前 QuoteStage
 * 认不出 sec-edgar/binance/okx，导致 us/crypto 公告进得了 Tab 却永不上图钉。
 *
 * 现役公告源：eastmoney-announcement（cn/hk 官方公告）、sec-edgar（us SEC 披露）、
 * binance / okx（crypto 交易所公报）；关键词兜底覆盖未来新增的同类源。
 */
export function isAnnouncementSource(source: string): boolean {
  if (source === 'eastmoney-announcement' || source === 'sec-edgar' || source === 'binance' || source === 'okx') return true
  const lower = source.toLowerCase()
  return lower.includes('announcement')
    || lower.includes('exchange')
    || lower.includes('公告')
    || lower.includes('交易所')
}
