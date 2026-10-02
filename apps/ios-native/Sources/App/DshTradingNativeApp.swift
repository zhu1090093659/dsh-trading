import SwiftUI
import DshTradingContract

/// App 入口（本卡只立骨架：界面是占位，契约面才是产物）。
///
/// 写作用域：apps/ios-native/Sources/App/**
@main
struct DshTradingNativeApp: App {
    var body: some Scene {
        WindowGroup {
            ContractSurfacePlaceholderView()
        }
    }
}

/// 占位首页：契约面已就绪（版本协商 / 卡片封闭枚举 / 确认档位 / 推送载荷 / 离线陈旧度 / 数据源守卫），
/// 但还没有网络与界面。这里只显示契约面自检结果，证明骨架是可运行产物而不是一句声明。
struct ContractSurfacePlaceholderView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("DSH Trading (iOS native)").font(.headline)
            Text("契约面已冻结：" + String(CardType.allCases.count) + " 卡片类型 / "
                 + String(ActionKind.allCases.count) + " 动作 / "
                 + String(ConfirmLevel.allCases.count) + " 确认档位")
                .font(.footnote)
            Text("界面与网络尚未接线（后续子卡认领 Transport/Domain/Features/Alerts/Offline）")
                .font(.caption)
        }
        .padding()
    }
}
