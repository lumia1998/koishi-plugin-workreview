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
    reportDate: 'today' | 'yesterday'
    enabled: boolean
}

export interface Config {
    devices: DeviceConfig[]
    pushes: PushConfig[]
    model: string
    temperature: number
    stylePrompt: string
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
    reportDate: Schema.union([
        Schema.const('yesterday').description('昨天（推荐）'),
        Schema.const('today').description('今天')
    ])
        .default('yesterday')
        .description('推送哪天的日报'),
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
        stylePrompt: Schema.string()
            .role('textarea')
            .default('你是一个活泼的日报总结助手。用轻松口语化的方式总结用户一天做了什么，可以适当吐槽。')
            .description('AI 总结风格/人设描述。控制输出的语气和风格。')
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
