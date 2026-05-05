import { Context } from 'koishi'
import { promises as fs } from 'fs'
import path from 'path'
import type { Config } from './config.js'
import type { ActivityAnalysis } from './llm.js'
import type { HourlyActivity, ReportMetrics } from './workreview.js'
import {
    escapeHtml,
    renderTemplate
} from './utils.js'

export interface RenderData {
    deviceName: string
    date: string
    metrics: ReportMetrics
    analysis: ActivityAnalysis
    summaryTitle: string
}

export class ActivityRenderer {
    private template: string | null = null
    private css: string | null = null

    constructor(
        private ctx: Context,
        private config: Config
    ) {}

    async init(): Promise<void> {
        await this.loadResources()
    }

    async render(data: RenderData): Promise<Buffer> {
        const [template, css] = await this.loadResources()
        const html = renderTemplate(template, {
            inlineStyle: this.applyTheme(css),
            deviceName: escapeHtml(data.deviceName),
            date: escapeHtml(data.date),
            totalDuration: escapeHtml(data.metrics.totalDuration),
            screenshotCount: escapeHtml(data.metrics.screenshotCount),
            appCount: escapeHtml(data.metrics.appCount),
            websiteCount: escapeHtml(data.metrics.websiteCount),
            topApps: this.formatTopApps(data.metrics.topApps),
            activeHoursChart: this.generateActiveHoursChart(data.metrics.hourlyActivity),
            summaryTitle: escapeHtml(data.summaryTitle),
            summary: escapeHtml(data.analysis.text || '暂无分析')
        })

        const page = await this.ctx.puppeteer.page()
        try {
            await page.setContent(html, { waitUntil: 'domcontentloaded' })
            await Promise.race([
                page.evaluate(() => document.fonts.ready),
                new Promise((resolve) => setTimeout(resolve, 5000))
            ])
            const element = await page.$('.container')
            if (!element) throw new Error('无法找到图片模板容器 .container')
            return (await element.screenshot({})) as Buffer
        } finally {
            await page.close().catch(() => undefined)
        }
    }

    private async loadResources(): Promise<[string, string]> {
        if (this.template && this.css) return [this.template, this.css]
        const [template, css] = await Promise.all([
            fs.readFile(this.getResourcePath('template.html'), 'utf-8'),
            fs.readFile(this.getResourcePath('style.css'), 'utf-8')
        ])
        this.template = template
        this.css = css
        return [template, css]
    }

    private applyTheme(css: string): string {
        const darkTheme = ':root { --bg-paper: #1f1b24; --ink-primary: #f3e8ff; --ink-secondary: #d6c2e8; } body { background-color: var(--bg-paper); } .container, .title-sticker, .stamp, .app-ranking, .chart-section, .summary-note, .analysis-card { background: #2a2433; } .summary-note { box-shadow: 4px 4px 5px rgba(0, 0, 0, 0.35); }'
        if (this.config.theme === 'dark') return `${css}\n${darkTheme}`
        if (this.config.theme === 'auto') return `${css}\n@media (prefers-color-scheme: dark) { ${darkTheme} }`
        return css
    }

    private formatTopApps(apps: ReportMetrics['topApps']): string {
        if (!apps.length) return '<div class="empty">暂无应用数据</div>'
        return apps
            .map(
                (app, index) => `
                <div class="app-item">
                    <span class="app-rank">${index + 1}</span>
                    <span class="app-name">${escapeHtml(app.name)}</span>
                    <span class="app-duration">${escapeHtml(app.duration)}</span>
                </div>`
            )
            .join('')
    }

    private generateActiveHoursChart(activity: HourlyActivity): string {
        const { hours, maxSeconds } = activity
        if (maxSeconds === 0) {
            return '<div class="empty">暂无活跃数据</div>'
        }

        const items = hours.map((seconds, i) => {
            const percentage = maxSeconds > 0 ? (seconds / maxSeconds) * 100 : 0
            let color = 'var(--color-purple)'
            let height = `max(4px, ${percentage}%)`

            if (seconds === 0) {
                height = '0px'
            } else if (percentage >= 70) {
                color = 'var(--accent-orange)'
            } else if (percentage >= 30) {
                color = 'var(--color-green)'
            } else {
                color = 'var(--color-blue)'
            }

            const label = String(i).padStart(2, '0')
            const minutes = Math.round(seconds / 60)
            const showValue = seconds > 0 ? 'show-value' : ''

            return `
                <div class="chart-column ${showValue}" title="${label}:00 - ${minutes}分钟">
                    <div class="bar-value-top">${minutes > 0 ? minutes + 'm' : ''}</div>
                    <div class="bar-vertical" style="height: ${height}; background-color: ${color};"></div>
                    <div class="bar-label-x">${label}</div>
                </div>`
        })

        return `<div class="chart-container-horizontal">${items.join('')}</div>`
    }

    private getResourcePath(filename: string): string {
        return path.resolve(__dirname, '../resources', filename)
    }
}
