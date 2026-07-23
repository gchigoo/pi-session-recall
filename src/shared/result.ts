/**
 * 轻量 Result 类型，供 core 与 adapter 共享。
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * 构造成功结果。
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * 构造失败结果。
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
