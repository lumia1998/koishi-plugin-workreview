import type { DeviceConfig } from './config'

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

export interface ReportMetrics {
    date: string
    totalDuration: string
    screenshotCount: string
    appCount: string
    websiteCount: string
    topApps: Array<{ name: string; duration: string }>
    activeLines: string[]
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
            const response = await fetch(this.buildUrl(device, path, withToken), {
                ...init,
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    ...(init.headers || {})
                }
            })

            const text = await response.text()
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`)
            }

            if (!text) return null
            return JSON.parse(text)
        } finally {
            clearTimeout(timer)
        }
    }

    private buildUrl(
        device: DeviceConfig,
        path: string,
        withToken: boolean
    ): string {
        const host = device.host.replace(/^https?:\/\//, '').replace(/\/$/, '')
        const hasPort = /:\d+$/.test(host)
        const port = hasPort ? '' : `:${device.port || 47831}`
        const url = new URL(`${device.protocol || 'http'}://${host}${port}${path}`)
        if (withToken && device.token) url.searchParams.set('token', device.token)
        return url.toString()
    }
}

export function truncateRawReport(content: string): string {
    const marker = '## 六、AI 分析'
    const index = content.indexOf(marker)
    return (index >= 0 ? content.slice(0, index) : content).trim()
}

export function extractReportMetrics(rawReport: string, fallbackDate: string): ReportMetrics {
    const date = matchFirst(rawReport, /\*\*日期[:：]\s*([^*]+)\*\*/) || fallbackDate
    const totalDuration = findMetric(rawReport, '总工作时长') || '未知'
    const screenshotCount = findMetric(rawReport, '截图数量') || '未知'
    const appCount = findMetric(rawReport, '使用应用数') || '未知'
    const websiteCount = findMetric(rawReport, '访问网站数') || '未知'
    const topApps = extractTopApps(rawReport)
    const activeLines = rawReport
        .split('\n')
        .map((line) => line.trim())
        .filter((line) =>
            /^-\s*(高峰时段|活跃小时数|主要活跃区间)[:：]/.test(line)
        )
        .map((line) => line.replace(/^[-\s]+/, ''))

    return {
        date: date.trim(),
        totalDuration,
        screenshotCount,
        appCount,
        websiteCount,
        topApps,
        activeLines
    }
}

function matchFirst(text: string, pattern: RegExp): string | null {
    return text.match(pattern)?.[1]?.trim() ?? null
}

function findMetric(rawReport: string, name: string): string | null {
    const pattern = new RegExp(`\\|\\s*${escapeRegExp(name)}\\s*\\|\\s*([^|]+)\\|`)
    return rawReport.match(pattern)?.[1]?.trim() ?? null
}

function extractTopApps(rawReport: string): Array<{ name: string; duration: string }> {
    const section = rawReport.match(/## 三、应用使用明细([\s\S]*?)(?:\n## |$)/)?.[1]
    if (!section) return []

    return section
        .split('\n')
        .map((line) => line.trim())
        .map((line) => line.match(/^\|\s*\d+\s*\|\s*([^|]+)\|\s*([^|]+)\|$/))
        .filter((match): match is RegExpMatchArray => !!match)
        .slice(0, 8)
        .map((match) => ({
            name: match[1].trim(),
            duration: match[2].trim()
        }))
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
