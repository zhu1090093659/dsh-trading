import SwiftUI
import DshTradingContract
import DshTradingDomain
import DshTradingFeatures

/// App 入口。装配在 `AppEnvironment`，这里只决定"当前该显示哪一屏"：
///   1. 环境不可用 ⇒ 如实说明，不假装能工作；
///   2. 未配对（live）⇒ 配对门（走 PairingClient）；
///   3. 已配对 / fixtures ⇒ 观测面（Features 的五个入口）。
///
/// 写作用域：apps/ios-native/Sources/App/**（IOS-1）
@main
struct DshTradingNativeApp: App {
    @State private var environment = AppEnvironment(mode: AppEnvironment.launchMode())

    var body: some Scene {
        WindowGroup {
            AppRootView(environment: environment)
        }
    }
}

struct AppRootView: View {
    let environment: AppEnvironment

    var body: some View {
        VStack(spacing: 0) {
            if let problem = environment.blockingProblem {
                EnvironmentProblemView(message: problem)
            } else {
                // 告警只提示，不挡路（Keychain 退回内存 ≠ 不能用；fixtures 更不依赖令牌）。
                ForEach(environment.notices, id: \.self) { notice in
                    WarningBanner(message: notice)
                }
                if environment.isObserving {
                    ObservationRootView(environment: environment)
                } else {
                    PairingGateView(environment: environment)
                }
            }
        }
        // 观测面不依赖 tick 流（快照是契约）：这里只是按时重取一次快照，断了也不影响执行。
        .task {
            while !Task.isCancelled {
                await environment.refresh()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }
}

struct ObservationRootView: View {
    let environment: AppEnvironment

    var body: some View {
        if let store = environment.store, let dispatcher = environment.dispatcher {
            let nowMs = environment.nowMs()
            let state = FeaturesAdapter.featuresState(from: FeaturesAdapterInput(
                observation: store.observation,
                runtimeMode: environment.runtimeMode,
                nowMs: nowMs,
                contractGaps: AppEnvironment.contractGaps
            ))
            VStack(spacing: 0) {
                if environment.mode == .fixtures {
                    FixtureBanner()
                }
                RootTabView(state: state, dispatcher: dispatcher, nowMs: nowMs)
            }
        } else {
            ContentUnavailableView(
                "观测面未装配",
                systemImage: "antenna.radiowaves.left.and.right.slash",
                description: Text("没有可用的观测源：请先在设置里完成设备配对。")
            )
        }
    }
}

struct FixtureBanner: View {
    var body: some View {
        Text("夹具模式：数据是本机造的，不是真实机器人。")
            .font(.caption)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.yellow.opacity(0.25))
    }
}

/// 可继续的环境告警（例如 Keychain 不可用 ⇒ 退回内存存储）。
struct WarningBanner: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(.orange.opacity(0.2))
    }
}

struct EnvironmentProblemView: View {
    let message: String

    var body: some View {
        ContentUnavailableView("环境不可用", systemImage: "exclamationmark.triangle", description: Text(message))
    }
}

/// 配对门：未配对是一个**明确状态**，不是一个空白屏。
/// 配对只换取设备令牌，**不做授权**（配对永不签发 control）；作用域只来自 /a0/status。
struct PairingGateView: View {
    let environment: AppEnvironment

    @State private var baseURL = ""
    @State private var code = ""
    @State private var name = "我的 iPhone"

    var body: some View {
        NavigationStack {
            Form {
                Section("配对") {
                    TextField("bot 地址（https://…）", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("一次性配对码", text: $code)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("设备名", text: $name)
                }

                Section {
                    Button {
                        Task { await environment.pair(baseURL: baseURL, code: code, name: name) }
                    } label: {
                        if environment.pairingBusy { ProgressView() } else { Text("配对") }
                    }
                    .disabled(environment.pairingBusy || baseURL.isEmpty || code.isEmpty)
                } footer: {
                    Text("配对码是一次性的。配对只换取设备令牌，不签发任何控制权限；能否按某个动作由服务端按作用域裁定。")
                }

                if let message = environment.pairingMessage {
                    Section("结果") { Text(message).font(.footnote) }
                }

                Section {
                    Text(environment.sessionState.text).font(.footnote)
                    Text("还没有机器人可看时，App 会如实显示「看不到机器人」，**不会**显示成「机器人已停止」。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("DSH Trading")
        }
    }
}
