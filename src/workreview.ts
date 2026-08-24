import type { DeviceConfig } from './config.js'

// API 原始响应
export interface TimelineActivity {
    id: number
    timestamp: number
    app_name: string
    window_title: string
    screenshot_path: string
    screenshot_url?: string
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
    totalSeconds: number
    totalDuration: string
    screenshotCount: number
    appCount: number
    topApps: Array<{ name: string; duration: string }>
    appBreakdown: Array<{ name: string; seconds: number; duration: string }>
    hourlyActivity: HourlyActivity
    hourlyAppBreakdown: HourlyAppBreakdown
    categoryBreakdown: Array<{ category: string; seconds: number }>
    topBrowserSites: BrowserSite[]
}

export interface BrowserSite {
    domain: string
    seconds: number
    duration: string
    titles: string[]
}

export interface ScreenSnapshot {
    screenshotUrl: string
    ocrText: string | null
    appName: string
    windowTitle: string
    category: string
    timestamp: number
}

export interface CurrentScreenshotSnapshot extends ScreenSnapshot {
    sensitive: boolean
    sensitiveReason: string | null
}

const SENSITIVE_TEXT_MARKERS = ['内容已脱敏', '密码信息', '敏感词', '域名黑名单', '完全忽略', '内容过滤']

export interface CaptureScreenshotResult {
    capturedAt: number
    width: number
    height: number
    mimeType: string
    imageBase64: string
}

export function screenshotToDataUrl(result: CaptureScreenshotResult): string {
    const mime = result.mimeType || 'image/jpeg'
    return `data:${mime};base64,${result.imageBase64}`
}

export function screenshotToBuffer(result: CaptureScreenshotResult): Buffer {
    return Buffer.from(result.imageBase64, 'base64')
}

export class WorkReviewClient {
    constructor(private timeout: number) {}

    async captureScreenshot(device: DeviceConfig): Promise<CaptureScreenshotResult> {
        const path = '/v1/screenshots/capture'
        return this.request(device, path, { method: 'POST' }) as Promise<CaptureScreenshotResult>
    }

    async getTimeline(device: DeviceConfig, date: string): Promise<TimelineActivity[]> {
        const path = `/v1/timeline/${encodeURIComponent(date)}`
        return this.get(device, path) as Promise<TimelineActivity[]>
    }

    async downloadBinary(url: string): Promise<Buffer> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeout)
        try {
            const data = await this.requestUrl(url, { method: 'GET' }, false, controller.signal)
            return Buffer.from(data as ArrayBuffer)
        } finally {
            clearTimeout(timer)
        }
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
            const headers: Record<string, string> = {
                ...(init.headers as Record<string, string> || {}),
            }
            if (device.token) {
                headers['Authorization'] = `Bearer ${device.token}`
            }
            if (init.method === 'POST' && !headers['Content-Type']) {
                headers['Content-Type'] = 'application/json'
            }
            return this.requestUrl(url, { ...init, headers }, true, controller.signal)
        } finally {
            clearTimeout(timer)
        }
    }

    private async requestUrl(
        url: string,
        init: RequestInit,
        parseJson: boolean,
        signal?: AbortSignal
    ): Promise<unknown> {
        const response = await fetch(url, {
            ...init,
            signal,
            headers: {
                Accept: parseJson ? 'application/json' : '*/*',
                ...(init.headers as Record<string, string> || {})
            }
        })

        const text = parseJson || !response.ok ? await response.text() : ''
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
            }

        if (!parseJson) return response.arrayBuffer()
        if (!text) throw new Error('服务器返回了空响应')
        return JSON.parse(text)
    }

    private buildUrl(device: DeviceConfig, path: string): string {
        const protocol = device.protocol || 'http'
        const host = device.host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
        const hasPort = /:\d+$/.test(host)
        const base = `${protocol}://${host}${hasPort ? '' : `:${device.port || 47831}`}`
        const url = new URL(path, base)
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
            totalSeconds: 0,
            totalDuration: '0秒',
            screenshotCount: 0,
            appCount: 0,
            topApps: [],
            appBreakdown: [],
            hourlyActivity: { hours: Array(24).fill(0), maxSeconds: 0 },
            hourlyAppBreakdown: { hours: Array(24).fill(0).map(() => []), maxSeconds: 0 },
            categoryBreakdown: [],
            topBrowserSites: []
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

    const appBreakdown = [...appDurations.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, seconds]) => ({
            name,
            seconds,
            duration: formatDuration(seconds)
        }))
    const topApps = appBreakdown.slice(0, 8).map(({ name, duration }) => ({ name, duration }))

    // 分类时长统计（使用 category 字段，映射为中文）
    const categoryDurations = new Map<string, number>()
    for (const activity of activities) {
        const category = mapCategoryName(activity.category)
        const existing = categoryDurations.get(category) || 0
        categoryDurations.set(category, existing + activity.duration)
    }
    const categoryBreakdown = [...categoryDurations.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, seconds]) => ({ category, seconds }))

    // 浏览器访问统计
    const topBrowserSites = extractBrowserSites(activities)

    return {
        date,
        totalSeconds,
        totalDuration,
        screenshotCount: activities.length,
        appCount: appDurations.size,
        topApps,
        appBreakdown,
        hourlyActivity: hourlyData.hourlyActivity,
        hourlyAppBreakdown: hourlyData.hourlyAppBreakdown,
        categoryBreakdown,
        topBrowserSites
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
        totalSeconds += metric.totalSeconds

        totalScreenshots += metric.screenshotCount

        // 聚合应用时长
        for (const app of metric.appBreakdown) {
            const existing = allApps.get(app.name) || 0
            allApps.set(app.name, existing + app.seconds)
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

    const appBreakdown = [...allApps.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, seconds]) => ({
            name,
            seconds,
            duration: formatDuration(seconds)
        }))
    const topApps = appBreakdown.slice(0, 8).map(({ name, duration }) => ({ name, duration }))

    const startDate = metrics[0].date
    const endDate = metrics[metrics.length - 1].date

    return {
        totalSeconds,
        date: `${startDate} ~ ${endDate}`,
        totalDuration: formatDuration(totalSeconds),
        screenshotCount: totalScreenshots,
        appCount: allAppNames.size,
        appBreakdown,
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
            .map(([category, seconds]) => ({ category, seconds })),
        topBrowserSites: aggregateBrowserSites(metrics)
    }
}

function aggregateBrowserSites(metrics: ReportMetrics[]): BrowserSite[] {
    const siteMap = new Map<string, { seconds: number; titles: Set<string> }>()
    for (const metric of metrics) {
        for (const site of metric.topBrowserSites) {
            const existing = siteMap.get(site.domain) || { seconds: 0, titles: new Set() }
            existing.seconds += site.seconds
            for (const title of site.titles) existing.titles.add(title)
            siteMap.set(site.domain, existing)
        }
    }
    return [...siteMap.entries()]
        .filter(([, data]) => data.seconds >= 300)
        .sort((a, b) => b[1].seconds - a[1].seconds)
        .slice(0, 5)
        .map(([domain, data]) => ({
            domain,
            seconds: data.seconds,
            duration: formatDuration(data.seconds),
            titles: [...data.titles].slice(0, 3)
        }))
}

const CATEGORY_NAME_MAP: Record<string, string> = {
    entertainment: '娱乐摸鱼',
    communication: '通讯协作',
    browser: '浏览器',
    development: '开发工具',
    office: '办公软件',
    design: '设计工具',
    system: '系统工具',
    other: '其他'
}

function mapCategoryName(raw: string): string {
    if (!raw) return '其他'
    const lower = raw.toLowerCase()
    if (CATEGORY_NAME_MAP[lower]) return CATEGORY_NAME_MAP[lower]
    if (lower.startsWith('cat-')) return '其他'
    return raw
}

function extractBrowserSites(activities: TimelineActivity[]): BrowserSite[] {
    const siteMap = new Map<string, { seconds: number; titles: Set<string> }>()

    const browserApps = new Set<string>()
    for (const activity of activities) {
        if (isRedactedActivity(activity)) continue
        if (activity.browser_url) {
            browserApps.add(activity.app_name)
        }
    }

    for (const activity of activities) {
        if (isRedactedActivity(activity)) continue
        let domain: string | null = null
        let title = activity.window_title || ''

        if (activity.browser_url) {
            domain = extractDomain(activity.browser_url)
        } else if (browserApps.has(activity.app_name) || isBrowserApp(activity.app_name)) {
            domain = extractDomainFromTitle(title, activity.app_name)
        }

        if (!domain) continue

        const existing = siteMap.get(domain) || { seconds: 0, titles: new Set() }
        existing.seconds += activity.duration
        const cleanTitle = stripBrowserSuffix(title, activity.app_name)
        if (cleanTitle && cleanTitle !== domain) {
            existing.titles.add(cleanTitle)
        }
        siteMap.set(domain, existing)
    }

    return [...siteMap.entries()]
        .filter(([, data]) => data.seconds >= 300)
        .sort((a, b) => b[1].seconds - a[1].seconds)
        .slice(0, 5)
        .map(([domain, data]) => ({
            domain,
            seconds: data.seconds,
            duration: formatDuration(data.seconds),
            titles: [...data.titles].slice(0, 3)
        }))
}

const BROWSER_NAMES = ['chrome', 'firefox', 'edge', 'centbrowser', 'cent browser', 'brave', 'opera', 'vivaldi', 'safari', 'arc']

function isBrowserApp(appName: string): boolean {
    const lower = appName.toLowerCase()
    return BROWSER_NAMES.some(b => lower.includes(b))
}

function stripBrowserSuffix(title: string, appName: string): string {
    const suffixes = [
        ` - ${appName}`,
        ` — ${appName}`,
        ...BROWSER_NAMES.map(b => ` - ${b}`),
        ...BROWSER_NAMES.map(b => ` — ${b}`)
    ]
    let result = title
    for (const suffix of suffixes) {
        const idx = result.toLowerCase().lastIndexOf(suffix.toLowerCase())
        if (idx > 0) {
            result = result.substring(0, idx)
            break
        }
    }
    return result.trim()
}

const TITLE_DOMAIN_MAP: Record<string, string> = {
    '哔哩哔哩': 'bilibili.com',
    'bilibili': 'bilibili.com',
    'github': 'github.com',
    'youtube': 'youtube.com',
    'google': 'google.com',
    'stackoverflow': 'stackoverflow.com',
    'stack overflow': 'stackoverflow.com',
    'reddit': 'reddit.com',
    'twitter': 'twitter.com',
    'outlook': 'outlook.com',
    '腾讯文档': 'docs.qq.com',
    '飞书': 'feishu.cn',
    '知乎': 'zhihu.com',
    '掘金': 'juejin.cn',
    'csdn': 'csdn.net',
    '百度': 'baidu.com',
    'notion': 'notion.so',
    'chatgpt': 'chatgpt.com',
    'claude': 'claude.ai',
    'npm': 'npmjs.com',
    'docker': 'docker.com',
}

function extractDomainFromTitle(title: string, appName: string): string | null {
    const cleanTitle = stripBrowserSuffix(title, appName).toLowerCase()
    if (!cleanTitle || cleanTitle === '新标签页' || cleanTitle === '无标题' || cleanTitle === 'new tab') {
        return null
    }

    for (const [keyword, domain] of Object.entries(TITLE_DOMAIN_MAP)) {
        if (cleanTitle.includes(keyword.toLowerCase())) {
            return domain
        }
    }

    return cleanTitle.split(/\s*[-|–—]\s*/)[0].trim().substring(0, 30) || null
}

export function findLatestScreenSnapshot(activities: TimelineActivity[]): ScreenSnapshot | null {
    const activity = activities
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .find((item) => item.screenshot_url && !isRedactedActivity(item))

    if (!activity?.screenshot_url) return null
    return {
        screenshotUrl: activity.screenshot_url,
        ocrText: activity.ocr_text,
        appName: activity.app_name,
        windowTitle: activity.window_title,
        category: activity.semantic_category || activity.category,
        timestamp: activity.timestamp
    }
}

export function findCurrentScreenshotSnapshot(activities: TimelineActivity[]): CurrentScreenshotSnapshot | null {
    const activity = activities
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)[0]

    if (!activity) return null
    const sensitiveReason = getSensitiveReason(activity)
    if (!activity.screenshot_url) {
        return {
            screenshotUrl: '',
            ocrText: activity.ocr_text,
            appName: activity.app_name,
            windowTitle: activity.window_title,
            category: activity.semantic_category || activity.category,
            timestamp: activity.timestamp,
            sensitive: true,
            sensitiveReason: sensitiveReason || '当前活动没有可发送截图'
        }
    }

    return {
        screenshotUrl: activity.screenshot_url,
        ocrText: activity.ocr_text,
        appName: activity.app_name,
        windowTitle: activity.window_title,
        category: activity.semantic_category || activity.category,
        timestamp: activity.timestamp,
        sensitive: !!sensitiveReason,
        sensitiveReason
    }
}

function getSensitiveReason(activity: TimelineActivity): string | null {
    if ((activity.category || '').toLowerCase().startsWith('cat-')) return '命中 Work_Review 隐私分类'
    if (isRedactedActivity(activity)) return '内容已脱敏'
    if (SENSITIVE_TEXT_MARKERS.some((marker) => activity.ocr_text?.includes(marker))) return '命中隐私过滤关键词'
    return null
}

function isRedactedActivity(activity: TimelineActivity): boolean {
    return [activity.window_title, activity.ocr_text, activity.browser_url].some(
        value => typeof value === 'string' && value.includes('内容已脱敏')
    )
}

function extractDomain(url: string): string | null {
    try {
        const hostname = new URL(url).hostname
        return hostname.replace(/^www\./, '')
    } catch {
        return null
    }
}
