import { Context } from 'koishi'
import { promises as fs } from 'fs'
import path from 'path'
import type { Config } from './config.js'
import type { ActivityAnalysis } from './llm.js'
import type { HourlyActivity, ReportMetrics } from './workreview.js'
import {
    escapeHtml,
    formatList,
    formatTags,
    renderTemplate
} from './utils.js'

export interface RenderData {
    deviceName: string
    date: string
    metrics: ReportMetrics
    analysis: ActivityAnalysis
}

export class ActivityRenderer {
    constructor(
        private ctx: Context,
        private config: Config
    ) {}

    async init(): Promise<void> {}

    async render(data: RenderData): Promise<Buffer> {
        const [template, css] = await Promise.all([
            fs.readFile(this.getResourcePath('template.html'), 'utf-8'),
            fs.readFile(this.getResourcePath('style.css'), 'utf-8')
        ])

        const html = renderTemplate(template, {
            inlineStyle: css,
            deviceName: escapeHtml(data.deviceName),
            date: escapeHtml(data.date),
            totalDuration: escapeHtml(data.metrics.totalDuration),
            screenshotCount: escapeHtml(data.metrics.screenshotCount),
            appCount: escapeHtml(data.metrics.appCount),
            websiteCount: escapeHtml(data.metrics.websiteCount),
            topApps: this.formatTopApps(data.metrics.topApps),
            activeHoursChart: this.generateActiveHoursChart(data.metrics.hourlyActivity),
            summary: escapeHtml(data.analysis.summary || data.analysis.rawText || '暂无分析'),
            efficiency: escapeHtml(data.analysis.efficiency || '暂无评估'),
            workPattern: escapeHtml(data.analysis.workPattern || '暂无分析'),
            focusAnalysis: escapeHtml(data.analysis.focusAnalysis || '暂无分析'),
            highlights: formatList(data.analysis.highlights),
            risks: formatList(data.analysis.risks),
            suggestions: formatList(data.analysis.suggestions),
            tags: formatTags(data.analysis.tags)
        })

        const page = await this.ctx.puppeteer.page()
        try {
            await page.setContent(html, { waitUntil: 'domcontentloaded' })
            await page.evaluate(() => document.fonts.ready)
            const element = await page.$('.container')
            if (!element) throw new Error('无法找到图片模板容器 .container')
            return (await element.screenshot({})) as Buffer
        } finally {
            await page.close().catch(() => undefined)
        }
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
