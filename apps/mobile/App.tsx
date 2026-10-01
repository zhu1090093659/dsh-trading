/**
 * dsh-trading 移动端骨架（P4 ④，本地构建路线）。
 *
 * 当前状态：**只有骨架**。契约面接线（设备配对 / 数据源守卫 / 推送载荷 / 离线陈旧度 / 生物识别确认）
 * 是下一步；之所以先立骨架，是因为本机工具链已实测通过（见 README 的证据节），
 * 骨架的价值是让"能不能构建"这个问题在仓库里有可复现的答案。
 */
import { StatusBar } from 'expo-status-bar'
import { StyleSheet, Text, View } from 'react-native'

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>dsh-trading</Text>
      <Text style={styles.note}>移动端骨架：尚未接入契约面（设备配对 / 数据源守卫 / 确认闸门）</Text>
      <StatusBar style="auto" />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  note: { fontSize: 13, opacity: 0.7, textAlign: 'center' },
})
