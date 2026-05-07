# 活动时间线图表改进

## 修改内容

### 1. 取消 AI 分析截断
- **文件**: `src/index.ts`
- **改动**: 移除了 `truncateRawReport()` 的调用，现在 API 返回的完整内容（包括 AI 分析）会传给 ChatLuna
- **影响**: 用户可以获得完整的 AI 分析内容，不再被截断

### 2. 新增活动时间线解析
- **文件**: `src/workreview.ts`
- **新增接口**: `TimelineEntry` - 表示单条时间线记录
- **新增函数**: 
  - `extractActivityTimeline()` - 从 `<details>` 表格中解析时间线数据
  - `buildHourlyDataFromTimeline()` - 将时间线转换为 24 小时活跃数据

### 3. 基于时间线重建 24 小时活跃图表
- **文件**: `src/workreview.ts`
- **改动**: `extractReportMetrics()` 现在优先使用时间线数据重建小时活跃度
- **逻辑**:
  1. 首先尝试解析 `<details>` 中的活动时间线表格
  2. 将每个时间段按小时拆分，计算每小时的活跃秒数
  3. 跨小时的活动按时间比例分配到各个小时
  4. 如果时间线数据无效，回退到旧的解析方式（兼容性保证）

### 4. 图表渲染保持不变
- **文件**: `src/renderer.ts`
- **说明**: 图表渲染逻辑无需修改，自动使用新的 `hourlyAppBreakdown` 数据

## 数据流程

```
API 日报内容
  ↓
<details> 活动时间线表格
  ↓
extractActivityTimeline() 解析
  ↓
buildHourlyDataFromTimeline() 重建
  ↓
24 小时活跃数据 (hourlyActivity + hourlyAppBreakdown)
  ↓
图表渲染 (generateCombinedChart)
```

## 优势

1. **更准确**: 基于完整的活动时间线，而不是 top 3 活跃区间
2. **更完整**: 24 小时每小时都有数据，不会丢失信息
3. **更详细**: 每小时的应用分布更精确
4. **向后兼容**: 如果没有时间线数据，自动回退到旧的解析方式

## 测试验证

使用 `sample-report-2026-05-06.md` 测试：
- ✓ 成功解析 22 条时间线记录
- ✓ 正确计算 24 小时活跃分钟数
- ✓ 准确分配跨小时活动
- ✓ 应用分布数据正确

## 示例输出

```
00:00 - 55分钟 (Cursor: 30分钟, Chrome: 25分钟)
01:00 - 60分钟 (Chrome: 10分钟, Cursor: 50分钟)
14:00 - 60分钟 (Cursor: 30分钟, Chrome: 30分钟)
...
```
