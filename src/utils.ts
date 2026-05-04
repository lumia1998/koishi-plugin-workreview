export function formatDate(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export function today(): string {
    return formatDate(new Date())
}

export function yesterday(): string {
    const date = new Date()
    date.setDate(date.getDate() - 1)
    return formatDate(date)
}

export function previousDates(endDate: string, days: number): string[] {
    const [year, month, day] = endDate.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    return Array.from({ length: days }, (_, index) => {
        const current = new Date(date)
        current.setDate(date.getDate() - index)
        return formatDate(current)
    })
}

export function isDateString(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
    )
}

export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function renderTemplate(
    template: string,
    data: Record<string, string>
): string {
    return template.replace(/\$\{(.*?)\}/g, (_, key) => data[key] ?? '')
}

export function markdownToHtml(markdown: string): string {
    const lines = markdown.split('\n')
    const html: string[] = []
    let tableRows: string[][] = []

    const flushTable = () => {
        if (!tableRows.length) return
        html.push('<table>')
        for (const row of tableRows) {
            if (row.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))) continue
            html.push(
                '<tr>' +
                    row
                        .map((cell) => `<td>${escapeHtml(cell.trim())}</td>`)
                        .join('') +
                    '</tr>'
            )
        }
        html.push('</table>')
        tableRows = []
    }

    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            tableRows.push(
                trimmed
                    .slice(1, -1)
                    .split('|')
                    .map((cell) => cell.trim())
            )
            continue
        }

        flushTable()

        if (!trimmed) continue
        if (trimmed.startsWith('### ')) {
            html.push(`<h3>${escapeHtml(trimmed.slice(4))}</h3>`)
        } else if (trimmed.startsWith('## ')) {
            html.push(`<h2>${escapeHtml(trimmed.slice(3))}</h2>`)
        } else if (trimmed.startsWith('# ')) {
            html.push(`<h1>${escapeHtml(trimmed.slice(2))}</h1>`)
        } else if (trimmed.startsWith('- ')) {
            html.push(`<p class="bullet">${escapeHtml(trimmed)}</p>`)
        } else {
            html.push(`<p>${escapeHtml(trimmed)}</p>`)
        }
    }

    flushTable()
    return html.join('\n')
}

export function formatList(items: string[] | undefined): string {
    const list = items?.filter(Boolean) ?? []
    if (!list.length) return '<div class="empty">暂无</div>'
    return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

export function formatTags(items: string[] | undefined): string {
    const list = items?.filter(Boolean) ?? []
    if (!list.length) return '<span class="washi-tape-tag c1">暂无标签</span>'
    const colors = ['c1', 'c2', 'c3', 'c4']
    return list
        .map((item, i) => `<span class="washi-tape-tag ${colors[i % colors.length]}">${escapeHtml(item)}</span>`)
        .join('')
}
