/**
 * 5 段 cron 解析与下次运行时间计算（右侧栏定时任务的调度纯模块）。
 *
 * 实现移植自 dsh-web 仓库 dsh-task-board 的 core/schedule.ts（2026-09 已在同机
 * 验证过 DST/闰年语义），零依赖、框架无关：调度器（service.ts）与 UI 预览
 * （client 半）共享同一份词汇。语法：五个空白分隔字段 = 分 时 日 月 周；每个
 * 字段支持星号通配、步进（星号/n）、闭区间 a-b、单值与逗号混合列表；周字段 0/7 均为周日；日与周
 * 同时受限时按标准 cron 的 OR 语义合并；时区基准为宿主本地时区。非法表达式
 * parseCron 返回 null，由协议层/UI 拒绝。
 */

/** 一条 cron 表达式解析出的各字段匹配集。 */
export interface CronSchedule {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  /** 周几 0-6，0 = 周日（输入 7 归一化为 0）。 */
  weekdays: ReadonlySet<number>
  /** 日字段是否为字面 '*'（未受限）。 */
  dayWildcard: boolean
  /** 周字段是否为字面 '*'（未受限）。 */
  weekdayWildcard: boolean
}

/** 各字段的闭区间，按 cron 顺序。 */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // 分钟
  [0, 23], // 小时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周几（7 = 周日，下方归一化）
]

/**
 * 解析 5 段 cron 表达式。
 * @returns 各字段匹配集；表达式非法时返回 null。
 */
export function parseCron(expr: string): CronSchedule | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets: Set<number>[] = []
  for (let index = 0; index < 5; index++) {
    const bounds = FIELD_RANGES[index]
    const field = fields[index]
    const set = new Set<number>()
    if (bounds === undefined || field === undefined || !parseField(field, bounds[0], bounds[1], set)) return null
    sets.push(set)
  }
  const weekdays = new Set<number>()
  // 不变式：fields.length === 5 已验证，上方循环恰好 push 5 个字段集，索引必存在。
  for (const day of sets[4]!) weekdays.add(day === 7 ? 0 : day)
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    days: sets[2]!,
    months: sets[3]!,
    weekdays,
    // 只有字面 '*' 算未受限：显式全枚举（如 '1-31'）仍是受限字段，必须参与
    // 日/周的 OR 语义，不能塌缩成通配。
    dayWildcard: fields[2] === '*',
    weekdayWildcard: fields[4] === '*',
  }
}

/** 表达式是否可解析。 */
export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

/**
 * 计算 `fromMs`（ms epoch）之后严格晚于它的下一个匹配时刻，本地时区、分钟粒
 * 度。返回匹配分钟的起始 ms epoch；日历上永不可能匹配（如 `0 0 30 2 *`）时
 * 返回 undefined。5 年上限覆盖完整闰年周期，2 月 29 日排期永远可达。
 *
 * 直接从解析出的字段集枚举候选 年/月/日/时/分，而非逐分钟扫描（稀疏表达式如
 * `0 0 29 2 *` 逐分钟要走 ~150 万分钟才到下一个闰日）；墙钟字段构造 + 末次
 * matches 复检精确保留旧实现的 DST 语义：春季不存在的分钟向前归一化，秋季重
 * 复小时不会被访问两次。
 */
export function nextRunAtMs(expr: string, fromMs: number): number | undefined {
  const schedule = parseCron(expr)
  if (schedule === null) return undefined
  if (!hasPossibleCalendarDay(schedule)) return undefined
  const from = new Date(fromMs)
  const limitMs = fromMs + 5 * 366 * 24 * 60 * 60 * 1000

  const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b)
  const sortedHours = [...schedule.hours].sort((a, b) => a - b)
  const sortedMonths = [...schedule.months].sort((a, b) => a - b)

  let year = from.getFullYear()
  let month = from.getMonth() + 1
  let day = from.getDate()
  let hour = from.getHours()
  // 严格晚于 fromMs：从下一分钟起算。
  let minute = from.getMinutes() + 1

  while (new Date(year, month - 1, 1, 0, 0, 0, 0).getTime() <= limitMs) {
    for (const candidateMonth of sortedMonths) {
      if (candidateMonth < month) continue
      const daysInMonth = new Date(year, candidateMonth, 0).getDate()
      const dayStart = candidateMonth === month ? day : 1
      for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
        const dayProbe = new Date(year, candidateMonth - 1, candidateDay, 0, 0, 0, 0)
        if (!dayCandidate(schedule, dayProbe)) continue
        const hourStart = candidateMonth === month && candidateDay === day ? hour : 0
        for (const candidateHour of sortedHours) {
          if (candidateHour < hourStart) continue
          const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour ? minute : 0
          for (const candidateMinute of sortedMinutes) {
            if (candidateMinute < minuteStart) continue
            const candidate = new Date(year, candidateMonth - 1, candidateDay, candidateHour, candidateMinute, 0, 0)
            const time = candidate.getTime()
            if (time <= fromMs) continue
            if (time > limitMs) return undefined
            if (matches(schedule, candidate)) return time
          }
        }
      }
    }
    year += 1
    month = 1
    day = 1
    hour = 0
    minute = 0
  }
  return undefined
}

/** 日/周 OR 闸门：matches 与候选扫描共用。 */
function dayCandidate(schedule: CronSchedule, date: Date): boolean {
  const dayMatches = schedule.days.has(date.getDate())
  const weekdayMatches = schedule.weekdays.has(date.getDay())
  if (schedule.dayWildcard) return weekdayMatches
  if (schedule.weekdayWildcard) return dayMatches
  return dayMatches || weekdayMatches
}

/** 提前否决日历上不可能的 月/日 组合，省掉多年扫描。 */
function hasPossibleCalendarDay(schedule: CronSchedule): boolean {
  if (schedule.dayWildcard || !schedule.weekdayWildcard) return true
  const maximumDay = new Map<number, number>([
    [1, 31], [2, 29], [3, 31], [4, 30], [5, 31], [6, 30],
    [7, 31], [8, 31], [9, 30], [10, 31], [11, 30], [12, 31],
  ])
  for (const month of schedule.months) {
    const maximum = maximumDay.get(month) ?? 0
    if ([...schedule.days].some(day => day <= maximum)) return true
  }
  return false
}

/** 解析单个逗号列表字段到匹配集。 */
function parseField(field: string, min: number, max: number, out: Set<number>): boolean {
  if (field === '*') {
    for (let value = min; value <= max; value++) out.add(value)
    return true
  }
  for (const part of field.split(',')) {
    if (part === '') return false
    const [range = '', stepRaw] = part.split('/')
    let low: number
    let high: number
    if (range === '*') {
      low = min
      high = max
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-')
      if (a === '' || b === '' || !isDigits(a) || !isDigits(b)) return false
      low = Number(a)
      high = Number(b)
    } else if (isDigits(range)) {
      low = Number(range)
      high = Number(range)
    } else {
      return false
    }
    if (low < min || high > max || low > high) return false
    const step = stepRaw === undefined ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN
    if (!Number.isInteger(step) || step < 1) return false
    for (let value = low; value <= high; value += step) out.add(value)
  }
  return true
}

/** 日/周 OR 语义：某一面受限即按该面闸门。 */
function matches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minutes.has(date.getMinutes())) return false
  if (!schedule.hours.has(date.getHours())) return false
  if (!schedule.months.has(date.getMonth() + 1)) return false
  return dayCandidate(schedule, date)
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value)
}
