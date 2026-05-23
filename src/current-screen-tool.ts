import { StructuredTool } from '@langchain/core/tools'
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager'
import { z } from 'zod'
import type { Context } from 'koishi'
import type { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { Config } from './config.js'
import { ActivityLLM } from './llm.js'
import { WorkReviewClient, findLatestScreenSnapshot, type ScreenSnapshot } from './workreview.js'
import { today } from './utils.js'

const CurrentScreenInputSchema = z.object({
    device: z.string().optional().describe('Work_Review 设备备注名。未提供时使用插件配置中的第一个设备。')
})

type CurrentScreenInput = z.infer<typeof CurrentScreenInputSchema>

class CurrentScreenTool extends StructuredTool<typeof CurrentScreenInputSchema> {
    name = 'get_current_screen_context'
    description = '查看用户当前屏幕截图并分析用户正在做什么。适合回答“我在干嘛”“用户现在在做什么”“当前屏幕是什么内容”等问题。'
    schema = CurrentScreenInputSchema

    constructor(
        private ctx: Context,
        private config: Config,
        private client: WorkReviewClient,
        private llm: ActivityLLM
    ) {
        super()
    }

    protected async _call(
        input: CurrentScreenInput,
        _runManager?: CallbackManagerForToolRun,
        _parentConfig?: ChatLunaToolRunnable
    ): Promise<string> {
        const device = this.resolveDevice(input.device)
        if (!device) return '还没有配置 Work_Review 设备，无法查看当前屏幕。'

        let activities
        try {
            activities = await this.client.getTimeline(device, today())
        } catch (error) {
            return this.formatTimelineError(device.name, error)
        }

        const snapshot = findLatestScreenSnapshot(activities)
        if (!snapshot) return `没有找到 ${device.name} 今天可分析的屏幕截图。`

        try {
            return await this.llm.analyzeCurrentScreen(device.name, snapshot)
        } catch (error) {
            return this.formatSnapshotFallback(device.name, snapshot, error)
        }
    }

    private resolveDevice(deviceName?: string) {
        if (deviceName) return this.config.devices.find((device) => device.name === deviceName)
        return this.config.devices[0]
    }

    private formatTimelineError(deviceName: string, error: unknown): string {
        const message = getErrorMessage(error)
        if (message.includes('HTTP 401')) {
            return [
                `读取 ${deviceName} 当前屏幕失败：Work_Review API 返回 401。`,
                '这通常表示插件里该设备的 token 未配置、配置错了，或 Work_Review 端已经更换 token。',
                '请检查插件设备配置里的 token 是否和 Work_Review 设置页一致。'
            ].join('\n')
        }

        return [
            `读取 ${deviceName} 当前屏幕失败：${message}`,
            '如果 Work_Review 已开启 token，请确认插件设备配置里填写了正确 token。'
        ].join('\n')
    }

    private formatSnapshotFallback(deviceName: string, snapshot: ScreenSnapshot, error: unknown): string {
        return [
            `已拿到 ${deviceName} 的最新屏幕截图，但模型图片分析失败：${getErrorMessage(error)}`,
            '',
            '当前屏幕上下文：',
            `- 应用：${snapshot.appName || '未知'}`,
            `- 窗口标题：${snapshot.windowTitle || '未知'}`,
            `- 分类：${snapshot.category || '未知'}`,
            `- 截图地址：${snapshot.screenshotUrl}`,
            snapshot.ocrText ? `- OCR 摘要：${clip(snapshot.ocrText, 1200)}` : '- OCR 摘要：无'
        ].join('\n')
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function clip(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim()
    if (text.length <= maxLength) return text
    return `${text.slice(0, maxLength)}...`
}

export function registerCurrentScreenTool(
    ctx: Context,
    config: Config,
    client: WorkReviewClient,
    llm: ActivityLLM
): void {
    if (!config.enableCurrentScreenTool) return

    ctx.effect(() => ctx.chatluna.platform.registerTool('get_current_screen_context', {
        description: '查看用户当前屏幕截图并分析用户正在做什么。',
        selector() {
            return true
        },
        createTool() {
            return new CurrentScreenTool(ctx, config, client, llm)
        },
        meta: {
            source: 'extension',
            group: 'workreview',
            tags: ['workreview', 'activitywatch', 'screen'],
            defaultAvailability: {
                enabled: true,
                main: true,
                chatluna: true,
                characterScope: 'all'
            }
        }
    }))
}
