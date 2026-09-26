// 录音链路耗时观测（延迟诊断用）：各段打点汇总到最近一次快照，账户抽屉
// 里展示。目的：用户在手机上看不到 console，直连失败静默回退中转通道这类
// 问题（表现"变慢"）需要一处肉眼可见的数据来定位。
export function createRecordingTimingStore() {
  let last = null;

  return {
    /** 合并式记录：note({ encodeMs: 120 }) 只更新给出的字段并盖时间戳。 */
    note(partial) {
      if (!partial || typeof partial !== "object") return;
      last = { ...(last || {}), ...partial, at: Date.now() };
    },

    /** 最近一次快照；从未记录返回 null。 */
    get() {
      return last;
    },

    /** 新录音开始时清空上一条链路，避免 LAN/Cloud 分段数据串场。 */
    reset() {
      last = null;
    }
  };
}
