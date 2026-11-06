export interface PointerDragState<TContext> {
  /** pointerdown 时的 clientX。 */
  startX: number
  /** pointerdown 时的 clientY。 */
  startY: number
  /** onStart 返回的拖动上下文（例如初始宽度）。 */
  context: TContext
}

export interface PointerDragOptions<TContext> {
  /** 拖动开始时收集上下文；省略时 context 为 undefined。 */
  onStart?: (event: PointerEvent) => TContext
  onMove: (event: PointerEvent, state: PointerDragState<TContext>) => void
  onEnd?: (event: PointerEvent, state: PointerDragState<TContext>) => void
}

const DRAGGING_BODY_CLASS = 'is-pointer-dragging'

/**
 * 提供带指针捕获的拖动能力，供分割线类控件复用：
 * - 拖动期间 body 挂上 is-pointer-dragging，统一显示列调整光标并禁用文本选择；
 * - 指针始终被捕获在目标元素上，移出元素甚至移出窗口仍然持续触发 onMove；
 * - pointercancel（如触摸滚动打断）按拖动结束处理。
 *
 * 返回值直接绑定到元素的 @pointerdown 即可。
 */
export function usePointerDrag<TContext = undefined>(
  options: PointerDragOptions<TContext>,
): (event: PointerEvent) => void {
  let dragging = false

  return function onPointerdown(event: PointerEvent): void {
    if (dragging || event.button !== 0) return
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    const context = options.onStart?.(event)
    const state: PointerDragState<TContext> = {
      startX: event.clientX,
      startY: event.clientY,
      context: context as TContext,
    }

    dragging = true
    // 指针捕获失败（如测试环境合成事件）不阻断拖动：事件仍会派发到目标元素。
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // 忽略：无活动指针时 setPointerCapture 会抛 NotFoundError。
    }
    document.body.classList.add(DRAGGING_BODY_CLASS)

    const handleMove = (moveEvent: PointerEvent): void => {
      options.onMove(moveEvent, state)
    }
    const handleEnd = (endEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      document.body.classList.remove(DRAGGING_BODY_CLASS)
      dragging = false
      options.onEnd?.(endEvent, state)
    }

    // 监听挂在 window 上：指针捕获时事件仍会冒泡到 window；目标元素若在拖动中
    // 被卸载（如列表重建），window 上的 pointerup 仍能触发，避免 body 类泄漏。
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }
}
