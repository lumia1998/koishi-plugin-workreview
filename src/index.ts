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
    aggregateReportMetrics,
    extractReportMetrics,
    WorkReviewClient
} from './workreview.js'
import { isDateString, previousDates, today, yesterday } from './utils.js'

export const name = 'workreview'
export const inject = {
    required: ['chatluna', 'puppeteer'],
    optional: ['cron']
}
export { Config }

interface GenerateOptions {
    raw?: boolean
    text?: boolean
    list?: boolean
}

interface CachedReport {
    device: string
    date: string
    content: string
    cachedAt: string
}

interface ReportSource {
    rawReport: string
    cachedAt?: string
}

export function apply(ctx: Context, config: Config) {
    const logger = ctx.logger('workreview')
    const client = new WorkReviewClient(config.timeout)
    const llm = new ActivityLLM(ctx, config)
    const renderer = new ActivityRenderer(ctx, config)

    modelSchema(ctx)

    ctx.on('ready', async () => {
        await renderer.init().catch((error) =>
            logger.warn('初始化日报图片模板失败。', error)
        )
    })

    const commandName = config.commandName || '活动日报'
    const subcommands = new Set<string>()
    const cacheRoot = path.join(ctx.baseDir, 'temp', 'workreview')

    if (config.cacheReports) {
        ctx.on('ready', async () => {
            await refreshReportCache()
        })
        ctx.setInterval(refreshReportCache, Math.max(config.cacheIntervalMinutes, 1) * 60 * 1000)
    }

    ctx.command(`${commandName} [device] [date]`, '生成活动日报')
        .alias('日报')
        .option('yesterday', '-y, --yesterday 生成昨天的日报')
        .option('raw', '-r, --raw 只返回原始日报数据')
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
                raw: options?.raw,
                text: options?.text
            })
        })

    ctx.command(`${commandName}/原始 [device] [date]`, '查看截断后的原始日报')
        .option('yesterday', '-y, --yesterday 查看昨天')
        .action(async (_, deviceName, dateArg) => {
            const { deviceName: resolvedDeviceName, dateArg: resolvedDateArg } = resolveDeviceAndDate(deviceName, dateArg)
            const resolvedDevice = resolvedDeviceName || defaultDeviceName()
            if (!resolvedDevice) return formatDeviceList(config.devices)
            const date = resolveDate(resolvedDateArg, _.options?.yesterday)
            if (!date) return '日期格式错误，请使用 YYYY-MM-DD，或使用 -y 表示昨天。'
            return generateRawReport(resolvedDevice, date)
        })
    subcommands.add('原始')

    ctx.command(`${commandName}/周报 [device]`, '生成最近 7 天活动周报')
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

    ctx.command(`${commandName}/日报列表 [device]`, '查看设备已有日报日期').action(
        async (_, deviceName) => {
            const resolvedDevice = deviceName || defaultDeviceName()
            const device = findDevice(resolvedDevice)
            if (!device) return formatDeviceNotFound(resolvedDevice)
            try {
                const reports = await client.listReports(device)
                return reports.dates?.length
                    ? `${device.name} 已有日报：\n${reports.dates.join('\n')}`
                    : `${device.name} 暂无日报。`
            } catch (error) {
                return formatError(`获取 ${device.name} 日报列表失败`, error)
            }
        }
    )
    subcommands.add('日报列表')

    ctx.command(`${commandName}/设备信息 [device]`, '查看 Work_Review 设备信息').action(
        async (_, deviceName) => {
            const resolvedDevice = deviceName || defaultDeviceName()
            const device = findDevice(resolvedDevice)
            if (!device) return formatDeviceNotFound(resolvedDevice)
            try {
                const info = await client.deviceInfo(device)
                return `设备信息：\n${JSON.stringify(info, null, 2)}`
            } catch (error) {
                return formatError(`获取 ${device.name} 设备信息失败`, error)
            }
        }
    )
    subcommands.add('设备信息')

    ctx.command(`${commandName}/健康 [device]`, '查看 Work_Review 健康状态').action(
        async (_, deviceName) => {
            const resolvedDevice = deviceName || defaultDeviceName()
            const device = findDevice(resolvedDevice)
            if (!device) return formatDeviceNotFound(resolvedDevice)
            try {
                const info = await client.health(device)
                return `健康状态：\n${JSON.stringify(info, null, 2)}`
            } catch (error) {
                return formatError(`获取 ${device.name} 健康状态失败`, error)
            }
        }
    )
    subcommands.add('健康')

    ctx.inject(['cron'], (ctx) => {
        for (const push of config.pushes.filter((item) => item.enabled)) {
            const cron = timeToCron(push.time)
            if (!cron) {
                logger.warn(`忽略无效推送时间：${push.time}`)
                continue
            }

            ctx.effect(() =>
                ctx.cron(cron, async () => {
                    const date = push.reportDate === 'today' ? today() : yesterday()
                    const message = await buildReportMessage(push.device, date)
                    await ctx.broadcast(push.channels, message)
                })
            )
        }
    })

    async function sendReport(
        session: Session,
        deviceName: string,
        date: string,
        options: GenerateOptions = {}
    ) {
        if (!options.raw) await session.send('正在生成日报，请稍候...')
        const message = await buildReportMessage(deviceName, date, options)
        await session.send(message)
    }

    async function sendWeeklyReport(session: Session, deviceName: string) {
        const device = findDevice(deviceName)
        if (!device) return session.send(formatDeviceNotFound(deviceName))

        await session.send('正在生成周报，请稍候...')

        try {
            const dates = previousDates(today(), 7)
            const results = await Promise.allSettled(
                dates.map(async (date) => {
                    const report = await fetchTruncatedReport(device, date)
                    return {
                        date,
                        ...report
                    }
                })
            )
            const rawReports = results
                .filter((r): r is PromiseFulfilledResult<{ date: string } & ReportSource> => r.status === 'fulfilled')
                .map((r) => r.value)

            if (!rawReports.length) {
                return session.send(`${device.name} 最近 7 天没有可用的日报数据。`)
            }

            const dateRange = `${dates.at(-1)} ~ ${dates[0]}`
            const rawReport = rawReports
                .map((report) => `## ${report.date}\n\n${report.rawReport}`)
                .join('\n\n---\n\n')
            const metrics = aggregateReportMetrics(rawReports, dateRange)
            const topAppNames = metrics.topApps.slice(0, 3).map((app) => app.name)
            const analysis = await llm.analyze(device.name, dateRange, rawReport, topAppNames)
            const buffer = await renderer.render({
                deviceName: `${device.name} 最近 7 天`,
                date: dateRange,
                metrics,
                analysis,
                summaryTitle: '每周总结'
            })

            await session.send(h.image(buffer, 'image/png'))
        } catch (error) {
            await session.send(formatError(`生成 ${device.name} 周报失败`, error))
        }
    }

    async function buildReportMessage(
        deviceName: string,
        date: string,
        options: GenerateOptions = {}
    ) {
        const device = findDevice(deviceName)
        if (!device) return formatDeviceNotFound(deviceName)

        try {
            const report = await fetchTruncatedReport(device, date)
            if (options.raw) return report.rawReport

            const metrics = extractReportMetrics(report.rawReport, date)
            const topAppNames = metrics.topApps.slice(0, 3).map((app) => app.name)
            const analysis = await llm.analyze(device.name, metrics.date || date, report.rawReport, topAppNames)

            if (options.text || config.outputMode === 'text') {
                return formatTextReport(device.name, metrics.date || date, report.rawReport, analysis)
            }

            const buffer = await renderer.render({
                deviceName: device.name,
                date: metrics.date || date,
                metrics,
                analysis,
                summaryTitle: '每日总结'
            })

            if (config.outputMode === 'both') {
                const textReport = '\n' + formatTextReport(device.name, metrics.date || date, report.rawReport, analysis)
                return h('message',
                    h.image(buffer, 'image/png'),
                    h.text(textReport)
                )
            }

            return h.image(buffer, 'image/png')
        } catch (error) {
            return formatError(`生成 ${deviceName} ${date} 日报失败`, error)
        }
    }

    async function generateRawReport(deviceName: string, date: string): Promise<string> {
        const device = findDevice(deviceName)
        if (!device) return formatDeviceNotFound(deviceName)
        try {
            const report = await fetchTruncatedReport(device, date)
            return report.rawReport
        } catch (error) {
            return formatError(`获取 ${device.name} ${date} 原始日报失败`, error)
        }
    }

    async function fetchTruncatedReport(device: DeviceConfig, date: string): Promise<ReportSource> {
        try {
            const rawReport = await fetchLiveTruncatedReport(device, date)
            await writeCachedReport(device, date, rawReport).catch((error) =>
                logger.warn(`写入 ${device.name} ${date} 日报缓存失败。`, error)
            )
            return { rawReport }
        } catch (error) {
            const cached = await readCachedReport(device, date)
            if (cached) return cached
            throw error
        }
    }

    async function fetchLiveTruncatedReport(device: DeviceConfig, date: string): Promise<string> {
        try {
            const report = await client.getReport(device, date)
            return report.content || ''
        } catch (error) {
            if (!config.autoGenerateMissingReport) throw error
            const report = await client.generateReport(device, date)
            return report.content || ''
        }
    }

    async function refreshReportCache() {
        await Promise.allSettled(
            config.devices.map(async (device) => {
                const date = today()
                try {
                    const rawReport = await fetchLiveTruncatedReport(device, date)
                    await writeCachedReport(device, date, rawReport)
                } catch (error) {
                    logger.debug(`刷新 ${device.name} ${date} 日报缓存失败。`, error)
                }
            })
        )
    }

    async function writeCachedReport(device: DeviceConfig, date: string, rawReport: string) {
        const file = getCacheFile(device, date)
        await fs.mkdir(path.dirname(file), { recursive: true })
        const data: CachedReport = {
            device: device.name,
            date,
            content: rawReport,
            cachedAt: new Date().toISOString()
        }
        await fs.writeFile(file, JSON.stringify(data), 'utf8')
    }

    async function readCachedReport(device: DeviceConfig, date: string): Promise<ReportSource | null> {
        try {
            const data = JSON.parse(await fs.readFile(getCacheFile(device, date), 'utf8')) as Partial<CachedReport>
            if (typeof data.content !== 'string' || typeof data.cachedAt !== 'string') return null
            return {
                rawReport: data.content,
                cachedAt: data.cachedAt
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') logger.warn(`读取 ${device.name} ${date} 日报缓存失败。`, error)
            return null
        }
    }

    function getCacheFile(device: DeviceConfig, date: string): string {
        return path.join(cacheRoot, safePathSegment(device.name), `${date}.json`)
    }

    function safePathSegment(value: string): string {
        return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'device'
    }

    function findDevice(name?: string): DeviceConfig | undefined {
        if (!name) return undefined
        const normalized = name.trim().toLowerCase()
        return config.devices.find((device) => device.name.trim().toLowerCase() === normalized)
    }

    function defaultDeviceName(): string | undefined {
        return config.devices.length === 1 ? config.devices[0].name : undefined
    }
}

function resolveDeviceAndDate(deviceName?: string, dateArg?: string): { deviceName?: string; dateArg?: string } {
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

function formatDeviceNotFound(deviceName?: string): string {
    return `找不到设备：${deviceName || '未指定'}。请先在插件配置里添加设备。`
}

function formatError(prefix: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return `${prefix}：${message}`
}

function formatTextReport(
    deviceName: string,
    date: string,
    _rawReport: string,
    analysis: { text: string },
    summaryTitle = '每日总结'
): string {
    const reportTitle = summaryTitle === '每周总结' ? '活动周报' : '活动日报'
    return [
        `# ${deviceName} ${reportTitle} ${date}`,
        '',
        `## ${summaryTitle}`,
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
