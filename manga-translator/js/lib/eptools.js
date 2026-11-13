// eptools.js — управление execution providers ORT (WebGPU → WASM).
// Некоторые ONNX-модели (например, MaxPool с ceil_mode=1 в детекторе) падают
// в webgpu executor с «...not yet implemented in the webgpu executor» — такие
// ошибки роняли каждую картинку. Логика: пока WebGPU считаем рабочим; при
// kernel-ошибке WebGPU один раз пересоздаём все сессии на WASM и повторяем
// прогон, после чего навсегда работаем на CPU (до пересоздания offscreen-документа).
// Вынесено без зависимостей от chrome/DOM — покрывается unit-тестами в Node.

/**
 * Является ли ошибка ошибкой исполнения WebGPU-ядра (или потерей GPU),
 * при которой имеет смысл повторить прогон на WASM.
 * Ошибки типа «Модель не скачана» сюда НЕ попадают — ретрай их бессмыслен.
 */
export function isWebGPURunError(e) {
  const s = String(e?.message || e);
  return /ceil_mode|not yet implemented in the webgpu|webgpu executor|device (lost|removed)|out of memory/i.test(s);
}

/**
 * Трекер состояния EP: «webgpu считаем рабочим, пока не доказано обратное».
 */
export class EpFallback {
  constructor() {
    this.broken = false; // однажды сломавшийся WebGPU больше не пробуем
  }

  /** Список EP для createSession с учётом доступности адаптера. */
  providers(adapterAvailable) {
    if (!adapterAvailable || this.broken) return ['wasm'];
    return ['webgpu', 'wasm'];
  }

  /** Нужен ли повторный прогон на CPU: первый раз упали на WebGPU с kernel-ошибкой. */
  shouldRetryOnCpu(err, webgpuWasUsed) {
    return webgpuWasUsed && !this.broken && isWebGPURunError(err);
  }

  markBroken() {
    this.broken = true;
  }
}
