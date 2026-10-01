/**
 * dsh-trading 移动端首屏（P4 ④，本地构建路线）。
 *
 * 现在真的用上了契约面：能力清单与版本协商都走 @dshtrading/contract/core（session.ts），
 * 不在 App 里另写一份判据。
 *
 * 诚实标注：**尚未连接 bot**（配对流程未接），所以这里显示的是"本地自检"结果 ——
 * 用同一段协商代码、拿一个空响应头跑出来的结论，不代表服务端真实应答。
 */
import { StatusBar } from 'expo-status-bar'
import { StyleSheet, Text, View } from 'react-native'
import { CLIENT_CAPS, describeHandshake, handshake } from './src/session'

/** 本地自检：无服务端应答时协商代码给出的结论（会被真实握手替换）。 */
const LOCAL_SELF_CHECK = describeHandshake(handshake({ headers: {} }))

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>dsh-trading</Text>
      <Text style={styles.section}>客户端能力</Text>
      <Text style={styles.mono}>{CLIENT_CAPS.join('、')}</Text>
      <Text style={styles.section}>契约自检（未连服务端）</Text>
      <Text style={styles.mono}>{LOCAL_SELF_CHECK}</Text>
      <Text style={styles.note}>
        尚未连接 bot：配对流程（edge 的一次性配对码 → 设备令牌）与数据源守卫是下一步。
      </Text>
      <StatusBar style="auto" />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 6 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  section: { fontSize: 12, opacity: 0.6, marginTop: 10 },
  mono: { fontSize: 14, textAlign: 'center' },
  note: { fontSize: 12, opacity: 0.7, textAlign: 'center', marginTop: 16 },
})
