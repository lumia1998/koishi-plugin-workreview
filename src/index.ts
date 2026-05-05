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
    truncateRawReport,
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
    weekly?: boolean
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

    ctx.command(`${commandName} <device> [date]`, '生成活动日报')
        .option('yesterday', '-y, --yesterday 生成昨天的日报')
        .option('raw', '-r, --raw 只返回原始日报数据')
        .option('text', '-t, --text 以文本形式返回 AI 分析')
        .action(async ({ session, options }, deviceName, dateArg) => {
            if (!session) return
            if (isReservedSubcommand(deviceName, subcommands)) return
            if (!deviceName) return formatDeviceList(config.devices)

            const date = resolveDate(dateArg, options?.yesterday)
            if (!date) return '日期格式错误，请使用 YYYY-MM-DD，或使用 -y 表示昨天。'

            return sendReport(session, deviceName, date, {
                raw: options?.raw,
                text: options?.text
            })
        })

    ctx.command(`${commandName}/原始 <device> [date]`, '查看截断后的原始日报')
        .option('yesterday', '-y, --yesterday 查看昨天')
        .action(async (_, deviceName, dateArg) => {
            if (!deviceName) return formatDeviceList(config.devices)
            const date = resolveDate(dateArg, _.options?.yesterday)
            if (!date) return '日期格式错误，请使用 YYYY-MM-DD，或使用 -y 表示昨天。'
            return generateRawReport(deviceName, date)
        })
    subcommands.add('原始')

    ctx.command(`${commandName}/周报 <device>`, '生成最近 7 天活动周报')
        .action(async ({ session }, deviceName) => {
            if (!session) return
            if (!deviceName) return formatDeviceList(config.devices)
            return sendWeeklyReport(session, deviceName)
        })
    subcommands.add('周报')

    ctx.command(`${commandName}/列表`, '查看已配置设备').action(() =>
        formatDeviceList(config.devices)
    )
    subcommands.add('列表')

    ctx.command(`${commandName}/日报列表 <device>`, '查看设备已有日报日期').action(
        async (_, deviceName) => {
            const device = findDevice(deviceName)
            if (!device) return formatDeviceNotFound(deviceName)
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

    ctx.command(`${commandName}/设备信息 <device>`, '查看 Work_Review 设备信息').action(
        async (_, deviceName) => {
            const device = findDevice(deviceName)
            if (!device) return formatDeviceNotFound(deviceName)
            try {
                const info = await client.deviceInfo(device)
                return `设备信息：\n${JSON.stringify(info, null, 2)}`
            } catch (error) {
                return formatError(`获取 ${device.name} 设备信息失败`, error)
            }
        }
    )
    subcommands.add('设备信息')

    ctx.command(`${commandName}/健康 <device>`, '查看 Work_Review 健康状态').action(
        async (_, deviceName) => {
            const device = findDevice(deviceName)
            if (!device) return formatDeviceNotFound(deviceName)
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
                dates.map(async (date) => ({
                    date,
                    rawReport: await fetchTruncatedReport(device, date)
                }))
            )
            const rawReports = results
                .filter((r): r is PromiseFulfilledResult<{ date: string; rawReport: string }> => r.status === 'fulfilled')
                .map((r) => r.value)

            if (!rawReports.length) {
                return session.send(`${device.name} 最近 7 天没有可用的日报数据。`)
            }

            const dateRange = `${dates.at(-1)} ~ ${dates[0]}`
            const rawReport = rawReports
                .map((report) => `## ${report.date}\n\n${report.rawReport}`)
                .join('\n\n---\n\n')
            const analysis = await llm.analyze(device.name, dateRange, rawReport)
            const metrics = aggregateReportMetrics(rawReports, dateRange)
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
            const rawReport = await fetchTruncatedReport(device, date)
            if (options.raw) return rawReport

            const metrics = extractReportMetrics(rawReport, date)
            const analysis = await llm.analyze(device.name, metrics.date || date, rawReport)

            if (options.text || config.outputMode === 'text') {
                return formatTextReport(device.name, metrics.date || date, rawReport, analysis)
            }

            const buffer = await renderer.render({
                deviceName: device.name,
                date: metrics.date || date,
                metrics,
                analysis,
                summaryTitle: '每日总结'
            })

            if (config.outputMode === 'both') {
                return h('message',
                    h.image(buffer, 'image/png'),
                    h.text('\n' + formatTextReport(device.name, metrics.date || date, rawReport, analysis))
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
            return await fetchTruncatedReport(device, date)
        } catch (error) {
            return formatError(`获取 ${device.name} ${date} 原始日报失败`, error)
        }
    }

    async function fetchTruncatedReport(device: DeviceConfig, date: string): Promise<string> {
        try {
            const report = await client.getReport(device, date)
            return truncateRawReport(report.content || '')
        } catch (error) {
            if (!config.autoGenerateMissingReport) throw error
            const report = await client.generateReport(device, date)
            return truncateRawReport(report.content || '')
        }
    }

    function findDevice(name?: string): DeviceConfig | undefined {
        if (!name) return undefined
        const normalized = name.trim().toLowerCase()
        return config.devices.find((device) => device.name.trim().toLowerCase() === normalized)
    }
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
