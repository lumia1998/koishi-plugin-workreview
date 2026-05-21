import { StructuredTool } from '@langchain/core/tools'
import type { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager'
import { z } from 'zod'
import type { Context } from 'koishi'
import type { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { Config } from './config.js'
import { ActivityLLM } from './llm.js'
import { WorkReviewClient, findLatestScreenSnapshot } from './workreview.js'
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

        const activities = await this.client.getTimeline(device, today())
        const snapshot = findLatestScreenSnapshot(activities)
        if (!snapshot) return `没有找到 ${device.name} 今天可分析的屏幕截图。`

        return this.llm.analyzeCurrentScreen(device.name, snapshot)
    }

    private resolveDevice(deviceName?: string) {
        if (deviceName) return this.config.devices.find((device) => device.name === deviceName)
        return this.config.devices[0]
    }
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
