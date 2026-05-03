import { Context } from 'koishi'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { ComputedRef } from 'koishi-plugin-chatluna'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { Config } from './config'

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
    private model?: ComputedRef<ChatLunaChatModel | undefined>

    constructor(
        private ctx: Context,
        private config: Config
    ) {}

    async analyze(
        deviceName: string,
        date: string,
        rawReport: string
    ): Promise<ActivityAnalysis> {
        const modelRef = await this.loadModel()
        const model = modelRef.value
        if (!model) throw new Error(`未找到 ChatLuna 模型 ${this.config.model}`)

        const prompt = this.config.analysisPrompt
            .replaceAll('{deviceName}', deviceName)
            .replaceAll('{date}', date)
            .replaceAll('{rawReport}', rawReport)

        const response = await model.caller.call(() =>
            model.invoke(prompt, { temperature: this.config.temperature ?? 0.8 })
        )
        const text = getMessageContent(response.content)
        return parseAnalysis(text)
    }

    private async loadModel(): Promise<ComputedRef<ChatLunaChatModel | undefined>> {
        if (!this.model) {
            this.model = await this.ctx.chatluna.createChatModel(this.config.model)
        }
        return this.model
    }
}

export function parseAnalysis(text: string): ActivityAnalysis {
    for (const extractor of extractors) {
        const candidate = extractor(text)
        const parsed = tryParse(candidate)
        if (parsed) return normalizeAnalysis(parsed, text)
    }

    return { rawText: text }
}

function normalizeAnalysis(value: unknown, rawText: string): ActivityAnalysis {
    if (!value || typeof value !== 'object') return { rawText }
    const record = value as Record<string, unknown>
    return {
        summary: toStringValue(record.summary),
        efficiency: toStringValue(record.efficiency),
        highlights: toStringArray(record.highlights),
        risks: toStringArray(record.risks),
        suggestions: toStringArray(record.suggestions),
        tags: toStringArray(record.tags),
        rawText
    }
}

function toStringValue(value: unknown): string | undefined {
    if (value == null) return undefined
    return String(value)
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.map((item) => String(item)).filter(Boolean)
}

function tryParse(text: string): unknown | null {
    try {
        return JSON.parse(text.trim())
    } catch {
        return null
    }
}

const extractors = [
    (text: string) => text.trim(),
    (text: string) =>
        text.replace(/```(?:json|JSON)?\s*/g, '').replace(/```\s*$/g, ''),
    (text: string) => {
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        return start !== -1 && end !== -1 && start < end
            ? text.substring(start, end + 1)
            : text
    },
    (text: string) => {
        const start = text.indexOf('{')
        if (start === -1) return text
        let depth = 0
        for (let i = start; i < text.length; i++) {
            if (text[i] === '{') depth++
            if (text[i] === '}') depth--
            if (depth === 0) return text.slice(start, i + 1)
        }
        return text
    }
]
