/**
 * Snapshot JSON 化。
 * pipeline 的内部状态同时用了 Map / Set：
 *   deletions / marksByLine / inlineMatches 是 Map，disabled 是 Set。
 * JSON.stringify 会静默把它们变成 {}，所以工程文件必须显式转成数组，
 * 加载时再恢复成 Map / Set，否则 rerender 会报 deletions.get is not a function。
 */

export function serializeSnapshot(snapshot) {
  if (!snapshot) return null;
  const state = snapshot.state || {};
  const mapEntries = (value) => (value instanceof Map ? [...value.entries()] : []);
  return {
    ...snapshot,
    state: {
      ...state,
      deletions: mapEntries(state.deletions),
      marksByLine: mapEntries(state.marksByLine).map(([key, value]) => [String(key), value]),
      inlineMatches: mapEntries(state.inlineMatches),
      disabled: state.disabled instanceof Set ? [...state.disabled] : [],
    },
  };
}

export function reviveSnapshot(data) {
  if (!data) return null;
  const state = data.state || {};
  return {
    ...data,
    state: {
      ...state,
      deletions: new Map(Array.isArray(state.deletions) ? state.deletions : []),
      marksByLine: new Map(
        (Array.isArray(state.marksByLine) ? state.marksByLine : []).map(([key, value]) => [Number(key), value]),
      ),
      inlineMatches: new Map(Array.isArray(state.inlineMatches) ? state.inlineMatches : []),
      disabled: new Set(Array.isArray(state.disabled) ? state.disabled : []),
    },
  };
}
