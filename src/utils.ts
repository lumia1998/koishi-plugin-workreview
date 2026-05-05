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

