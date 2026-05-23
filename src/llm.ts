import { Context } from 'koishi'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import type { ComputedRef } from 'koishi-plugin-chatluna'
import type { Config } from './config.js'
import type { ScreenSnapshot } from './workreview.js'

export interface AppComment {
    name: string
    comment: string
}

export interface ActivityAnalysis {
    text: string
    appComments: AppComment[]
    siteComments: AppComment[]
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
        topApps?: string[],
        browserSites?: string[],
        reportType: 'day' | 'week' = 'day'
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

        const browserCommentInstruction = browserSites?.length
            ? [
                '',
                `再对以下最常访问的网站各写一句简短锐评（10-20字，幽默吐槽风格，根据域名和上下文判断网站用途）：`,
                ...browserSites.map((site, i) => `${i + 1}. ${site}`),
                '',
                '在应用锐评之后，用以下格式输出网站锐评（每行一个）：',
                '---SITE_COMMENTS---',
                ...browserSites.map((site) => `${site}: 你的锐评`),
            ]
            : []

        const systemPrompt = [
            this.config.stylePrompt,
            '',
            reportType === 'week' ? '请根据用户提供的活动数据摘要，用你的风格总结用户这一周都做了什么。'
                : '请根据用户提供的活动数据摘要，用你的风格总结用户这一天都做了什么。',
            '要求：',
            '- 必须使用中文。',
            '- 不要重复原始数据，用自己的话概括。',
            '- 不要分类（不要写”亮点/风险/建议/效率评估”之类的标题）。',
            '- 直接输出一段连贯的总结文本，像在跟用户聊天一样。',
            '- 如果数据明显偏娱乐或样本不足，也可以吐槽。',
            '- 用 **双星号** 包裹关键数据和重点信息（如时长、时间点、关键行为），方便用户快速扫读。',
            '- 最后一段如果有建议，请以”建议”二字开头。',
            '- 不要输出 JSON，不要用 markdown 格式（除了加粗），直接输出纯文本。',
            ...appCommentInstruction,
            ...browserCommentInstruction
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
        return this.parseAnalysisResponse(raw, topApps || [], browserSites || [])
    }

    async analyzeCurrentScreen(
        deviceName: string,
        snapshot: ScreenSnapshot
    ): Promise<string> {
        const modelRef = await this.loadModel()
        const model = modelRef.value
        if (!model) throw new Error('ChatLuna 模型未就绪，请检查模型配置。')

        const systemPrompt = [
            '你会根据一张当前屏幕截图判断用户正在做什么。',
            '要求：',
            '- 必须使用中文。',
            '- 只描述截图中能直接看出的内容，不要臆测敏感信息。',
            '- 如果截图内容不清晰或无法访问，就直接说明无法判断。',
            '- 回复控制在 80 字以内，像在回答“我在干嘛？”一样自然。'
        ].join('\n')

        const text = [
            `设备：${deviceName}`,
            `应用：${snapshot.appName}`,
            `窗口标题：${snapshot.windowTitle || '未知'}`,
            `分类：${snapshot.category || '未知'}`,
            '',
            '请结合这张截图，简短说明用户当前可能正在做什么。'
        ].join('\n')

        const result = await Promise.race([
            model.invoke(
                [
                    new SystemMessage(systemPrompt),
                    new HumanMessage({
                        content: [
                            { type: 'text', text },
                            { type: 'image_url', image_url: { url: snapshot.screenshotUrl } }
                        ]
                    })
                ],
                { temperature: Math.min(this.config.temperature, 0.8) }
            ),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('当前屏幕分析超时')), 60000)
            )
        ])

        return getMessageContent(result.content).trim()
    }


    private parseAnalysisResponse(raw: string, topApps: string[], browserSites: string[]): ActivityAnalysis {
        const appMarker = '---APP_COMMENTS---'
        const siteMarker = '---SITE_COMMENTS---'

        const appMarkerIndex = raw.indexOf(appMarker)
        if (appMarkerIndex < 0) {
            return { text: raw, appComments: [], siteComments: [] }
        }

        const text = raw.slice(0, appMarkerIndex).trim()
        const afterAppMarker = raw.slice(appMarkerIndex + appMarker.length).trim()

        let appSection: string
        let siteSection = ''
        const siteMarkerIndex = afterAppMarker.indexOf(siteMarker)
        if (siteMarkerIndex >= 0) {
            appSection = afterAppMarker.slice(0, siteMarkerIndex).trim()
            siteSection = afterAppMarker.slice(siteMarkerIndex + siteMarker.length).trim()
        } else {
            appSection = afterAppMarker
        }

        const appComments = this.parseCommentLines(appSection, topApps, 5)
        const siteComments = this.parseCommentLines(siteSection, browserSites, 5)

        return { text, appComments, siteComments }
    }

    private parseCommentLines(section: string, names: string[], limit: number): AppComment[] {
        if (!section) return []
        return section
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
            .filter((item) => item.name && item.comment && names.some(
                (n) => item.name.includes(n) || n.includes(item.name)
            ))
            .slice(0, limit)
    }
}
