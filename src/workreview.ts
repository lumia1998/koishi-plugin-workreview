import type { DeviceConfig } from './config.js'

// API 原始响应
export interface TimelineActivity {
    id: number
    timestamp: number
    app_name: string
    window_title: string
    screenshot_path: string
    ocr_text: string | null
    category: string
    duration: number
    browser_url: string | null
    executable_path: string
    semantic_category: string
    semantic_confidence: number
}

// 处理后的时间线条目
export interface TimelineEntry {
    startTime: string
    endTime: string
    duration: number
    app: string
    window: string
    category: string
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
    screenshotCount: number
    appCount: number
    topApps: Array<{ name: string; duration: string }>
    hourlyActivity: HourlyActivity
    hourlyAppBreakdown: HourlyAppBreakdown
    categoryBreakdown: Array<{ category: string; seconds: number }>
}

export class WorkReviewClient {
    constructor(private timeout: number) {}

    async getTimeline(device: DeviceConfig, date: string): Promise<TimelineActivity[]> {
        const path = `/v1/timeline/${encodeURIComponent(date)}`
        return this.get(device, path) as Promise<TimelineActivity[]>
    }

    private async get(device: DeviceConfig, path: string): Promise<unknown> {
        return this.request(device, path, { method: 'GET' })
    }

    private async request(
        device: DeviceConfig,
        path: string,
        init: RequestInit
    ): Promise<unknown> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)

        try {
            const url = this.buildUrl(device, path)
            const response = await fetch(url, {
                ...init,
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    ...(init.headers as Record<string, string> || {})
                }
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

    private buildUrl(device: DeviceConfig, path: string): string {
        const protocol = device.protocol || 'http'
        const host = device.host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
        const hasPort = /:\d+$/.test(host)
        const base = `${protocol}://${host}${hasPort ? '' : `:${device.port || 47831}`}`
        const url = new URL(path, base)

        // 使用 query param 方式传递 token
        if (device.token) {
            url.searchParams.set('token', device.token)
        }

        return url.toString()
    }
}

// 将 Unix 时间戳转换为北京时间字符串 HH:MM
function formatBeijingTime(timestamp: number): string {
    const date = new Date((timestamp + 8 * 3600) * 1000)
    const hours = String(date.getUTCHours()).padStart(2, '0')
    const minutes = String(date.getUTCMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
}

// 格式化时长（秒 -> "X小时Y分Z秒"）
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

// 将 API 原始数据转换为时间线条目
export function convertToTimelineEntries(activities: TimelineActivity[]): TimelineEntry[] {
    return activities.map(activity => ({
        startTime: formatBeijingTime(activity.timestamp),
        endTime: formatBeijingTime(activity.timestamp + activity.duration),
        duration: activity.duration,
        app: activity.app_name,
        window: activity.window_title,
        category: activity.semantic_category
    }))
}

// 从时间线构建每小时活跃数据
export function buildHourlyDataFromTimeline(timeline: TimelineEntry[]): {
    hourlyActivity: HourlyActivity
    hourlyAppBreakdown: HourlyAppBreakdown
    maxSeconds: number
} {
    const hourlySeconds = Array(24).fill(0)
    const hourlyApps: Map<string, number>[] = Array.from({ length: 24 }, () => new Map())

    for (const entry of timeline) {
        const [startH, startM] = entry.startTime.split(':').map(Number)
        const [endH, endM] = entry.endTime.split(':').map(Number)

        const totalSeconds = entry.duration
        const totalMinutes = totalSeconds / 60

        // 计算跨越的小时范围
        let currentHour = startH
        let remainingMinutes = totalMinutes

        while (remainingMinutes > 0 && currentHour <= 23) {
            let minutesInThisHour: number

            if (currentHour === startH) {
                // 第一个小时：从 startM 到 60
                minutesInThisHour = Math.min(60 - startM, remainingMinutes)
            } else if (currentHour === endH) {
                // 最后一个小时：从 0 到 endM
                minutesInThisHour = Math.min(endM, remainingMinutes)
            } else {
                // 中间小时：完整 60 分钟
                minutesInThisHour = Math.min(60, remainingMinutes)
            }

            const secondsInThisHour = Math.round(minutesInThisHour * 60)
            hourlySeconds[currentHour] += secondsInThisHour

            const existing = hourlyApps[currentHour].get(entry.app) || 0
            hourlyApps[currentHour].set(entry.app, existing + secondsInThisHour)

            remainingMinutes -= minutesInThisHour
            currentHour++
        }
    }

    // 防止某个小时超过 3600 秒
    for (let i = 0; i < 24; i++) {
        hourlySeconds[i] = Math.min(hourlySeconds[i], 3600)
    }

    const maxSeconds = Math.max(...hourlySeconds, 0)

    return {
        hourlyActivity: {
            hours: hourlySeconds,
            maxSeconds
        },
        hourlyAppBreakdown: {
            hours: hourlyApps.map((appMap) =>
                [...appMap.entries()]
                    .map(([app, seconds]) => ({ app, seconds }))
                    .sort((a, b) => b.seconds - a.seconds)
            ),
            maxSeconds
        },
        maxSeconds
    }
}

// 提取报告指标
export function extractReportMetrics(
    activities: TimelineActivity[],
    date: string
): ReportMetrics {
    if (activities.length === 0) {
        return {
            date,
            totalDuration: '0秒',
            screenshotCount: 0,
            appCount: 0,
            topApps: [],
            hourlyActivity: { hours: Array(24).fill(0), maxSeconds: 0 },
            hourlyAppBreakdown: { hours: Array(24).fill(0).map(() => []), maxSeconds: 0 },
            categoryBreakdown: []
        }
    }

    const timeline = convertToTimelineEntries(activities)
    const hourlyData = buildHourlyDataFromTimeline(timeline)

    // 计算总时长
    const totalSeconds = activities.reduce((sum, a) => sum + a.duration, 0)
    const totalDuration = formatDuration(totalSeconds)

    // 统计应用使用时长
    const appDurations = new Map<string, number>()
    for (const activity of activities) {
        const existing = appDurations.get(activity.app_name) || 0
        appDurations.set(activity.app_name, existing + activity.duration)
    }

    // Top 应用排行
    const topApps = [...appDurations.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, seconds]) => ({
            name,
            duration: formatDuration(seconds)
        }))

    // 分类时长统计
    const categoryDurations = new Map<string, number>()
    for (const activity of activities) {
        const category = activity.semantic_category || '其他'
        const existing = categoryDurations.get(category) || 0
        categoryDurations.set(category, existing + activity.duration)
    }
    const categoryBreakdown = [...categoryDurations.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, seconds]) => ({ category, seconds }))

    return {
        date,
        totalDuration,
        screenshotCount: activities.length,
        appCount: appDurations.size,
        topApps,
        hourlyActivity: hourlyData.hourlyActivity,
        hourlyAppBreakdown: hourlyData.hourlyAppBreakdown,
        categoryBreakdown
    }
}

// 聚合多天数据（用于周报）
export function aggregateReportMetrics(metrics: ReportMetrics[]): ReportMetrics {
    if (metrics.length === 0) {
        throw new Error('没有可聚合的数据')
    }

    const allApps = new Map<string, number>()
    const allCategories = new Map<string, number>()
    let totalSeconds = 0
    let totalScreenshots = 0
    const allAppNames = new Set<string>()

    for (const metric of metrics) {
        // 解析总时长
        const durationMatch = metric.totalDuration.match(/(\d+)小时|(\d+)分|(\d+)秒/g)
        if (durationMatch) {
            let seconds = 0
            for (const part of durationMatch) {
                if (part.includes('小时')) seconds += parseInt(part) * 3600
                else if (part.includes('分')) seconds += parseInt(part) * 60
                else if (part.includes('秒')) seconds += parseInt(part)
            }
            totalSeconds += seconds
        }

        totalScreenshots += metric.screenshotCount

        // 聚合应用时长
        for (const app of metric.topApps) {
            const durationMatch = app.duration.match(/(\d+)小时|(\d+)分|(\d+)秒/g)
            if (durationMatch) {
                let seconds = 0
                for (const part of durationMatch) {
                    if (part.includes('小时')) seconds += parseInt(part) * 3600
                    else if (part.includes('分')) seconds += parseInt(part) * 60
                    else if (part.includes('秒')) seconds += parseInt(part)
                }
                const existing = allApps.get(app.name) || 0
                allApps.set(app.name, existing + seconds)
            }
            allAppNames.add(app.name)
        }

        // 聚合分类时长
        for (const { category, seconds } of metric.categoryBreakdown) {
            const existing = allCategories.get(category) || 0
            allCategories.set(category, existing + seconds)
        }
    }

    // 聚合每小时数据
    const hourlySeconds = Array(24).fill(0)
    const hourlyApps: Map<string, number>[] = Array.from({ length: 24 }, () => new Map())

    for (const metric of metrics) {
        for (let h = 0; h < 24; h++) {
            hourlySeconds[h] += metric.hourlyActivity.hours[h]
            for (const { app, seconds } of metric.hourlyAppBreakdown.hours[h]) {
                const existing = hourlyApps[h].get(app) || 0
                hourlyApps[h].set(app, existing + seconds)
            }
        }
    }

    const maxSeconds = Math.max(...hourlySeconds, 0)

    const topApps = [...allApps.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, seconds]) => ({
            name,
            duration: formatDuration(seconds)
        }))

    const startDate = metrics[0].date
    const endDate = metrics[metrics.length - 1].date

    return {
        date: `${startDate} ~ ${endDate}`,
        totalDuration: formatDuration(totalSeconds),
        screenshotCount: totalScreenshots,
        appCount: allAppNames.size,
        topApps,
        hourlyActivity: {
            hours: hourlySeconds,
            maxSeconds
        },
        hourlyAppBreakdown: {
            hours: hourlyApps.map((appMap) =>
                [...appMap.entries()]
                    .map(([app, seconds]) => ({ app, seconds }))
                    .sort((a, b) => b.seconds - a.seconds)
            ),
            maxSeconds
        },
        categoryBreakdown: [...allCategories.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([category, seconds]) => ({ category, seconds }))
    }
}
