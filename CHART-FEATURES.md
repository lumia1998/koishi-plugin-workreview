# 图表功能详解

## 📊 整体架构

```
Work_Review API
    ↓
日报 Markdown (含 <details> 时间线)
    ↓
extractReportMetrics() 解析
    ↓
ActivityRenderer 渲染
    ↓
PNG 图片输出
```

---

## 🎨 视觉设计

### 主题风格
- **手账风格**：模拟纸质手账的温馨感
- **配色方案**：
  - 纸张背景：`#fdfbf7` (米白色)
  - 主墨色：`#5d4037` (深棕色)
  - 强调色：`#ff7043` (橙色)
  - 装饰色：蓝、粉、绿、紫等柔和色调

### 布局结构
```
┌─────────────────────────────────┐
│  📌 设备名称 + 日期              │
│  ⏰ 总活动时长                   │
├─────────────────────────────────┤
│  📊 24H 活跃轨迹图表             │
│  ├─ 图例 (Top 8 应用颜色)       │
│  ├─ 24 根柱状图 (00-23 点)      │
│  └─ 每根柱子显示分钟数           │
├─────────────────────────────────┤
│  🏆 Top 3 应用 + AI 点评         │
│  ├─ 排名 + 应用名 + 时长         │
│  └─ 个性化评论                   │
├─────────────────────────────────┤
│  📝 每日总结 (AI 分析)           │
└─────────────────────────────────┘
```

---

## 📈 核心图表：24 小时活跃轨迹

### 数据来源（优先级）

#### 1. **时间线数据**（新方案，优先使用）
```markdown
<details>
| 时间段 | 时长 | 应用 | 窗口 |
| 00:05-00:35 | 30分0秒 | Cursor | main.rs |
| 00:35-01:10 | 35分0秒 | Chrome | github.com |
...
</details>
```

**解析流程**：
```typescript
extractActivityTimeline(rawReport)
  ↓ 解析表格，提取每条记录
  ↓ { startTime: "00:05", endTime: "00:35", duration: "30分0秒", app: "Cursor", ... }
  ↓
buildHourlyDataFromTimeline(timeline)
  ↓ 将时间段映射到 24 小时
  ↓ 跨小时活动按比例分配
  ↓ 
{
  hourlyActivity: { hours: [3300, 3600, 300, ...], maxSeconds: 3600 },
  hourlyAppBreakdown: { 
    hours: [
      [{ app: "Cursor", seconds: 1800 }, { app: "Chrome", seconds: 1500 }],
      ...
    ]
  }
}
```

**跨小时分配示例**：
```
时间段: 00:35-01:10 (35分钟)
  ↓
00:00 小时: 25分钟 (00:35-01:00)
01:00 小时: 10分钟 (01:00-01:10)
```

#### 2. **旧解析方式**（回退方案）
如果没有 `<details>` 时间线，从文本中提取：
```markdown
- 主要活跃区间: 17:00-18:00（58分30秒）、19:00-20:00（52分0秒）
```
使用正则匹配 `(\d{1,2}):\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*[（(]([^）)]+)[）)]`

---

### 图表渲染逻辑

#### 柱状图生成 (`generateCombinedChart`)

```typescript
// 1. 判断是否使用应用分布数据
const useBreakdown = breakdown.maxSeconds > 0 && breakdown.hours.some(...)

// 2. 遍历 24 小时
hours.map((entries, hour) => {
  // 3. 计算该小时总活跃秒数
  const totalSeconds = entries.reduce((sum, e) => sum + e.seconds, 0)
  
  // 4. 计算柱子高度（相对于最大值的百分比）
  const percentage = (totalSeconds / maxSeconds) * 100
  const height = `max(4px, ${percentage}%)`
  
  // 5. 生成堆叠色块（如果有应用分布）
  const segments = entries
    .sort((a, b) => b.seconds - a.seconds)  // 按时长降序
    .map(entry => {
      const color = colorMap.get(entry.app) || '#ccc'
      const flex = entry.seconds / totalSeconds  // 占比
      return `<div style="flex: ${flex}; background: ${color};"></div>`
    })
  
  // 6. 显示分钟数标签
  const minutes = Math.round(totalSeconds / 60)
  return `<div class="chart-column">
    <div class="bar-value-top">${minutes}m</div>
    <div class="bar-stack" style="height: ${height};">${segments}</div>
    <div class="bar-label-x">${hour.padStart(2, '0')}</div>
  </div>`
})
```

#### 视觉特性

1. **高度归一化**
   - 最活跃的小时 = 100% 高度
   - 其他小时按比例缩放
   - 最小高度 4px（即使为 0 也显示底座）

2. **堆叠色块**
   - 每个应用占据柱子的一部分
   - 按时长降序排列（最长的在底部）
   - 使用 flexbox 自动分配比例

3. **交互提示**
   - `title` 属性显示详细信息
   - 例如：`"14:00 - 45分钟"`

4. **颜色映射**
   ```typescript
   const APP_COLORS = [
     '#ff7043', '#42a5f5', '#66bb6a', '#ab47bc',
     '#ffa726', '#26c6da', '#ec407a', '#8d6e63'
   ]
   // Top 8 应用按顺序分配颜色
   ```

---

## 🏆 Top 应用排行

### 数据提取
```typescript
extractTopApps(rawReport)
  ↓ 从 "应用使用明细" 表格解析
  ↓ 支持两种格式：
     1. 表格：| 1 | Cursor | 3小时45分0秒 |
     2. 列表：- Cursor: 3小时45分0秒
  ↓
[
  { name: "Cursor", duration: "3小时45分0秒" },
  { name: "Chrome", duration: "2小时30分0秒" },
  ...
]
```

### AI 点评生成

#### 1. **ChatLuna 分析**（优先）
```typescript
llm.analyze(deviceName, date, rawReport, topAppNames)
  ↓ 调用 ChatLuna 生成个性化点评
  ↓
{
  text: "今天主要围绕 Rust 项目开发...",
  appComments: [
    { name: "Cursor", comment: "深度编码时段，专注度很高" },
    { name: "Chrome", comment: "查资料和代码审查为主" }
  ]
}
```

#### 2. **回退点评**（如果 AI 失败）
```typescript
buildFallbackComment(appName, rank)
  ↓ 基于应用名称模式匹配
  ↓
- Chrome/Edge → "浏览器开得很勤，看来今天又在四处找答案。"
- VSCode/Cursor → "和代码缠斗的痕迹很明显，今天没少动脑。"
- QQ/微信 → "消息窗口常驻，注意力也被它顺手接管了。"
- Excel → "表格味很重，应该是在和数字认真较劲。"
- 默认 → "第{rank}名选手，今天存在感不低。"
```

### 渲染格式
```html
<div class="top-app-item">
  <div class="top-app-header">
    <span class="top-app-rank">1</span>
    <span class="top-app-name">Cursor</span>
    <span class="top-app-duration">3小时45分0秒</span>
  </div>
  <div class="top-app-comment">深度编码时段，专注度很高</div>
</div>
```

---

## 🎯 图例 (Legend)

### 功能
- 显示 Top 8 应用的颜色映射
- 帮助用户识别图表中的色块

### 生成逻辑
```typescript
generateLegend(topApps, colorMap)
  ↓
topApps.slice(0, 8).map(app => {
  const color = colorMap.get(app.name)
  return `
    <div class="legend-item">
      <span class="legend-dot" style="background:${color};"></span>
      <span class="legend-name">${app.name}</span>
    </div>
  `
})
```

### 样式
```css
.legend-item {
  display: inline-flex;
  align-items: center;
  margin-right: 12px;
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 4px;
}
```

---

## 📝 AI 总结卡片

### 数据来源
```typescript
llm.analyze(deviceName, date, rawReport, topAppNames)
  ↓ ChatLuna 生成完整分析
  ↓
{
  text: "今天主要围绕 Rust 项目开发展开，大量时间花在 Cursor 编辑器中..."
}
```

### 渲染
```html
<div class="summary-note">
  <div class="pin"></div>  <!-- 装饰性图钉 -->
  <div class="section-title">每日总结</div>
  <p>今天主要围绕 Rust 项目开发展开...</p>
</div>
```

### 截断逻辑（仅用于图片显示）
```typescript
truncateSummary(text, 200)
  ↓ 如果超过 200 字符，截断并加 "..."
  ↓ 完整内容仍然传给 ChatLuna（已取消截断）
```

---

## 🎨 主题切换

### 支持的主题
```typescript
config.theme: 'light' | 'dark' | 'auto'
```

### 暗色主题样式
```css
:root {
  --bg-paper: #1f1b24;
  --ink-primary: #f3e8ff;
  --ink-secondary: #d6c2e8;
}

.container, .chart-section, .summary-note {
  background: #2a2433;
}
```

### 应用逻辑
```typescript
applyTheme(css)
  ↓
if (theme === 'dark') {
  return css + darkTheme
} else if (theme === 'auto') {
  return css + `@media (prefers-color-scheme: dark) { ${darkTheme} }`
}
```

---

## 🔧 技术实现

### 渲染流程
```typescript
ActivityRenderer.render(data)
  ↓
1. 加载 HTML 模板和 CSS
2. 应用主题样式
3. 生成图表 HTML (generateCombinedChart)
4. 生成图例 (generateLegend)
5. 生成 Top 应用点评 (generateTopAppsComments)
6. 填充模板变量
  ↓
7. Puppeteer 渲染 HTML
8. 等待字体加载 (document.fonts.ready)
9. 截图 .container 元素
  ↓
10. 返回 PNG Buffer
```

### 性能优化
- **模板缓存**：HTML 和 CSS 只加载一次
- **字体预加载**：Google Fonts 使用 `preconnect`
- **超时保护**：字体加载最多等待 5 秒
- **资源清理**：每次渲染后关闭 Puppeteer 页面

---

## 📊 数据精度对比

### 旧方案（基于 top 3 活跃区间）
```
- 主要活跃区间: 17:00-18:00（58分30秒）、19:00-20:00（52分0秒）、00:00-01:00（45分20秒）
```
**问题**：
- ❌ 只有 3 个时段，其他 21 小时数据丢失
- ❌ 无法反映完整的活跃分布
- ❌ 图表会有大量空白

### 新方案（基于完整时间线）
```
<details>
| 00:05-00:35 | 30分0秒 | Cursor | ... |
| 00:35-01:10 | 35分0秒 | Chrome | ... |
| 14:00-14:30 | 30分0秒 | Cursor | ... |
... (156 条记录)
</details>
```
**优势**：
- ✅ 完整的 24 小时数据
- ✅ 每小时精确到分钟
- ✅ 应用分布准确
- ✅ 图表连续完整

---

## 🎯 使用场景

### 1. 日报生成
```bash
/活动日报 [设备名] [日期]
```
输出：PNG 图片 + AI 分析文本

### 2. 周报生成
```bash
/活动日报/周报 [设备名]
```
聚合最近 7 天数据，生成周报图表

### 3. 文本模式
```bash
/活动日报 -t [设备名] [日期]
```
只返回 AI 分析文本，不生成图片

### 4. 原始数据
```bash
/活动日报 -r [设备名] [日期]
```
返回未处理的 Markdown 日报

---

## 🔮 未来可能的改进

1. **更丰富的图表类型**
   - 热力图（颜色深浅表示活跃度）
   - 甘特图（显示连续工作区间）
   - 饼图（应用时长占比）

2. **交互式图表**
   - 点击柱子查看详细应用列表
   - 拖动时间轴查看不同时段
   - 导出为 SVG 或 HTML

3. **更多数据维度**
   - 网站访问热力图
   - 窗口切换频率
   - 专注度评分

4. **自定义配置**
   - 用户自定义颜色方案
   - 可配置的图表高度/宽度
   - 选择显示/隐藏的元素

---

## 📚 相关文件

- `src/renderer.ts` - 图表渲染核心逻辑
- `src/workreview.ts` - 数据解析和处理
- `resources/template.html` - HTML 模板
- `resources/style.css` - 样式表
- `src/llm.ts` - AI 分析集成
- `src/config.ts` - 配置定义

---

## 🎨 设计理念

**"让数据有温度"**

不是冷冰冰的统计图表，而是像翻开手账一样，回顾一天的工作轨迹。每个色块、每条评论，都在讲述你的故事。
