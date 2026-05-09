import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { ComputedRef } from 'koishi-plugin-chatluna'
import type { Config } from './config.js'

export interface AppComment {
    name: string
    comment: string
}

export interface ActivityAnalysis {
    text: string
    appComments: AppComment[]
}

export class ActivityLLM {
    private model: ComputedRef<ChatLunaChatModel | undefined> | null = null
    private modelName: string | null = null

    constructor(
        private ctx: Context,
        private config: Config
    ) {}

    private async loadModel(): Promise<ComputedRef<ChatLunaChatModel | undefined>> {
        if (this.model && this.modelName === this.config.model) return this.model
        this.model = await this.ctx.chatluna.createChatModel(this.config.model)
        this.modelName = this.config.model
        return this.model
    }

    async analyze(
        deviceName: string,
        date: string,
        activitySummary: string,
        topApps?: string[]
    ): Promise<ActivityAnalysis> {
        const modelRef = await this.loadModel()
        const model = modelRef.value
        if (!model) throw new Error('ChatLuna 模型未就绪，请检查模型配置。')

        const appCommentInstruction = topApps?.length
            ? [
                '',
                `另外，请对以下使用最多的应用各写一句简短锐评（10-20字，幽默吐槽风格）：`,
                ...topApps.map((app, i) => `${i + 1}. ${app}`),
                '',
                '在总结文本之后，用以下格式输出锐评（每行一个）：',
                '---APP_COMMENTS---',
                ...topApps.map((app) => `${app}: 你的锐评`),
            ]
            : []

        const systemPrompt = [
            this.config.stylePrompt,
            '',
            '请根据用户提供的活动数据摘要，用你的风格总结用户这一天都做了什么。',
            '要求：',
            '- 必须使用中文。',
            '- 不要重复原始数据，用自己的话概括。',
            '- 不要分类（不要写”亮点/风险/建议/效率评估”之类的标题）。',
            '- 直接输出一段连贯的总结文本，像在跟用户聊天一样。',
            '- 如果数据明显偏娱乐或样本不足，也可以吐槽。',
            '- 不要输出 JSON，不要用 markdown 格式，直接输出纯文本。',
            ...appCommentInstruction
        ].join('\n')

        const result = await Promise.race([
            model.invoke(
                [
                    new SystemMessage(systemPrompt),
                    new HumanMessage(`设备：${deviceName}\n日期：${date}\n\n活动摘要：\n${activitySummary}`)
                ],
                { temperature: this.config.temperature }
            ),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('AI 分析超时')), 60000)
            )
        ])

        const raw = getMessageContent(result.content).trim()
        return this.parseAnalysisResponse(raw, topApps || [])
    }

    private parseAnalysisResponse(raw: string, topApps: string[]): ActivityAnalysis {
        const marker = '---APP_COMMENTS---'
        const markerIndex = raw.indexOf(marker)

        if (markerIndex < 0) {
            return { text: raw, appComments: [] }
        }

        const text = raw.slice(0, markerIndex).trim()
        const commentsSection = raw.slice(markerIndex + marker.length).trim()
        const appComments = commentsSection
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.includes(':') || line.includes('：'))
            .map((line) => {
                const sep = line.indexOf('：') >= 0 ? '：' : ':'
                const idx = line.indexOf(sep)
                const name = line.slice(0, idx).trim()
                const comment = line.slice(idx + sep.length).trim()
                return { name, comment }
            })
            .filter((item) => item.name && item.comment && topApps.some(
                (app) => item.name.includes(app) || app.includes(item.name)
            ))
            .slice(0, 3)

        return { text, appComments }
    }
}
