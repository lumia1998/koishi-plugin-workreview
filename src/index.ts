import { Context, h, Session } from 'koishi'
import type {} from 'koishi-plugin-chatluna'
import type {} from 'koishi-plugin-puppeteer'
import type {} from 'koishi-plugin-cron'
import { modelSchema } from 'koishi-plugin-chatluna/utils/schema'
import { Config, type DeviceConfig } from './config'
import { ActivityLLM } from './llm'
import { ActivityRenderer } from './renderer'
import {
    extractReportMetrics,
    truncateRawReport,
    WorkReviewClient
} from './workreview'
import { isDateString, previousDates, today, yesterday } from './utils'

export const name = 'workreview'
export const inject = ['chatluna', 'puppeteer']
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

    ctx.command(`${commandName} <device> [date]`, '生成活动日报')
        .option('yesterday', '-y, --yesterday 生成昨天的日报')
        .option('raw', '-r, --raw 只返回原始日报数据')
        .option('text', '-t, --text 以文本形式返回 AI 分析')
        .action(async ({ session, options }, deviceName, dateArg) => {
            if (!session) return
            if (isReservedSubcommand(deviceName)) return
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

    ctx.command(`${commandName}/周报 <device>`, '生成最近 7 天活动周报')
        .action(async ({ session }, deviceName) => {
            if (!session) return
            if (!deviceName) return formatDeviceList(config.devices)
            return sendWeeklyReport(session, deviceName)
        })

    ctx.command(`${commandName}/列表`, '查看已配置设备').action(() =>
        formatDeviceList(config.devices)
    )

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

    ctx.inject(['cron'], (ctx) => {
        for (const push of config.pushes.filter((item) => item.enabled)) {
            const cron = timeToCron(push.time)
            if (!cron) {
                logger.warn(`忽略无效推送时间：${push.time}`)
                continue
            }

            ctx.effect(() =>
                ctx.cron(cron, async () => {
                    const message = await buildReportMessage(push.device, today())
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

        try {
            const dates = previousDates(today(), 7)
            const rawReports: string[] = []
            for (const date of dates) {
                const raw = await fetchTruncatedReport(device, date)
                rawReports.push(`## ${date}\n\n${raw}`)
            }

            const rawReport = rawReports.join('\n\n---\n\n')
            const analysis = await llm.analyze(device.name, `${dates.at(-1)} ~ ${dates[0]}`, rawReport)
            const metrics = extractReportMetrics(rawReports[0], dates[0])
            const buffer = await renderer.render({
                deviceName: `${device.name} 最近 7 天`,
                date: `${dates.at(-1)} ~ ${dates[0]}`,
                metrics,
                rawReport,
                analysis
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
                rawReport,
                analysis
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
        return config.devices.find((device) => device.name === name)
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
    rawReport: string,
    analysis: { summary?: string; efficiency?: string; highlights?: string[]; risks?: string[]; suggestions?: string[]; tags?: string[]; rawText?: string }
): string {
    if (analysis.rawText && !analysis.summary) return analysis.rawText
    return [
        `# ${deviceName} 活动日报 ${date}`,
        '',
        `## AI 总结`,
        analysis.summary || '暂无分析',
        '',
        `## 效率评估`,
        analysis.efficiency || '暂无评估',
        '',
        `## 亮点`,
        formatMarkdownList(analysis.highlights),
        '',
        `## 风险`,
        formatMarkdownList(analysis.risks),
        '',
        `## 建议`,
        formatMarkdownList(analysis.suggestions),
        '',
        `## 原始数据`,
        rawReport
    ].join('\n')
}

function formatMarkdownList(items?: string[]): string {
    const list = items?.filter(Boolean) ?? []
    return list.length ? list.map((item) => `- ${item}`).join('\n') : '- 暂无'
}

function timeToCron(time: string): string | null {
    const match = time.match(/^(\d{1,2}):(\d{2})$/)
    if (!match) return null
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
    return `${minute} ${hour} * * *`
}

function isReservedSubcommand(value?: string): boolean {
    return ['原始', '周报', '列表', '日报列表', '设备信息', '健康'].includes(value || '')
}
