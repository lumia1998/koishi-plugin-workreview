import type { DeviceConfig } from './config.js'

export interface ReportResponse {
    date: string
    locale?: string
    content: string
    ai_mode?: string
    model_name?: string | null
    fallback_reason?: string
    created_at?: number
}

export interface ReportsResponse {
    dates: string[]
}

export interface HourlyActivity {
    hours: number[]
    maxSeconds: number
}

export interface HourlyAppBreakdown {
    hours: Array<Array<{ app: string; seconds: number }>>
    maxSeconds: number
}

export interface ReportMetrics {
    date: string
    totalDuration: string
    screenshotCount: string
    appCount: string
    websiteCount: string
    topApps: Array<{ name: string; duration: string }>
    activeLines: string[]
    hourlyActivity: HourlyActivity
    hourlyAppBreakdown: HourlyAppBreakdown
}

export class WorkReviewClient {
    constructor(private timeout: number) {}

    async health(device: DeviceConfig): Promise<unknown> {
        return this.get(device, '/health', false)
    }

    async deviceInfo(device: DeviceConfig): Promise<unknown> {
        return this.get(device, '/v1/device')
    }

    async listReports(device: DeviceConfig): Promise<ReportsResponse> {
        return this.get(device, '/v1/reports') as Promise<ReportsResponse>
    }

    async getReport(device: DeviceConfig, date: string): Promise<ReportResponse> {
        return this.get(device, `/v1/reports/${encodeURIComponent(date)}`) as Promise<ReportResponse>
    }

    async generateReport(
        device: DeviceConfig,
        date: string
    ): Promise<ReportResponse> {
        return this.request(device, '/v1/reports/generate', {
            method: 'POST',
            body: JSON.stringify({ date }),
            headers: { 'Content-Type': 'application/json' }
        }) as Promise<ReportResponse>
    }

    private async get(
        device: DeviceConfig,
        path: string,
        withToken = true
    ): Promise<unknown> {
        return this.request(device, path, { method: 'GET' }, withToken)
    }

    private async request(
        device: DeviceConfig,
        path: string,
        init: RequestInit,
        withToken = true
    ): Promise<unknown> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)

        try {
            const headers: Record<string, string> = {
                Accept: 'application/json',
                ...(init.headers as Record<string, string> || {})
            }
            if (withToken && device.token) {
                headers['Authorization'] = `Bearer ${device.token}`
            }

            const response = await fetch(this.buildUrl(device, path), {
                ...init,
                signal: controller.signal,
                headers
            })

            const text = await response.text()
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
            }

            if (!text) throw new Error('服务器返回了空响应')
            return JSON.parse(text)
        } finally {
            clearTimeout(timer)
        }
    }

    private buildUrl(
        device: DeviceConfig,
        path: string
    ): string {
        const protocol = device.protocol || 'http'
        const host = device.host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
        const hasPort = /:\d+$/.test(host)
        const base = `${protocol}://${host}${hasPort ? '' : `:${device.port || 47831}`}`
        const url = new URL(path, base)
        return url.toString()
    }
}

export function truncateRawReport(content: string): string {
    const marker = content.search(/\n#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.．]\s*)?AI\s*分析/i)
    return (marker >= 0 ? content.slice(0, marker) : content).trim()
}

export function extractReportMetrics(rawReport: string, fallbackDate: string): ReportMetrics {
    const date = extractDate(rawReport) || fallbackDate
    const totalDuration = findMetric(rawReport, '总工作时长') || '未知'
    const screenshotCount = findMetric(rawReport, '截图数量') || '未知'
    const appCount = findMetric(rawReport, '使用应用数') || findMetric(rawReport, '应用数量') || '未知'
    const websiteCount = findMetric(rawReport, '访问网站数') || findMetric(rawReport, '网站数量') || '未知'
    const topApps = extractTopApps(rawReport)
    const activeLines = rawReport
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /(高峰时段|活跃小时数|主要活跃区间)\s*[:：]/.test(line))
        .map((line) => line.replace(/^[-*\s]+/, ''))
    const hourlyActivity = extractHourlyActivity(rawReport)
    const hourlyAppBreakdown = extractHourlyAppBreakdown(rawReport)

    return {
        date: date.trim(),
        totalDuration,
        screenshotCount,
        appCount,
        websiteCount,
        topApps,
        activeLines,
        hourlyActivity,
        hourlyAppBreakdown
    }
}

export function aggregateReportMetrics(
    reports: Array<{ date: string; rawReport: string }>,
    dateRange: string
): ReportMetrics {
    const metrics = reports.map((report) => extractReportMetrics(report.rawReport, report.date))
    const totalSeconds = sumNumbers(metrics.map((item) => parseDuration(item.totalDuration)))
    const screenshotTotal = sumNumbers(metrics.map((item) => parseCount(item.screenshotCount)))
    const appTotal = sumNumbers(metrics.map((item) => parseCount(item.appCount)))
    const websiteTotal = sumNumbers(metrics.map((item) => parseCount(item.websiteCount)))
    const appDurations = new Map<string, number>()
    const hourly = new Array<number>(24).fill(0)
    const hourlyApps: Array<Map<string, number>> = Array.from({ length: 24 }, () => new Map())

    for (const metric of metrics) {
        for (const app of metric.topApps) {
            appDurations.set(app.name, (appDurations.get(app.name) || 0) + parseDuration(app.duration))
        }
        metric.hourlyActivity.hours.forEach((seconds, index) => {
            hourly[index] += seconds
        })
        metric.hourlyAppBreakdown.hours.forEach((entries, index) => {
            for (const entry of entries) {
                hourlyApps[index].set(entry.app, (hourlyApps[index].get(entry.app) || 0) + entry.seconds)
            }
        })
    }

    const topApps = [...appDurations]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, seconds]) => ({ name, duration: formatDuration(seconds) }))

    const activeLines = metrics
        .flatMap((metric) => metric.activeLines.map((line) => `${metric.date}: ${line}`))
        .slice(0, 12)

    return {
        date: dateRange,
        totalDuration: totalSeconds ? formatDuration(totalSeconds) : '未知',
        screenshotCount: screenshotTotal ? `${screenshotTotal} 张` : '未知',
        appCount: appTotal ? `累计 ${appTotal} 次` : '未知',
        websiteCount: websiteTotal ? `累计 ${websiteTotal} 次` : '未知',
        topApps,
        activeLines,
        hourlyActivity: {
            hours: hourly,
            maxSeconds: Math.max(...hourly, 0)
        },
        hourlyAppBreakdown: {
            hours: hourlyApps.map((m) => [...m].map(([app, seconds]) => ({ app, seconds }))),
            maxSeconds: Math.max(...hourlyApps.map((m) => [...m.values()].reduce((s, v) => s + v, 0)), 0)
        }
    }
}


function extractDate(rawReport: string): string | null {
    return (
        matchFirst(rawReport, /\*\*\s*日期\s*[:：]\s*([^*\n]+)\s*\*\*/) ||
        matchFirst(rawReport, /(?:^|\n)\s*日期\s*[:：]\s*([^\n]+)/) ||
        matchFirst(rawReport, /(\d{4}-\d{2}-\d{2})/)
    )
}

function matchFirst(text: string, pattern: RegExp): string | null {
    return text.match(pattern)?.[1]?.trim() ?? null
}

function findMetric(rawReport: string, name: string): string | null {
    const escaped = escapeRegExp(name)
    return (
        matchFirst(rawReport, new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*([^|\\n]+)\\|`)) ||
        matchFirst(rawReport, new RegExp(`(?:^|\\n)\\s*[-*]?\\s*${escaped}\\s*[:：]\\s*([^\\n]+)`)) ||
        matchFirst(rawReport, new RegExp(`\\*\\*\\s*${escaped}\\s*[:：]\\s*([^*\\n]+)\\s*\\*\\*`))
    )
}

function extractTopApps(rawReport: string): Array<{ name: string; duration: string }> {
    const section = findSection(rawReport, /(应用|App).*(明细|排行|使用)/i)
    if (!section) return []

    const apps = section
        .split('\n')
        .map((line) => parseAppTableLine(line) || parseAppListLine(line))
        .filter((app): app is { name: string; duration: string } => !!app)

    return apps.slice(0, 8)
}

function findSection(rawReport: string, titlePattern: RegExp): string | null {
    const sections = rawReport.split(/\n(?=#{1,6}\s+)/)
    return sections.find((section) => titlePattern.test(section.split('\n')[0] || '')) ?? null
}

function parseAppTableLine(line: string): { name: string; duration: string } | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
    const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
    if (cells.some((cell) => /^:?-{2,}:?$/.test(cell))) return null
    if (/序号|应用|时长|名称/.test(cells.join(' '))) return null

    if (/^\d+$/.test(cells[0] || '') && cells.length >= 3) {
        return cells[1] && cells[2] ? { name: cells[1], duration: cells[2] } : null
    }
    if (cells.length >= 2 && looksLikeDuration(cells.at(-1) || '')) {
        const name = cells.slice(0, -1).join(' ').trim()
        return name ? { name, duration: cells.at(-1) || '' } : null
    }
    return null
}

function parseAppListLine(line: string): { name: string; duration: string } | null {
    const match = line.match(/^\s*[-*]?\s*(?:\d+[.)、]\s*)?(.+?)\s*[:：|]\s*([^|\n]+)$/)
    if (!match || !looksLikeDuration(match[2])) return null
    return { name: match[1].trim(), duration: match[2].trim() }
}

function extractHourlyActivity(rawReport: string): HourlyActivity {
    const hours = new Array<number>(24).fill(0)
    const bucketPattern = /(\d{1,2}):\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*[（(]([^）)]+)[）)]/g
    let match: RegExpExecArray | null

    while ((match = bucketPattern.exec(rawReport)) !== null) {
        const hour = parseInt(match[1], 10)
        if (hour >= 0 && hour < 24) {
            hours[hour] += parseDuration(match[2])
        }
    }

    return { hours, maxSeconds: Math.max(...hours, 0) }
}

function extractHourlyAppBreakdown(rawReport: string): HourlyAppBreakdown {
    const hours: Array<Array<{ app: string; seconds: number }>> = Array.from({ length: 24 }, () => [])

    // Pattern 1: "09:15 - 09:45 AppName（30分）" or "09:15-09:45 AppName (30分钟)"
    const entryPattern = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s+(.+?)\s*[（(]([^）)]+)[）)]/g
    let match: RegExpExecArray | null
    let found = false

    while ((match = entryPattern.exec(rawReport)) !== null) {
        const startHour = parseInt(match[1], 10)
        const startMin = parseInt(match[2], 10)
        const endHour = parseInt(match[3], 10)
        const endMin = parseInt(match[4], 10)
        const appName = match[5].trim()
        const durationText = match[6]

        if (startHour < 0 || startHour > 23) continue
        if (/^\d+$/.test(appName) || /总|合计|小计/.test(appName)) continue

        const seconds = parseDuration(durationText)
        if (seconds <= 0) continue
        found = true

        if (startHour === endHour || (endHour === startHour + 1 && endMin === 0)) {
            addToHour(hours, startHour, appName, seconds)
        } else {
            const totalMinutes = (endHour * 60 + endMin) - (startHour * 60 + startMin)
            if (totalMinutes <= 0) {
                addToHour(hours, startHour, appName, seconds)
                continue
            }
            const firstHourMinutes = 60 - startMin
            const lastHourMinutes = endMin
            for (let h = startHour; h <= Math.min(endHour, 23); h++) {
                let fraction: number
                if (h === startHour) fraction = firstHourMinutes / totalMinutes
                else if (h === endHour) fraction = lastHourMinutes / totalMinutes
                else fraction = 60 / totalMinutes
                addToHour(hours, h, appName, Math.round(seconds * fraction))
            }
        }
    }

    // Pattern 2: table format "| 09:15 - 09:45 | AppName | 30分 |"
    if (!found) {
        const tablePattern = /\|\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/g
        while ((match = tablePattern.exec(rawReport)) !== null) {
            const startHour = parseInt(match[1], 10)
            const appName = match[5].trim()
            const durationText = match[6].trim()

            if (startHour < 0 || startHour > 23) continue
            if (/序号|时间|应用|时长/.test(appName)) continue

            const seconds = parseDuration(durationText)
            if (seconds <= 0) continue
            found = true
            addToHour(hours, startHour, appName, seconds)
        }
    }

    const maxSeconds = Math.max(
        ...hours.map((entries) => entries.reduce((sum, e) => sum + e.seconds, 0)),
        0
    )
    return { hours, maxSeconds }
}

function addToHour(
    hours: Array<Array<{ app: string; seconds: number }>>,
    hour: number,
    app: string,
    seconds: number
): void {
    if (hour < 0 || hour > 23 || seconds <= 0) return
    const existing = hours[hour].find((e) => e.app === app)
    if (existing) existing.seconds += seconds
    else hours[hour].push({ app, seconds })
}

function looksLikeDuration(text: string): boolean {
    return /(\d+\s*(小时|时|分|秒|h|m|s))|未知/i.test(text)
}

function parseCount(text: string): number {
    return Number(text.match(/\d+/)?.[0] || 0)
}

function parseDuration(text: string): number {
    const h = parseInt(text.match(/(\d+)\s*(?:小时|时|h)/i)?.[1] ?? '0', 10)
    const m = parseInt(text.match(/(\d+)\s*(?:分钟|分|m)/i)?.[1] ?? '0', 10)
    const s = parseInt(text.match(/(\d+)\s*(?:秒|s)/i)?.[1] ?? '0', 10)
    return h * 3600 + m * 60 + s
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    const parts: string[] = []
    if (h) parts.push(`${h}小时`)
    if (m) parts.push(`${m}分`)
    if (s || !parts.length) parts.push(`${s}秒`)
    return parts.join('')
}

function sumNumbers(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0)
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
