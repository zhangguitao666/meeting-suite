/**
 * Bridge from meeting action items to the task-calendar plugin.
 *
 * The calendar plugin owns task persistence and exposes its own loopback JSON
 * API under `/dsh-task-calendar`. This plugin deliberately calls that public
 * surface instead of importing the calendar package: the two plugins stay
 * independently installable, and the calendar panel refreshes immediately
 * because the task is written exactly where the panel reads it.
 *
 * @module dsh-plugin-meeting-minutes/calendar
 */

/** Route prefix owned by the task-calendar plugin. */
export const CALENDAR_ROUTE = '/dsh-task-calendar'

/**
 * Resolve the loopback base URL of the Harness web server.
 *
 * The host service exposes the OS-assigned listening port as a `port` getter;
 * `getOrigin()` only exists on some builds, so prefer the port and keep the
 * origin as a secondary source. The hard-coded 50505 is a last resort for
 * tests/older hosts and must never win over a real listening port — otherwise
 * every calendar call fails with `fetch failed` on a random-port host.
 */
export function loopbackBase(ctx) {
  const webServer = ctx?.webServer
  const port = Number(webServer?.port)
  if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}`
  let origin = ''
  try {
    origin = webServer?.getOrigin?.() ?? ''
  } catch {
    origin = ''
  }
  if (origin === '') return 'http://127.0.0.1:50505'
  try {
    const url = new URL(origin)
    const originPort = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
    return `http://127.0.0.1:${originPort}`
  } catch {
    return 'http://127.0.0.1:50505'
  }
}

/** One task payload for the calendar plugin's create route. */
export function taskFromTodo(meeting, todo) {
  const task = {
    title: todo.title,
    priority: todo.priority,
    tags: ['会议纪要'],
    notes: todo.notes === '' ? '' : todo.notes,
    owner: todo.owner,
    source: {
      kind: 'minutes',
      title: meeting.title,
      date: meeting.date,
      ref: meeting.id,
    },
  }
  if (todo.due !== '') task.due = todo.due
  return task
}

/**
 * Create the calendar bridge.
 * @param options - `ctx` (host context), `logger`, `timeoutMs`.
 */
export function createCalendar(options) {
  const ctx = options.ctx
  const logger = options.logger
  const timeoutMs = options.timeoutMs ?? 2500
  let cached = null
  let cachedAt = 0

  const base = () => `${loopbackBase(ctx)}${CALENDAR_ROUTE}`

  /** Probe the calendar plugin's health route (cached for 8 seconds). */
  async function status(force = false) {
    const now = Date.now()
    if (!force && cached !== null && now - cachedAt < 8_000) return cached
    try {
      const response = await fetch(`${base()}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        cached = { available: false, route: CALENDAR_ROUTE, error: `任务日历接口异常（HTTP ${response.status}）` }
      } else {
        cached = { available: true, route: CALENDAR_ROUTE, error: null }
      }
    } catch (error) {
      cached = {
        available: false,
        route: CALENDAR_ROUTE,
        error: `未检测到任务日历插件：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    cachedAt = now
    return cached
  }

  /**
   * Write selected todos into the task calendar.
   * @param meeting - canonical meeting.
   * @param todoIds - ids to push; omitted/empty pushes every pending todo.
   * @returns `{ created: [{todoId, calendarTaskId, title}] }`; a partial failure
   * throws an error carrying `created` and `failed`.
   */
  async function pushTodos(meeting, todoIds) {
    const summary = meeting.summary
    if (summary === null) throw new Error('这场会议还没有生成纪要，先生成纪要再写入任务日历。')
    const wanted = Array.isArray(todoIds) && todoIds.length > 0 ? new Set(todoIds) : null
    const targets = summary.todos.filter((todo) => (wanted === null ? todo.calendarTaskId === null : wanted.has(todo.id)))
    if (targets.length === 0) throw new Error('没有需要写入的待办：勾选至少一条未写入的待办。')
    const probe = await status(true)
    if (!probe.available) {
      throw new Error('任务日历插件不可用：请先在插件管理中安装/启用「任务日历」，再回来写入待办。')
    }

    const created = []
    const failed = []
    for (const todo of targets) {
      try {
        const response = await fetch(`${base()}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ task: taskFromTodo(meeting, todo) }),
          signal: AbortSignal.timeout(timeoutMs * 2),
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true || typeof payload?.task?.id !== 'string') {
          throw new Error(payload?.error ?? `任务日历接口出错（HTTP ${response.status}）`)
        }
        created.push({ todoId: todo.id, calendarTaskId: payload.task.id, title: todo.title })
      } catch (error) {
        failed.push({ todoId: todo.id, title: todo.title, error: error instanceof Error ? error.message : String(error) })
        logger?.warn?.(`meeting-minutes: pushing todo ${todo.id} failed: ${String(error)}`)
      }
    }
    if (failed.length > 0) {
      const error = new Error(
        `写入任务日历部分失败：成功 ${created.length} 条，失败 ${failed.length} 条（${failed.map((entry) => entry.title).join('、')}）。`,
      )
      error.created = created
      error.failed = failed
      throw error
    }
    return { created }
  }

  return { status, pushTodos }
}
