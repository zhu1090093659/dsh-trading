/**
 * dsh-trading 移动端首屏（P4 ④，本地构建路线）。
 *
 * 这一版把配对流程真的接上了：输入 bot 基址与一次性配对码 → 首屏流程（home-flow）
 * 配对并落库（expo-secure-store）→ 显示设备 scopes、服务端状态与数据陈旧度；
 * **未配对时显示"未配对"而不是空屏**，并提供断开（清除本机凭据）入口。
 *
 * 判据不在这里（App 只渲染）：
 *   - 陈旧度 → 契约 offlineView（src/offline.ts 翻译成横幅）；
 *   - 控制/审批动作的确认档位 → 契约 ACTION_CONFIRM（src/confirm.ts 的 gateForAction）；
 *   - 令牌怎么发、发去哪 → credential-store（只进安全存储、与配对地址绑定）与 api.ts。
 *
 * 诚实标注：真机、APNs 推送与生物识别的**设备侧行为**未验（属人这侧），本文件只保证
 * JS 侧把已有能力接上；设备上是否弹生物识别、Keychain 是否可用，需要在真机跑一遍。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import { StatusBar } from 'expo-status-bar'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { createCredentialStore } from './src/credential-store'
import { createHomeFlow, DEFAULT_BUDGETS, type ControlGateView, type HomeSnapshot } from './src/home-flow'
import { redeemPairingCode } from './src/pairing'
import { createSecureStoreKeyValue } from './src/secure-store'
import { createSessionManager } from './src/session-manager'

/** 组装首屏流程：安全存储（Keychain/Keystore）→ 凭据 → 会话管理器。 */
function createAppFlow() {
  const store = createCredentialStore(
    createSecureStoreKeyValue(SecureStore, {
      // 令牌不随备份迁移到新设备：换机必须重新配对（与"凭据绑定这台设备"一致）
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  )
  return createHomeFlow({
    manager: createSessionManager({ store, redeem: redeemPairingCode }),
    now: () => Date.now(),
    budgets: DEFAULT_BUDGETS,
  })
}

/** 把确认档位翻成一行界面文字（档位本身来自契约，这里只是措辞）。 */
function describeGate(control: ControlGateView): string {
  const level = control.decision.kind === 'allow' ? '无需确认' : control.decision.prompt
  const scope = control.granted
    ? '本机已授予 ' + control.scope
    : '本机未授予 ' + control.scope + '（服务端会拒绝该动作）'
  return level + '；' + scope
}

/** 数据横幅：没数据是 notice，有数据看陈旧度。 */
function describeBanner(snapshot: HomeSnapshot): string {
  if (snapshot.banner.kind === 'notice') return snapshot.banner.hint
  const hint = snapshot.banner.hint === '' ? '数据新鲜' : snapshot.banner.hint
  return hint + '（陈旧度：' + snapshot.banner.staleness + '）'
}

export default function App() {
  const flow = useMemo(createAppFlow, [])
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(() => flow.snapshot())
  const [baseUrl, setBaseUrl] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    let alive = true
    void flow.restore().then((next) => {
      if (alive) setSnapshot(next)
    })
    return () => {
      alive = false
    }
  }, [flow])

  const onPair = useCallback(() => {
    void flow.pair({ baseUrl, code }).then((next) => {
      setSnapshot(next)
      // 配对码是一次性的：成功即清空输入，失败保留让用户改
      if (next.state === 'paired') setCode('')
    })
  }, [flow, baseUrl, code])

  const onForget = useCallback(() => {
    void flow.forget().then(setSnapshot)
  }, [flow])

  const onSync = useCallback(() => {
    void flow.sync().then(setSnapshot)
  }, [flow])

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>dsh-trading</Text>

      {snapshot.state === 'paired' ? (
        <View style={styles.block}>
          <Text style={styles.section}>已配对</Text>
          <Text style={styles.row}>设备：{snapshot.deviceId}</Text>
          <Text style={styles.row}>bot：{snapshot.baseUrl}</Text>
          <Text style={styles.row}>作用域：{snapshot.scopesText}</Text>
          <Text style={styles.note}>{snapshot.expiryHint}</Text>

          {snapshot.error === null ? null : (
            <Text style={styles.error}>
              最近一次失败：{snapshot.error.code} · {snapshot.error.message}
            </Text>
          )}

          <Text style={styles.section}>服务端</Text>
          <Text style={styles.row}>
            {snapshot.stateText === '' ? '尚未取到状态' : snapshot.stateText}
            {snapshot.lastSyncAtMs === null ? '' : '（' + new Date(snapshot.lastSyncAtMs).toLocaleTimeString() + '）'}
          </Text>
          {snapshot.lastSyncError === null ? null : (
            <Text style={styles.error}>
              取状态失败：{snapshot.lastSyncError.code} · {snapshot.lastSyncError.message}
            </Text>
          )}
          <Text style={styles.row}>
            {snapshot.capsHeader === null ? '服务端未声明能力（响应里没有 x-dsht-caps）' : '契约：' + snapshot.contractText}
          </Text>
          <Pressable onPress={onSync} style={styles.button}>
            <Text style={styles.buttonText}>刷新服务端状态</Text>
          </Pressable>

          <Text style={styles.section}>数据</Text>
          <Text style={styles.mono}>{describeBanner(snapshot)}</Text>

          <Text style={styles.section}>控制动作</Text>
          <Text style={styles.mono}>{'kill：' + describeGate(snapshot.control)}</Text>

          <Pressable onPress={onForget} style={[styles.button, styles.danger]}>
            <Text style={styles.buttonText}>断开（清除本机凭据）</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.block}>
          <Text style={styles.section}>未配对</Text>
          <Text style={styles.note}>
            在桌面上生成一次性配对码：填入 bot 基址与配对码即可绑定本机。配对码一次有效。
          </Text>
          <TextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="http://192.168.1.10:3081"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={snapshot.state !== 'pairing'}
          />
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="一次性配对码"
            autoCapitalize="none"
            autoCorrect={false}
            editable={snapshot.state !== 'pairing'}
          />
          <Pressable onPress={onPair} disabled={snapshot.state === 'pairing'} style={styles.button}>
            <Text style={styles.buttonText}>{snapshot.state === 'pairing' ? '正在配对…' : '配对'}</Text>
          </Pressable>
          {snapshot.error === null ? null : (
            <Text style={styles.error}>
              失败：{snapshot.error.code} · {snapshot.error.message}
            </Text>
          )}

          <Text style={styles.section}>数据</Text>
          <Text style={styles.mono}>{describeBanner(snapshot)}</Text>
        </View>
      )}

      <StatusBar style="auto" />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72, gap: 6 },
  block: { gap: 6 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  section: { fontSize: 12, opacity: 0.6, marginTop: 14 },
  row: { fontSize: 14 },
  mono: { fontSize: 14 },
  note: { fontSize: 12, opacity: 0.7 },
  error: { fontSize: 13, color: '#b00020' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  button: { marginTop: 10, backgroundColor: '#1f6feb', borderRadius: 6, paddingVertical: 10, alignItems: 'center' },
  danger: { backgroundColor: '#b00020' },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
})
