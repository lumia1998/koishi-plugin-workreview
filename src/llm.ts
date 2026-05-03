import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { SystemMessage } from '@langchain/core/messages'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { ComputedRef } from 'koishi-plugin-chatluna'
import type { Config } from './config.js'

export interface ActivityAnalysis {
    summary?: string
    efficiency?: string
    highlights?: string[]
    risks?: string[]
    suggestions?: string[]
    tags?: string[]
    rawText?: string
}

export class ActivityLLM {
    private model: ComputedRef<ChatLunaChatModel | undefined> | null = null

    constructor(
        private ctx: Context,
        private config: Config
    ) {}

    private async loadModel(): Promise<ComputedRef<ChatLunaChatModel | undefined>> {
        if (this.model) return this.model
        this.model = await this.ctx.chatluna.createChatModel(this.config.model)
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

        const prompt = this.config.analysisPrompt
            .replace(/\{deviceName\}/g, deviceName)
            .replace(/\{date\}/g, date)
            .replace(/\{rawReport\}/g, rawReport)

        const result = await model.invoke(
            [new SystemMessage(prompt)],
            { temperature: this.config.temperature }
        )

        const text = getMessageContent(result.content)
        return this.parseAnalysis(text)
    }

    private parseAnalysis(text: string): ActivityAnalysis {
        const extractors = [
            (t: string) => t.trim(),
            (t: string) =>
                t.replace(/```(?:json|JSON)?\s*/g, '').replace(/```\s*$/g, ''),
            (t: string) => {
                const start = t.indexOf('{')
                const end = t.lastIndexOf('}')
                return start !== -1 && end !== -1 && start < end
                    ? t.substring(start, end + 1)
                    : t
            }
        ]

        for (const extract of extractors) {
            try {
                const cleaned = extract(text)
                const parsed = JSON.parse(cleaned) as ActivityAnalysis
                if (typeof parsed === 'object' && parsed !== null) return parsed
            } catch {
                continue
            }
        }

        return { rawText: text }
    }
}
