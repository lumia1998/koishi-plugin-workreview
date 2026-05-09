# Work_Review API 改动分析

## 📅 测试日期
- 2026-05-09

## 🔍 API 对比

### 1. `/v1/timeline/{date}` API

#### 数据结构
```json
{
  "id": 7176,
  "timestamp": 1778323343,
  "app_name": "QQ",
  "window_title": "QQ",
  "screenshot_path": "screenshots\\2026-05-09\\183510_336.jpg",
  "ocr_text": "...",
  "category": "communication",
  "duration": 2226,
  "browser_url": null,
  "executable_path": "D:\\QQNT\\QQ.exe",
  "semantic_category": "闲时通讯",
  "semantic_confidence": 98
}
```

#### 字段说明
- `id`: 记录唯一标识
- `timestamp`: Unix 时间戳（秒）
- `app_name`: 应用程序名称
- `window_title`: 窗口标题
- `screenshot_path`: 截图路径
- `ocr_text`: OCR 识别的文本内容（可能为 null）
- `category`: 活动分类（如 communication, entertainment, development）
- `duration`: 持续时长（秒）
- `browser_url`: 浏览器 URL（如果是浏览器，可能为 null）
- `executable_path`: 可执行文件路径
- `semantic_category`: 语义分类（中文）
- `semantic_confidence`: 语义分类置信度（0-100）

#### 数据量
- 2026-05-09: **64 条记录**
- 文件大小: **124KB**

---

### 2. `/v1/activities/{date}` API

#### 数据结构
```json
{
  "id": 7040,
  "timestamp": 1778298573,
  "app_name": "steam",
  "window_title": "Steam",
  "screenshot_path": "screenshots\\2026-05-09\\114915_854.jpg",
  "ocr_text": "...",
  "category": "entertainment",
  "duration": 17,
  "browser_url": null,
  "executable_path": "E:\\Steam\\steam.exe",
  "semantic_category": "娱乐休闲",
  "semantic_confidence": 98
}
```

#### 字段说明
**与 timeline API 完全相同**

#### 数据量
- 2026-05-09: **137 条记录**
- 文件大小: **277KB**

---

## 🔄 API 差异分析

### 数据结构
- ✅ **完全一致**: 两个 API 返回的字段结构完全相同
- ✅ **类型兼容**: 所有字段类型保持一致

### 数据量差异
| API | 记录数 | 文件大小 | 记录密度 |
|-----|--------|----------|----------|
| `/v1/timeline` | 64 | 124KB | 较少，聚合后的时间段 |
| `/v1/activities` | 137 | 277KB | 较多，原始活动记录 |

### 语义差异推测

#### `/v1/timeline` - 时间线视图
- **用途**: 展示连续的活动时间段
- **特点**: 
  - 记录数较少（64 条）
  - 可能是聚合后的数据
  - `duration` 字段较大（如 2226 秒 ≈ 37 分钟）
  - 适合生成时间轴视图

#### `/v1/activities` - 活动记录
- **用途**: 原始活动快照
- **特点**:
  - 记录数较多（137 条）
  - 可能是每次截图/采样的原始记录
  - `duration` 字段较小（如 17 秒）
  - 适合详细分析和统计

---

## 📊 当前插件使用情况

### 现有实现（基于旧 API）

#### 1. 数据来源
```typescript
// src/workreview.ts
async getReport(device: DeviceConfig, date: string): Promise<ReportResponse>
```
- 调用 `/v1/reports/{date}` 获取 **Markdown 格式的日报**
- 日报中包含 `<details>` 标签的活动时间线表格

#### 2. 数据解析
```typescript
// src/workreview.ts
extractActivityTimeline(rawReport: string): TimelineEntry[]
```
- 从 Markdown 的 `<details>` 表格中解析时间线
- 表格格式：
  ```markdown
  | 时间段 | 时长 | 应用 | 窗口 |
  | 00:05-00:35 | 30分0秒 | Cursor | main.rs |
  ```

#### 3. 图表生成
```typescript
// src/workreview.ts
buildHourlyDataFromTimeline(timeline: TimelineEntry[])
```
- 将时间线转换为 24 小时活跃数据
- 生成 `hourlyActivity` 和 `hourlyAppBreakdown`

---

## 🚀 迁移方案

### 方案 A: 直接使用 `/v1/timeline` API（推荐）

#### 优势
- ✅ 数据结构与现有解析逻辑高度匹配
- ✅ 记录数较少，处理更快
- ✅ 已经是聚合后的时间段，符合时间线语义
- ✅ 减少对 Markdown 解析的依赖

#### 改动点
1. **新增 API 方法**
   ```typescript
   // src/workreview.ts
   async getTimeline(device: DeviceConfig, date: string): Promise<TimelineEntry[]> {
     const data = await this.get(device, `/v1/timeline/${encodeURIComponent(date)}`)
     return data.map(item => ({
       startTime: formatTimestamp(item.timestamp),
       endTime: formatTimestamp(item.timestamp + item.duration),
       duration: formatDuration(item.duration),
       app: item.app_name,
       window: item.window_title
     }))
   }
   ```

2. **修改数据流程**
   ```typescript
   // src/index.ts
   async function generateReport(device: DeviceConfig, date: string) {
     // 旧方式：从 Markdown 解析
     // const report = await client.getReport(device, date)
     // const timeline = extractActivityTimeline(report.content)
     
     // 新方式：直接获取 JSON
     const timeline = await client.getTimeline(device, date)
     const metrics = buildHourlyDataFromTimeline(timeline)
     // ...
   }
   ```

3. **保留兼容性**
   ```typescript
   // 如果 timeline API 失败，回退到旧方式
   let timeline: TimelineEntry[]
   try {
     timeline = await client.getTimeline(device, date)
   } catch (error) {
     logger.warn('Timeline API 失败，回退到 Markdown 解析', error)
     const report = await client.getReport(device, date)
     timeline = extractActivityTimeline(report.content)
   }
   ```

#### 风险
- ⚠️ 需要确认 `duration` 字段是否准确（是否包含空闲时间）
- ⚠️ 需要测试跨小时活动的分配逻辑

---

### 方案 B: 使用 `/v1/activities` API

#### 优势
- ✅ 数据更原始，可以自定义聚合逻辑
- ✅ 可以实现更精细的分析（如窗口切换频率）

#### 劣势
- ❌ 记录数多，处理开销大
- ❌ 需要自己实现时间段聚合逻辑
- ❌ `duration` 字段较小，可能需要额外计算

#### 适用场景
- 需要更详细的活动分析
- 需要自定义聚合规则
- 需要分析窗口切换行为

---

### 方案 C: 混合使用（最灵活）

#### 策略
1. **日报生成**: 使用 `/v1/timeline`（快速、准确）
2. **详细分析**: 使用 `/v1/activities`（深度、灵活）
3. **回退机制**: 保留 Markdown 解析（兼容旧版本）

#### 实现
```typescript
interface DataSource {
  type: 'timeline' | 'activities' | 'markdown'
  data: TimelineEntry[]
}

async function fetchActivityData(
  device: DeviceConfig, 
  date: string,
  preferredSource: 'timeline' | 'activities' = 'timeline'
): Promise<DataSource> {
  try {
    if (preferredSource === 'timeline') {
      const data = await client.getTimeline(device, date)
      return { type: 'timeline', data }
    } else {
      const data = await client.getActivities(device, date)
      const aggregated = aggregateActivities(data) // 自定义聚合
      return { type: 'activities', data: aggregated }
    }
  } catch (error) {
    // 回退到 Markdown
    const report = await client.getReport(device, date)
    const data = extractActivityTimeline(report.content)
    return { type: 'markdown', data }
  }
}
```

---

## 🎯 推荐方案

### **方案 A + 兼容性保留**

#### 理由
1. **最小改动**: 只需新增 API 方法，不改变核心逻辑
2. **性能提升**: 直接使用 JSON，避免 Markdown 解析
3. **向后兼容**: 保留旧方式作为回退
4. **未来扩展**: 为方案 C 打下基础

#### 实施步骤
1. ✅ **Phase 1**: 新增 `/v1/timeline` API 方法
2. ✅ **Phase 2**: 修改数据获取流程，优先使用新 API
3. ✅ **Phase 3**: 添加回退机制
4. ✅ **Phase 4**: 测试验证（对比新旧数据一致性）
5. 🔮 **Phase 5**: （可选）新增 `/v1/activities` 支持

---

## 🧪 测试计划

### 1. 数据一致性测试
```bash
# 对比同一天的数据
旧方式: /v1/reports/2026-05-09 → Markdown 解析
新方式: /v1/timeline/2026-05-09 → JSON 直接使用

对比指标:
- 24 小时活跃分钟数
- Top 应用排行
- 总活跃时长
```

### 2. 性能测试
```bash
测试场景: 生成 7 天周报
旧方式: 7 次 Markdown 解析
新方式: 7 次 JSON 解析

对比指标:
- 响应时间
- 内存占用
- CPU 使用率
```

### 3. 边界测试
```bash
- 空数据日期（无活动记录）
- 跨午夜活动（23:50-00:10）
- 单应用长时间使用（>8 小时）
- 高频切换应用（>100 次/小时）
```

---

## 📝 待确认问题

### 1. API 语义
- ❓ `/v1/timeline` 的 `duration` 是否包含空闲时间？
- ❓ 两个 API 的 `timestamp` 是活动开始还是结束时间？
- ❓ 是否有 API 文档或 OpenAPI 规范？

### 2. 数据准确性
- ❓ `/v1/timeline` 的聚合逻辑是什么？
- ❓ 如何处理重叠的活动记录？
- ❓ `semantic_category` 的分类规则是什么？

### 3. 兼容性
- ❓ 旧版本 Work_Review 是否支持这两个 API？
- ❓ 是否需要版本检测？
- ❓ 是否有 API 版本号？

---

## 🔗 相关文件

- `src/workreview.ts` - API 客户端和数据解析
- `src/index.ts` - 主逻辑和命令处理
- `src/renderer.ts` - 图表渲染
- `CHART-FEATURES.md` - 图表功能详解
- `CHANGELOG-timeline.md` - 时间线改进记录

---

## 📌 总结

### 核心发现
1. **新 API 结构清晰**: JSON 格式，字段完整
2. **数据量差异明显**: timeline (64) vs activities (137)
3. **语义明确**: timeline 适合时间轴，activities 适合详细分析
4. **向后兼容**: 可以保留 Markdown 解析作为回退

### 下一步行动
1. 🎯 **优先**: 实现方案 A（使用 `/v1/timeline`）
2. 🧪 **测试**: 验证数据一致性和性能
3. 📚 **文档**: 更新 API 使用说明
4. 🔮 **未来**: 考虑支持 `/v1/activities` 用于高级分析
