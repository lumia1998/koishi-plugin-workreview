import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Context, h, Session } from 'koishi'
import type {} from 'koishi-plugin-chatluna'
import type {} from 'koishi-plugin-puppeteer'
import type {} from 'koishi-plugin-cron'
import { modelSchema } from 'koishi-plugin-chatluna/utils/schema'
import { Config, type DeviceConfig } from './config.js'
import { ActivityLLM } from './llm.js'
import { ActivityRenderer } from './renderer.js'
import {
    WorkReviewClient,
    extractReportMetrics,
    aggregateReportMetrics,
    findCurrentScreenshotSnapshot,
    type ReportMetrics,
    type TimelineActivity
} from './workreview.js'
import { registerCurrentScreenTool } from './current-screen-tool.js'
import { isDateString, today, yesterday } from './utils.js'

export const name = 'workreview'
export const inject = {
    required: ['chatluna', 'puppeteer'],
    optional: ['cron']
}
export { Config }

interface GenerateOptions {
    text?: boolean
    list?: boolean
}

interface CachedTimeline {
    device: string
    date: string
    activities: TimelineActivity[]
    cachedAt: string
}

export function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('workreview')
    const client = new WorkReviewClient(config.timeout)
    const llm = new ActivityLLM(ctx, config)
    const renderer = new ActivityRenderer(ctx, config)

    modelSchema(ctx)
    registerCurrentScreenTool(ctx, config, client, llm)

    ctx.on('ready', async () => {
        await renderer.init().catch((error) =>
            logger.warn('初始化日报图片模板失败。', error)
        )
    })

    const commandName = config.commandName || '活动日报'
    const subcommands = new Set<string>()
    const cacheRoot = path.join(ctx.baseDir, 'data', 'workreview', 'cache')

    ctx.on('ready', async () => {
        await ensureCacheDir()
        await refreshTimelineCache()
    })
    ctx.setInterval(refreshTimelineCache, Math.max(config.cacheIntervalMinutes, 1) * 60 * 1000)

    ctx.command(`${commandName} [device] [date]`, '生成活动日报')
        .alias('日报')
        .option('yesterday', '-y, --yesterday 生成昨天的日报')
        .option('text', '-t, --text 以文本形式返回 AI 分析')
        .option('list', '-l, --list 查看已配置设备')
        .action(async ({ session, options }, deviceName, dateArg) => {
            if (!session) return
            if (options?.list) return formatDeviceList(config.devices)
            if (isReservedSubcommand(deviceName, subcommands)) return

            const { deviceName: resolvedDeviceName, dateArg: resolvedDateArg } = resolveDeviceAndDate(deviceName, dateArg)
            const resolvedDevice = resolvedDeviceName || defaultDeviceName()
            if (!resolvedDevice) return formatDeviceList(config.devices)

            const date = resolveDate(resolvedDateArg, options?.yesterday)
            if (!date) return '日期格式错误，请使用 YYYY-MM-DD，或使用 -y 表示昨天。'

            return sendReport(session, resolvedDevice, date, {
                text: options?.text
            })
        })

    ctx.command(`${commandName}/周报 [device]`, '生成本周活动周报（周一至今）')
        .alias('周报')
        .action(async ({ session }, deviceName) => {
            if (!session) return
            const resolvedDevice = deviceName || defaultDeviceName()
            if (!resolvedDevice) return formatDeviceList(config.devices)
            return sendWeeklyReport(session, resolvedDevice)
        })
    subcommands.add('周报')

    ctx.command(`${commandName}/列表`, '查看已配置设备').action(() =>
        formatDeviceList(config.devices)
    )
    subcommands.add('列表')

    ctx.command('peek [device]', '发送当前屏幕截图')
        .action(async ({ session }, deviceName) => {
            if (!session) return
            const resolvedDevice = deviceName || defaultDeviceName()
            if (!resolvedDevice) return formatDeviceList(config.devices)
            return sendCurrentScreenshot(session, resolvedDevice)
        })

    // 定时推送
    if (config.pushes?.length && ctx.cron) {
        for (const push of config.pushes) {
            if (!push.enabled) continue
            const cron = timeToCron(push.time)
            if (!cron) {
                logger.warn(`推送规则 ${push.device} 的时间格式错误：${push.time}`)
                continue
            }
            ctx.cron(cron, async () => {
                const device = findDevice(push.device)
                if (!device) return
                const date = push.reportDate === 'yesterday' ? yesterday() : today()
                for (const channelId of push.channels) {
                    try {
                        const bot = ctx.bots.find((b) => b.getChannel(channelId))
                        if (!bot) continue
                        const session = bot.session({ channel: { id: channelId, type: 0 } })
                        await sendReport(session, push.device, date, {})
                    } catch (error) {
                        logger.warn(`推送到 ${channelId} 失败`, error)
                    }
                }
            })
        }
    }

    async function ensureCacheDir() {
        await fs.mkdir(cacheRoot, { recursive: true })
    }

    async function refreshTimelineCache() {
        const date = today()
        for (const device of config.devices) {
            try {
                const activities = await client.getTimeline(device, date)
                await saveCachedTimeline(device.name, date, activities)
                logger.debug(`已缓存 ${device.name} ${date} 的时间线 (${activities.length} 条)`)
            } catch (error) {
                logger.debug(`缓存 ${device.name} ${date} 时间线失败`, error)
            }
        }
    }

    async function saveCachedTimeline(deviceName: string, date: string, activities: TimelineActivity[]) {
        await ensureCacheDir()
        const cached: CachedTimeline = {
            device: deviceName,
            date,
            activities,
            cachedAt: new Date().toISOString()
        }
        const filename = `${deviceName}_${date}.json`
        const filepath = path.join(cacheRoot, filename)
        await fs.writeFile(filepath, JSON.stringify(cached, null, 2), 'utf-8')

        // 清理 14 天前的缓存
        await cleanOldCache(14)
    }

    async function loadCachedTimeline(deviceName: string, date: string): Promise<TimelineActivity[] | null> {
        const filename = `${deviceName}_${date}.json`
        const filepath = path.join(cacheRoot, filename)
        try {
            const content = await fs.readFile(filepath, 'utf-8')
            const cached: CachedTimeline = JSON.parse(content)
            return cached.activities
        } catch {
            return null
        }
    }

    async function cleanOldCache(keepDays: number) {
        try {
            const files = await fs.readdir(cacheRoot)
            const cutoffDate = new Date()
            cutoffDate.setDate(cutoffDate.getDate() - keepDays)

            for (const file of files) {
                if (!file.endsWith('.json')) continue
                const match = file.match(/_(\d{4}-\d{2}-\d{2})\.json$/)
                if (!match) continue

                const fileDate = new Date(match[1])
                if (fileDate < cutoffDate) {
                    await fs.unlink(path.join(cacheRoot, file))
                    logger.debug(`已清理旧缓存: ${file}`)
                }
            }
        } catch (error) {
            logger.debug('清理缓存失败', error)
        }
    }

    async function getTimeline(deviceName: string, date: string): Promise<TimelineActivity[]> {
        const device = findDevice(deviceName)
        if (!device) throw new Error(`找不到设备：${deviceName}`)

        try {
            logger.debug(`从 API 获取时间线: ${deviceName} ${date}`)
            const activities = await client.getTimeline(device, date)
            await saveCachedTimeline(deviceName, date, activities)
            return activities
        } catch (error) {
            logger.debug(`从 API 获取 ${deviceName} ${date} 时间线失败，尝试读取缓存`, error)
            const cached = await loadCachedTimeline(deviceName, date)
            if (cached) {
                logger.debug(`使用缓存的时间线: ${deviceName} ${date} (${cached.length} 条)`)
                return cached
            }
            throw error
        }
    }

    async function sendReport(
        session: Session,
        deviceName: string,
        date: string,
        options: GenerateOptions
    ): Promise<void> {
        try {
            const activities = await getTimeline(deviceName, date)

            if (activities.length === 0) {
                await session.send('未检测到当日活动。')
                return
            }

            const metrics = extractReportMetrics(activities, date)
            const activitySummary = buildActivitySummary(activities, metrics)
            const topAppNames = metrics.topApps.slice(0, 5).map((app) => app.name)
            const browserSiteNames = metrics.topBrowserSites.map((site) => site.domain)

            const analysis = await llm.analyze(deviceName, date, activitySummary, topAppNames, browserSiteNames)

            if (options.text || config.outputMode === 'text') {
                await session.send(formatTextReport(deviceName, date, analysis))
                return
            }

            const imageBuffer = await renderer.render({
                deviceName,
                date,
                metrics,
                analysis,
                summaryTitle: '每日总结',
                reportTitle: '活动日报',
                chartTitle: '24H 活跃轨迹',
            })

            if (config.outputMode === 'both') {
                await session.send(h.image(imageBuffer, 'image/png'))
                await session.send(formatTextReport(deviceName, date, analysis))
            } else {
                await session.send(h.image(imageBuffer, 'image/png'))
            }
        } catch (error) {
            await session.send(formatError('生成日报失败', error))
        }
    }

    async function sendWeeklyReport(session: Session, deviceName: string): Promise<void> {
        try {
            const endDate = today()
            const dates = getWeekDates(endDate)

            const allMetrics: ReportMetrics[] = []
            let hasActivity = false
            for (const date of dates) {
                try {
                    const activities = await getTimeline(deviceName, date)
                    const metrics = extractReportMetrics(activities, date)
                    allMetrics.push(metrics)
                    if (activities.length > 0) hasActivity = true
                } catch (error) {
                    logger.debug(`获取 ${date} 数据失败`, error)
                }
            }

            if (!hasActivity) {
                await session.send('本周暂无活动数据。')
                return
            }

            const weeklyMetrics = aggregateReportMetrics(allMetrics)
            const topAppNames = weeklyMetrics.topApps.slice(0, 5).map((app) => app.name)
            const browserSiteNames = weeklyMetrics.topBrowserSites.map((site) => site.domain)

            // 构建周报摘要
            const weeklySummary = buildWeeklySummary(allMetrics, weeklyMetrics)
            const analysis = await llm.analyze(deviceName, weeklyMetrics.date, weeklySummary, topAppNames, browserSiteNames, 'week')

            const imageBuffer = await renderer.render({
                deviceName,
                date: weeklyMetrics.date,
                metrics: weeklyMetrics,
                analysis,
                summaryTitle: '每周总结',
                reportTitle: '活动周报',
                chartTitle: '本周活跃轨迹',
                dailyActivity: buildDailyActivity(allMetrics),
            })

            await session.send(h.image(imageBuffer, 'image/png'))
        } catch (error) {
            await session.send(formatError('生成周报失败', error))
        }
    }

    async function sendCurrentScreenshot(session: Session, deviceName: string): Promise<void> {
        try {
            const device = findDevice(deviceName)
            if (!device) throw new Error(`找不到设备：${deviceName}`)
            const activities = await client.getTimeline(device, today())
            const snapshot = findCurrentScreenshotSnapshot(activities)
            if (!snapshot) {
                await session.send('没有找到今天的屏幕活动记录。')
                return
            }
            if (!snapshot.screenshotUrl) {
                await session.send(formatSensitiveScreenshotNotice(snapshot))
                return
            }

            const blurLevel = resolveScreenshotBlur(snapshot.sensitive)
            if (blurLevel > 0) {
                const imageBuffer = await renderer.blurImageUrl(snapshot.screenshotUrl, blurLevel)
                await session.send(h.image(imageBuffer, 'image/png'))
            } else {
                await session.send(h.image(snapshot.screenshotUrl))
            }

            if (snapshot.sensitive) {
                await session.send(`当前屏幕命中隐私规则，已强制模糊处理：${snapshot.sensitiveReason || '敏感内容'}`)
            } else if (blurLevel > 0) {
                await session.send(`当前截图已按配置应用 ${blurLevel}/100 模糊。`)
            }
        } catch (error) {
            await session.send(formatError('发送当前截图失败', error))
        }
    }

    function resolveScreenshotBlur(forceBlur: boolean): number {
        const configured = Math.max(0, Math.min(100, Math.round(config.currentScreenshotBlur || 0)))
        return forceBlur ? Math.max(configured, 70) : configured
    }

    function formatSensitiveScreenshotNotice(snapshot: { sensitiveReason: string | null }): string {
        const reason = snapshot.sensitiveReason || '当前活动没有可发送截图'
        return `当前屏幕可能包含敏感内容，Work_Review 未返回可发送截图：${reason}`
    }

    function buildActivitySummary(activities: TimelineActivity[], metrics: any): string {
        const lines = [
            `总活跃时长: ${metrics.totalDuration}`,
            `活动记录数: ${metrics.screenshotCount}`,
            `使用应用数: ${metrics.appCount}`,
            '',
            '应用使用排行:',
            ...metrics.topApps.map((app: any, i: number) => `${i + 1}. ${app.name}: ${app.duration}`),
            '',
            '每小时活跃分钟数:',
            ...metrics.hourlyActivity.hours
                .map((seconds: number, hour: number) => {
                    const minutes = Math.round(seconds / 60)
                    return minutes > 0 ? `${String(hour).padStart(2, '0')}:00 - ${minutes}分钟` : null
                })
                .filter(Boolean),
            '',
            '主要活动类别:',
            ...getCategoryDistribution(activities)
        ]

        if (metrics.topBrowserSites?.length) {
            lines.push('', '浏览器访问记录:')
            for (const site of metrics.topBrowserSites) {
                const titles = site.titles.length ? `: "${site.titles.join('", "')}"` : ''
                lines.push(`- ${site.domain} (${site.duration})${titles}`)
            }
        }

        return lines.join('\n')
    }

    function getCategoryDistribution(activities: TimelineActivity[]): string[] {
        const categoryDurations = new Map<string, number>()
        for (const activity of activities) {
            const category = activity.semantic_category || '未分类'
            const existing = categoryDurations.get(category) || 0
            categoryDurations.set(category, existing + activity.duration)
        }

        return [...categoryDurations.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([category, seconds]) => {
                const minutes = Math.round(seconds / 60)
                return `- ${category}: ${minutes}分钟`
            })
    }

    function buildWeeklySummary(allMetrics: ReportMetrics[], weeklyMetrics: ReportMetrics): string {
        const lines = [
            '本周活动汇总:',
            '',
            '每日活跃时长:',
            ...allMetrics.map(m => `- ${m.date}: ${m.totalDuration}`),
            '',
            '整周应用使用排行:',
            ...weeklyMetrics.topApps.map((app, i) => `${i + 1}. ${app.name}: ${app.duration}`)
        ]
        return lines.join('\n')
    }

    function buildDailyActivity(metrics: ReportMetrics[]) {
        const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
        return metrics.map((metric) => {
            const [year, month, day] = metric.date.split('-').map(Number)
            const label = labels[new Date(year, month - 1, day).getDay()]
            return {
                date: metric.date,
                label,
                seconds: metric.totalSeconds,
                duration: metric.totalDuration
            }
        })
    }

    function getWeekDates(endDate: string): string[] {
        const [year, month, day] = endDate.split('-').map(Number)
        const end = new Date(year, month - 1, day)
        const dayOfWeek = end.getDay()
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1

        const dates: string[] = []
        for (let i = daysFromMonday; i >= 0; i--) {
            const date = new Date(end)
            date.setDate(end.getDate() - i)
            const y = date.getFullYear()
            const m = String(date.getMonth() + 1).padStart(2, '0')
            const d = String(date.getDate()).padStart(2, '0')
            dates.push(`${y}-${m}-${d}`)
        }
        return dates
    }

    function findDevice(deviceName?: string): DeviceConfig | undefined {
        return config.devices.find((device) => device.name === deviceName)
    }

    function defaultDeviceName(): string | undefined {
        return config.devices[0]?.name
    }

    function resolveDeviceAndDate(
        deviceName?: string,
        dateArg?: string
    ): { deviceName?: string; dateArg?: string } {
        if (deviceName && isDateString(deviceName) && !dateArg) {
            return { dateArg: deviceName }
        }
        return { deviceName, dateArg }
    }

    function resolveDate(dateArg?: string, useYesterday?: boolean): string | null {
        if (dateArg && isDateString(dateArg)) return dateArg
        if (dateArg && !isDateString(dateArg)) return null
        return useYesterday ? yesterday() : today()
    }

    function formatDeviceList(devices: DeviceConfig[]): string {
        if (!devices.length) return '还没有配置 Work_Review 设备。'
        return `已配置设备：\n${devices.map((device) => `- ${device.name}: ${device.protocol}://${device.host}:${device.port}`).join('\n')}`
    }

    function formatError(prefix: string, error: unknown): string {
        const message = error instanceof Error ? error.message : String(error)
        return `${prefix}：${message}`
    }

    function formatTextReport(
        deviceName: string,
        date: string,
        analysis: { text: string }
    ): string {
        return [
            `# ${deviceName} 活动日报 ${date}`,
            '',
            '## 每日总结',
            analysis.text || '暂无分析'
        ].join('\n')
    }

    function timeToCron(time: string): string | null {
        const match = time.match(/^(\d{1,2}):(\d{2})$/)
        if (!match) return null
        const hour = Number(match[1])
        const minute = Number(match[2])
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
        return `${minute} ${hour} * * *`
    }

    function isReservedSubcommand(value: string | undefined, subcommands: Set<string>): boolean {
        return subcommands.has(value || '')
    }
}
