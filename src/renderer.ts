import { Context } from 'koishi'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Config } from './config.js'
import type { ActivityAnalysis } from './llm.js'
import type { ReportMetrics } from './workreview.js'
import {
    escapeHtml,
    formatList,
    formatTags,
    markdownToHtml,
    renderTemplate
} from './utils.js'

export interface RenderData {
    deviceName: string
    date: string
    metrics: ReportMetrics
    rawReport: string
    analysis: ActivityAnalysis
}

export class ActivityRenderer {
    private templateDir: string

    constructor(
        private ctx: Context,
        private config: Config
    ) {
        this.templateDir = path.resolve(ctx.baseDir, 'data/workreview')
    }

    async init(): Promise<void> {
        await fs.mkdir(this.templateDir, { recursive: true })
        await fs.copyFile(this.getResourcePath('style.css'), this.getStylePath())
    }

    async render(data: RenderData): Promise<Buffer> {
        await this.init()

        const template = await fs.readFile(this.getResourcePath('template.html'), 'utf-8')
        const html = renderTemplate(template, {
            stylePath: './style.css',
            theme: this.resolveTheme(),
            deviceName: escapeHtml(data.deviceName),
            date: escapeHtml(data.date),
            totalDuration: escapeHtml(data.metrics.totalDuration),
            screenshotCount: escapeHtml(data.metrics.screenshotCount),
            appCount: escapeHtml(data.metrics.appCount),
            websiteCount: escapeHtml(data.metrics.websiteCount),
            topApps: this.formatTopApps(data.metrics.topApps),
            activeLines: formatList(data.metrics.activeLines),
            rawReport: markdownToHtml(data.rawReport),
            summary: escapeHtml(data.analysis.summary || data.analysis.rawText || '暂无分析'),
            efficiency: escapeHtml(data.analysis.efficiency || '暂无评估'),
            highlights: formatList(data.analysis.highlights),
            risks: formatList(data.analysis.risks),
            suggestions: formatList(data.analysis.suggestions),
            tags: formatTags(data.analysis.tags)
        })

        const filename = `report-${Date.now()}-${Math.random().toString(36).slice(2)}.html`
        const htmlPath = path.resolve(this.templateDir, filename)
        await fs.writeFile(htmlPath, html, 'utf-8')

        const page = await this.ctx.puppeteer.page()
        try {
            await page.goto('file://' + htmlPath, { waitUntil: 'domcontentloaded' })
            await page.evaluate(() => document.fonts.ready)
            const element = await page.$('.container')
            if (!element) throw new Error('无法找到图片模板容器 .container')
            return (await element.screenshot({})) as Buffer
        } finally {
            await page.close().catch(() => undefined)
            this.ctx.setTimeout(() => {
                fs.unlink(htmlPath).catch(() => undefined)
            }, 3 * 60 * 1000)
        }
    }

    private formatTopApps(apps: ReportMetrics['topApps']): string {
        if (!apps.length) return '<div class="empty">暂无应用数据</div>'
        return `
            <table>
                <tbody>
                    ${apps
                        .map(
                            (app, index) => `
                                <tr>
                                    <td class="rank">${index + 1}</td>
                                    <td>${escapeHtml(app.name)}</td>
                                    <td class="duration">${escapeHtml(app.duration)}</td>
                                </tr>
                            `
                        )
                        .join('')}
                </tbody>
            </table>
        `
    }

    private resolveTheme(): 'light' | 'dark' {
        if (this.config.theme === 'light' || this.config.theme === 'dark') {
            return this.config.theme
        }
        const hour = new Date().getHours()
        return hour >= 19 || hour < 6 ? 'dark' : 'light'
    }

    private getResourcePath(filename: string): string {
        const dirname =
            typeof __dirname === 'string'
                ? __dirname
                : path.dirname(fileURLToPath(import.meta.url))
        return path.resolve(dirname, '../resources', filename)
    }

    private getStylePath(): string {
        return path.resolve(this.templateDir, 'style.css')
    }
}
