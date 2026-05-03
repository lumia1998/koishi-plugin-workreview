import { Schema } from 'koishi'

export interface DeviceConfig {
    name: string
    host: string
    port: number
    protocol: 'http' | 'https'
    token?: string
}

export interface PushConfig {
    device: string
    channels: string[]
    time: string
    enabled: boolean
}

export interface Config {
    devices: DeviceConfig[]
    pushes: PushConfig[]
    model: string
    temperature: number
    analysisPrompt: string
    commandName: string
    outputMode: 'image' | 'text' | 'both'
    theme: 'light' | 'dark' | 'auto'
    timeout: number
    autoGenerateMissingReport: boolean
}

const DeviceConfig: Schema<DeviceConfig> = Schema.object({
    name: Schema.string().required().description('设备备注名，例如：家'),
    host: Schema.string().required().description('设备 IP 或域名，例如：10.1.2.200'),
    port: Schema.number().default(47831).description('Work_Review API 端口'),
    protocol: Schema.union([
        Schema.const('http').description('HTTP'),
        Schema.const('https').description('HTTPS')
    ])
        .default('http')
        .description('请求协议'),
    token: Schema.string().role('secret').description('Work_Review API Token')
})

const PushConfig: Schema<PushConfig> = Schema.object({
    device: Schema.string().required().description('设备备注名'),
    channels: Schema.array(String)
        .role('table')
        .default([])
        .description('推送目标频道 ID / 群号'),
    time: Schema.string()
        .default('22:00')
        .description('每天推送时间，格式 HH:mm'),
    enabled: Schema.boolean().default(true).description('是否启用')
})

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        devices: Schema.array(DeviceConfig)
            .role('table')
            .default([])
            .description('Work_Review 设备列表'),
        pushes: Schema.array(PushConfig)
            .role('table')
            .default([])
            .description('定时推送规则'),
        commandName: Schema.string().default('活动日报').description('根命令名称'),
        autoGenerateMissingReport: Schema.boolean()
            .default(true)
            .description('日报不存在时是否自动调用生成接口')
    }).description('基础设置'),
    Schema.object({
        model: Schema.dynamic('model').description('用于分析日报的 ChatLuna 模型'),
        temperature: Schema.number()
            .min(0)
            .max(2)
            .default(0.8)
            .description('模型温度'),
        analysisPrompt: Schema.string()
            .role('textarea')
            .default(`你是一个工作活动分析助手。请根据 Work_Review 采集到的原始活动日报，分析这一天的工作/娱乐/切换情况。

要求：
- 必须使用中文。
- 不要重复原始表格，重点给出洞察。
- 如果数据明显偏娱乐或样本不足，也要如实指出。
- 输出必须是 JSON 对象，不要包裹 markdown 代码块。

设备：{deviceName}
日期：{date}

原始日报：
{rawReport}

请返回以下 JSON：
{
  "summary": "一句话总结当天活动状态",
  "efficiency": "对效率和专注度的评估",
  "highlights": ["值得肯定或有价值的观察"],
  "risks": ["潜在问题或异常"],
  "suggestions": ["下一步建议"],
  "tags": ["标签1", "标签2"]
}`)
            .description('AI 分析提示词。可用变量：{deviceName}、{date}、{rawReport}')
    }).description('ChatLuna 设置'),
    Schema.object({
        outputMode: Schema.union([
            Schema.const('image').description('图片'),
            Schema.const('text').description('文本'),
            Schema.const('both').description('图片 + 文本')
        ])
            .default('image')
            .description('默认输出格式'),
        theme: Schema.union([
            Schema.const('light').description('亮色'),
            Schema.const('dark').description('暗色'),
            Schema.const('auto').description('自动')
        ])
            .default('auto')
            .description('图片主题'),
        timeout: Schema.number()
            .min(1000)
            .default(30000)
            .description('API 请求超时时间（毫秒）')
    }).description('输出设置')
]) as unknown as Schema<Config>
