//
//  CardCoalescing.swift
//  Offline
//
//  冻结件 §9：**大量卡片更新合并（coalesce）后一次发布到 UI**。
//
//  两条判据：
//    1. **按 cardId 取 revision 最大的一版**：契约规定 revision 只增不减，
//       客户端据此丢弃乱序到达的旧版本 —— 若把旧版本留在缓冲里后发出去，
//       用户面前的卡片会"倒退"到一个更旧的状态，而这是静默的。
//    2. **输出顺序稳定**（按首次出现顺序）：让 diff 与快照对比可复现。
//

import Foundation
import DshTradingContract

/// 卡片合并。
public enum CardCoalescer {
    /// 同一 cardId 只保留 revision 最大的一版；同 revision 保留先到的那一份。
    public static func coalesce(_ updates: [Card]) -> [Card] {
        var order: [String] = []
        var best: [String: Card] = [:]
        for card in updates {
            guard let existing = best[card.cardId] else {
                order.append(card.cardId)
                best[card.cardId] = card
                continue
            }
            if card.revision > existing.revision {
                best[card.cardId] = card
            }
        }
        return order.compactMap { best[$0] }
    }
}

/// 合并缓冲：多次 offer 攒在一起，drain 时**一次**给出合并后的结果。
public struct CoalescingBuffer: Sendable {
    private var pending: [Card] = []

    public init() {}

    public var pendingCount: Int { pending.count }

    public mutating func offer(_ cards: [Card]) {
        pending.append(contentsOf: cards)
    }

    public mutating func offer(_ card: Card) {
        pending.append(card)
    }

    /// 取出并清空：调用方拿这一份去发布（一次）。
    public mutating func drain() -> [Card] {
        let merged = CardCoalescer.coalesce(pending)
        pending.removeAll()
        return merged
    }
}
