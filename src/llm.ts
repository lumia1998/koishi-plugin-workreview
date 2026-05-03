import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
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

        const systemPrompt = [
            this.config.stylePrompt,
            '',
            '请根据用户提供的 Work_Review 原始活动日报进行分析。',
            '要求：',
            '- 必须使用中文。',
            '- 不要重复原始表格，重点给出洞察。',
            '- 如果数据明显偏娱乐或样本不足，也要如实指出。',
            '- 输出必须是纯 JSON 对象，不要包裹 markdown 代码块。',
            '',
            '请返回以下 JSON：',
            '{',
            '  "summary": "一句话总结当天活动状态",',
            '  "efficiency": "对效率和专注度的评估",',
            '  "highlights": ["值得肯定或有价值的观察"],',
            '  "risks": ["潜在问题或异常"],',
            '  "suggestions": ["下一步建议"],',
            '  "tags": ["标签1", "标签2"]',
            '}'
        ].join('\n')

        const result = await model.invoke(
            [
                new SystemMessage(systemPrompt),
                new HumanMessage(`设备：${deviceName}\n日期：${date}\n\n原始日报：\n${rawReport}`)
            ],
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
