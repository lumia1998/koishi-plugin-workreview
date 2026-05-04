import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { ComputedRef } from 'koishi-plugin-chatluna'
import type { Config } from './config.js'

export interface ActivityAnalysis {
    summary?: string
    efficiency?: string
    workPattern?: string
    focusAnalysis?: string
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
            '请根据用户提供的 Work_Review 原始活动日报进行深入分析。',
            '要求：',
            '- 必须使用中文。',
            '- 不要重复原始表格，重点给出洞察。',
            '- 如果数据明显偏娱乐或样本不足，也要如实指出。',
            '- summary 应为 2-3 句话的综合总结，涵盖当天整体活动状态和关键发现。',
            '- efficiency 应详细评估专注度、时间利用率，并引用具体时间段或应用数据。',
            '- workPattern 应分析工作时间分布规律，如是否集中、是否有规律的休息等。',
            '- focusAnalysis 应分析专注与分心的切换情况，指出长时间连续使用和频繁切换的时段。',
            '- highlights 每条应为完整的观察描述，不要只写几个字。',
            '- risks 应指出具体的问题和潜在影响。',
            '- suggestions 应给出可执行的具体建议。',
            '- 输出必须是纯 JSON 对象，不要包裹 markdown 代码块。',
            '',
            '请返回以下 JSON：',
            '{',
            '  "summary": "2-3句话综合总结当天活动状态和关键发现",',
            '  "efficiency": "详细的效率和专注度评估，引用具体数据",',
            '  "workPattern": "工作时间分布规律分析",',
            '  "focusAnalysis": "专注与分心切换分析",',
            '  "highlights": ["完整的值得肯定的观察描述"],',
            '  "risks": ["具体的潜在问题及影响"],',
            '  "suggestions": ["可执行的具体建议"],',
            '  "tags": ["标签1", "标签2", "标签3"]',
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
        let cleaned = text.trim()
        cleaned = cleaned.replace(/```(?:json|JSON)?\s*/g, '').replace(/```\s*$/g, '')
        const start = cleaned.indexOf('{')
        const end = cleaned.lastIndexOf('}')
        if (start !== -1 && end !== -1 && start < end) {
            cleaned = cleaned.substring(start, end + 1)
        }
        try {
            const parsed = JSON.parse(cleaned) as ActivityAnalysis
            if (typeof parsed === 'object' && parsed !== null) return parsed
        } catch { /* fall through */ }
        return { rawText: text }
    }
}
