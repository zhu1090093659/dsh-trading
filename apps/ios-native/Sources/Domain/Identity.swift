//
//  Identity.swift
//  Domain
//
//  机器人 = 稳定身份 + 策略版本 + 运行实例，**三者必须可区分**。
//
//  这三件事会被混为一谈，而混为一谈的代价是真实的：
//    - 只认"身份"：换了策略版本还以为在跑老策略；
//    - 只认"运行实例"：重启一次的 id 变了，就说不出这是同一台机器人；
//    - 把"策略版本"当成身份：一次策略调整就被记成一台新机器人，绩效被切断。
//
//  关系是包含式的：一个 BotIdentity 之下有多个 StrategyVersion，
//  一个 StrategyVersion 之下有多个 RunInstance。
//

/// 机器人的**稳定身份**：跨策略版本、跨运行实例不变。
public struct BotIdentity: Hashable, Sendable {
    public let id: BotId
    public let displayName: String
    public let venue: String
    public let account: AccountRef
    public let createdAtMs: EpochMillis

    public init(id: BotId, displayName: String, venue: String, account: AccountRef, createdAtMs: EpochMillis) {
        self.id = id
        self.displayName = displayName
        self.venue = venue
        self.account = account
        self.createdAtMs = createdAtMs
    }
}

/// 一个被冻结的策略版本。同一机器人的版本之间是**替换**关系，不是新机器人。
public struct StrategyVersion: Hashable, Sendable {
    public let id: StrategyVersionId
    public let botId: BotId
    public let strategyId: String
    public let version: String
    public let contentHash: String
    public let activatedAtMs: EpochMillis

    public init(id: StrategyVersionId, botId: BotId, strategyId: String, version: String, contentHash: String, activatedAtMs: EpochMillis) {
        self.id = id
        self.botId = botId
        self.strategyId = strategyId
        self.version = version
        self.contentHash = contentHash
        self.activatedAtMs = activatedAtMs
    }
}

/// 某个策略版本在某个时间窗里的一次实际运行。
/// **换代不是同一件事**：重启开新运行实例，策略版本可以不变。
public struct RunInstance: Hashable, Sendable {
    public let id: RunInstanceId
    public let botId: BotId
    public let strategyVersionId: StrategyVersionId
    public let startedAtMs: EpochMillis
    public let endedAtMs: EpochMillis?
    public let host: String?

    public init(id: RunInstanceId, botId: BotId, strategyVersionId: StrategyVersionId, startedAtMs: EpochMillis, endedAtMs: EpochMillis?, host: String?) {
        self.id = id
        self.botId = botId
        self.strategyVersionId = strategyVersionId
        self.startedAtMs = startedAtMs
        self.endedAtMs = endedAtMs
        self.host = host
    }

    public var isOpen: Bool { endedAtMs == nil }
}

/// 一台机器人及其版本/运行史。三者的关系在这里可查。
public struct BotRoster: Hashable, Sendable {
    public let bot: BotIdentity
    public let strategyVersions: [StrategyVersion]
    public let runs: [RunInstance]

    public init(bot: BotIdentity, strategyVersions: [StrategyVersion], runs: [RunInstance]) {
        self.bot = bot
        self.strategyVersions = strategyVersions
        self.runs = runs
    }

    public func strategyVersion(of run: RunInstance) -> StrategyVersion? {
        strategyVersions.first { $0.id == run.strategyVersionId }
    }

    /// 截至 atMs 仍处于打开状态的运行实例（按开始时间取最后一个）。
    public func currentRun(atMs: EpochMillis) -> RunInstance? {
        runs
            .filter { $0.startedAtMs <= atMs && ($0.endedAtMs == nil || $0.endedAtMs! > atMs) }
            .max { $0.startedAtMs < $1.startedAtMs }
    }

    public func runs(ofStrategyVersion id: StrategyVersionId) -> [RunInstance] {
        runs.filter { $0.strategyVersionId == id }
    }

    /// 三件事是否真的是同一台机器人的：身份一致、版本属于该身份、运行属于该版本。
    public func isCoherent(run: RunInstance) -> Bool {
        guard run.botId == bot.id else { return false }
        guard let version = strategyVersion(of: run) else { return false }
        return version.botId == bot.id
    }
}
