import { Context } from 'koishi'
import { promises as fs } from 'fs'
import path from 'path'
import type { Config } from './config.js'
import type { ActivityAnalysis, AppComment } from './llm.js'
import type { ReportMetrics } from './workreview.js'
import {
    escapeHtml,
    renderTemplate
} from './utils.js'

const APP_COLORS = [
    '#ff7043', '#42a5f5', '#66bb6a', '#ab47bc',
    '#ffa726', '#26c6da', '#ec407a', '#8d6e63'
]

const CATEGORY_COLORS: Record<string, string> = {
    '娱乐摸鱼': '#ec407a',
    '通讯协作': '#42a5f5',
    '浏览器': '#ff7043',
    '开发工具': '#ab47bc',
    '办公软件': '#66bb6a',
    '设计工具': '#26c6da',
    '系统工具': '#8d6e63',
    '其他': '#bdbdbd'
}

const CATEGORY_FALLBACK_COLORS = ['#ffa726', '#78909c', '#7e57c2', '#29b6f6']

function getCategoryColor(category: string, index: number): string {
    return CATEGORY_COLORS[category] || CATEGORY_FALLBACK_COLORS[index % CATEGORY_FALLBACK_COLORS.length]
}

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
        const topApps = data.metrics.topApps.slice(0, 8)
        const colorMap = new Map(topApps.map((app, i) => [app.name, APP_COLORS[i % APP_COLORS.length]]))

        const html = renderTemplate(template, {
            inlineStyle: this.applyTheme(css),
            deviceName: escapeHtml(data.deviceName),
            date: escapeHtml(data.date),
            totalDuration: escapeHtml(data.metrics.totalDuration),
            activityChart: this.generateCombinedChart(data.metrics, colorMap),
            appLegend: this.generateLegend(topApps, colorMap),
            categoryPieChart: this.generateCategoryPieChart(data.metrics.categoryBreakdown),
            topAppsWithComments: this.generateTopAppsComments(topApps, data.analysis.appComments),
            summaryTitle: escapeHtml(data.summaryTitle),
            summary: this.formatSummaryText(data.analysis.text || '暂无分析')
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
        const darkTheme = ':root { --bg-paper: #1f1b24; --ink-primary: #f3e8ff; --ink-secondary: #d6c2e8; } body { background-color: var(--bg-paper); } .container, .title-sticker, .chart-section, .summary-note, .analysis-card { background: #2a2433; }'
        if (this.config.theme === 'dark') return `${css}\n${darkTheme}`
        if (this.config.theme === 'auto') return `${css}\n@media (prefers-color-scheme: dark) { ${darkTheme} }`
        return css
    }

    private generateCombinedChart(
        metrics: ReportMetrics,
        colorMap: Map<string, string>
    ): string {
        const breakdown = metrics.hourlyAppBreakdown
        const useBreakdown = breakdown.maxSeconds > 0 && breakdown.hours.some((entries) => entries.length > 0)
        const hours = useBreakdown ? breakdown.hours : metrics.hourlyActivity.hours.map((seconds) => [{ app: '__total__', seconds }])
        const maxSeconds = useBreakdown ? breakdown.maxSeconds : metrics.hourlyActivity.maxSeconds

        if (maxSeconds === 0) {
            return '<div class="empty">暂无活跃数据</div>'
        }

        const items = hours.map((entries, i) => {
            const totalSeconds = entries.reduce((sum, e) => sum + e.seconds, 0)
            const percentage = maxSeconds > 0 ? (totalSeconds / maxSeconds) * 100 : 0
            const label = String(i).padStart(2, '0')

            if (totalSeconds === 0) {
                return `
                <div class="chart-column" title="${label}:00">
                    <div class="bar-stack" style="height: 0px;"></div>
                    <div class="bar-label-x">${label}</div>
                </div>`
            }

            const height = `max(4px, ${percentage}%)`
            const segments = useBreakdown
                ? entries
                    .slice()
                    .sort((a, b) => b.seconds - a.seconds)
                    .map((entry) => {
                        const color = colorMap.get(entry.app) || '#ccc'
                        const flex = entry.seconds / totalSeconds
                        return `<div class="bar-segment" style="flex: ${flex}; background-color: ${color};"></div>`
                    })
                    .join('')
                : `<div class="bar-segment" style="flex: 1; background-color: #cdd6e4;"></div>`

            const minutes = Math.round(totalSeconds / 60)
            return `
                <div class="chart-column show-value" title="${label}:00 - ${minutes}分钟">
                    <div class="bar-value-top">${minutes > 0 ? minutes + 'm' : ''}</div>
                    <div class="bar-stack" style="height: ${height};">${segments}</div>
                    <div class="bar-label-x">${label}</div>
                </div>`
        })

        return `<div class="chart-container-horizontal">${items.join('')}</div>`
    }

    private generateLegend(
        topApps: ReportMetrics['topApps'],
        colorMap: Map<string, string>
    ): string {
        if (!topApps.length) return ''
        return topApps
            .map((app) => {
                const color = colorMap.get(app.name) || '#ccc'
                return `<div class="legend-item"><span class="legend-dot" style="background:${color};"></span><span class="legend-name">${escapeHtml(app.name)}</span></div>`
            })
            .join('')
    }

    private generateTopAppsComments(
        topApps: ReportMetrics['topApps'],
        appComments: AppComment[]
    ): string {
        const top5 = topApps.slice(0, 5)
        if (!top5.length) return '<div class="empty">暂无应用数据</div>'

        return top5
            .map((app, index) => {
                const comment = appComments.find(
                    (c) => normalizeAppName(c.name).includes(normalizeAppName(app.name)) || normalizeAppName(app.name).includes(normalizeAppName(c.name))
                )
                const commentText = comment?.comment || buildFallbackComment(app.name, index + 1)
                return `
                <div class="top-app-item">
                    <div class="top-app-header">
                        <span class="top-app-rank">${index + 1}</span>
                        <span class="top-app-name">${escapeHtml(app.name)}</span>
                        <span class="top-app-duration">${escapeHtml(app.duration)}</span>
                    </div>
                    <div class="top-app-comment">${escapeHtml(commentText)}</div>
                </div>`
            })
            .join('')
    }

    private generateCategoryPieChart(
        categoryBreakdown: Array<{ category: string; seconds: number }>
    ): string {
        if (!categoryBreakdown.length) return '<div class="empty">暂无分类数据</div>'

        const totalSeconds = categoryBreakdown.reduce((sum, c) => sum + c.seconds, 0)
        if (totalSeconds === 0) return '<div class="empty">暂无分类数据</div>'

        const radius = 60
        const cx = 70
        const cy = 70
        let startAngle = -Math.PI / 2

        const paths = categoryBreakdown.map((item, index) => {
            const fraction = item.seconds / totalSeconds
            if (fraction < 0.005) return ''
            const endAngle = startAngle + fraction * 2 * Math.PI
            const largeArc = fraction > 0.5 ? 1 : 0
            const x1 = cx + radius * Math.cos(startAngle)
            const y1 = cy + radius * Math.sin(startAngle)
            const x2 = cx + radius * Math.cos(endAngle)
            const y2 = cy + radius * Math.sin(endAngle)
            const color = getCategoryColor(item.category, index)
            const path = `<path d="M${cx},${cy} L${x1},${y1} A${radius},${radius} 0 ${largeArc},1 ${x2},${y2} Z" fill="${color}"/>`
            startAngle = endAngle
            return path
        }).join('')

        const svg = `<svg viewBox="0 0 140 140" class="pie-svg">${paths}</svg>`

        const legendItems = categoryBreakdown
            .filter((item) => item.seconds / totalSeconds >= 0.005)
            .map((item, index) => {
                const color = getCategoryColor(item.category, index)
                const percent = Math.round((item.seconds / totalSeconds) * 100)
                const minutes = Math.round(item.seconds / 60)
                return `<div class="category-legend-item">
                    <span class="category-dot" style="background:${color};"></span>
                    <span class="category-name">${escapeHtml(item.category)}</span>
                    <span class="category-percent">${percent}%</span>
                    <span class="category-duration">${minutes}m</span>
                </div>`
            }).join('')

        return `<div class="category-pie-container">
            <div class="pie-chart">${svg}</div>
            <div class="category-legend">${legendItems}</div>
        </div>`
    }

    private formatSummaryText(text: string): string {
        // 将文本按换行符分段，每段用 <p> 包裹，保留完整内容
        const paragraphs = text.split('\n').filter(line => line.trim())
        if (paragraphs.length === 0) return '<p>暂无分析</p>'

        return paragraphs
            .map(para => `<p>${escapeHtml(para)}</p>`)
            .join('')
    }

    private getResourcePath(filename: string): string {
        return path.resolve(__dirname, '../resources', filename)
    }
}

function normalizeAppName(value: string): string {
    return value.toLowerCase().replace(/[\s._-]+/g, '')
}

function buildFallbackComment(appName: string, rank: number): string {
    if (/chrome|edge|浏览器/i.test(appName)) return '浏览器开得很勤，看来今天又在四处找答案。'
    if (/qq|微信|wechat|telegram|slack|discord/i.test(appName)) return '消息窗口常驻，注意力也被它顺手接管了。'
    if (/vscode|cursor|code|ide/i.test(appName)) return '和代码缠斗的痕迹很明显，今天没少动脑。'
    if (/excel|spreadsheet|表格/i.test(appName)) return '表格味很重，应该是在和数字认真较劲。'
    if (/notion|obsidian|docs|word|文档/i.test(appName)) return '文档型工作不少，脑子和页面一起在转。'
    return `第${rank}名选手，今天存在感不低。`
}


