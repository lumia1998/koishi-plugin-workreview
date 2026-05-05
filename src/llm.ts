import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { ComputedRef } from 'koishi-plugin-chatluna'
import type { Config } from './config.js'

export interface ActivityAnalysis {
    text: string
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
        rawReport: string
    ): Promise<ActivityAnalysis> {
        const modelRef = await this.loadModel()
        const model = modelRef.value
        if (!model) throw new Error('ChatLuna 模型未就绪，请检查模型配置。')

        const systemPrompt = [
            this.config.stylePrompt,
            '',
            '请根据用户提供的 Work_Review 原始活动日报，用你的风格总结用户这一天都做了什么。',
            '要求：',
            '- 必须使用中文。',
            '- 不要重复原始表格数据，用自己的话概括。',
            '- 不要分类（不要写”亮点/风险/建议/效率评估”之类的标题）。',
            '- 直接输出一段连贯的总结文本，像在跟用户聊天一样。',
            '- 如果数据明显偏娱乐或样本不足，也可以吐槽。',
            '- 不要输出 JSON，不要用 markdown 格式，直接输出纯文本。'
        ].join('\n')

        const result = await model.invoke(
            [
                new SystemMessage(systemPrompt),
                new HumanMessage(`设备：${deviceName}\n日期：${date}\n\n原始日报：\n${rawReport}`)
            ],
            { temperature: this.config.temperature }
        )

        const text = getMessageContent(result.content)
        return { text: text.trim() }
    }
}
